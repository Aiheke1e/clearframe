const { safeFetch } = require("./network");
const net = require("net");

if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}

function cleanUrl(url) {
  return String(url || "").replace(/[),.;!?，。；！？]+$/g, "");
}

function extractUrl(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const match = raw.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return "";
  return cleanUrl(match[0]);
}

function detectPlatform(urlOrText) {
  try {
    const url = new URL(extractUrl(urlOrText) || String(urlOrText || ""));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return "unknown";
    const host = url.hostname.toLowerCase();
    const matches = (domains) => domains.some(domain => host === domain || host.endsWith("." + domain));
    if (matches(["x.com", "twitter.com", "t.co"])) return "x";
    if (matches(["douyin.com", "iesdouyin.com", "toutiao.com"])) return "douyin";
    if (matches(["kuaishou.com", "gifshow.com", "chenzhongtech.com"])) return "kuaishou";
  } catch { /* invalid URL */ }
  return "unknown";
}

function extractUrlEntries(text) {
  const raw = String(text || "");
  const entries = [];
  const seen = new Map();
  let line = 1, offset = 0;
  for (const match of raw.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    line += (raw.slice(offset, match.index).match(/\r\n|\r|\n/g) || []).length;
    offset = match.index + match[0].length;
    const url = cleanUrl(match[0]);
    if (detectPlatform(url) === "unknown") continue;
    const existing = seen.get(url);
    if (existing) {
      if (!existing.lineNumbers.includes(line)) existing.lineNumbers.push(line);
      continue;
    }
    const entry = { url, lineNumbers: [line], linkIndex: entries.length + 1 };
    seen.set(url, entry);
    entries.push(entry);
  }
  return entries;
}

function extractUrls(text) {
  return extractUrlEntries(text).map(entry => entry.url);
}

async function fetchText(url, options = {}) {
  let res;
  try {
    res = await safeFetch(url, {
      redirect: "follow",
      ...options,
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    const reason = err?.cause?.code || err?.cause?.message || err?.message || "fetch failed";
    throw new Error(`网络请求失败（${reason}）`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  return {
    url: res.url,
    text: await res.text(),
  };
}

async function fetchJson(url, options = {}) {
  let res;
  try {
    res = await safeFetch(url, {
      redirect: "follow",
      ...options,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        accept: "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    const reason = err?.cause?.code || err?.cause?.message || err?.message || "fetch failed";
    throw new Error(`网络请求失败（${reason}）`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

function okResult({ platform, title = "", author = "", items = [] }) {
  return {
    ok: true,
    platform,
    title,
    author,
    items: items.filter((i) => i && i.url),
  };
}

module.exports = {
  extractUrl,
  extractUrls,
  extractUrlEntries,
  detectPlatform,
  fetchText,
  fetchJson,
  okResult,
};
