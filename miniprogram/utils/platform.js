/**
 * 从分享文案里提取链接，并识别平台。
 */
function extractUrl(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const match = raw.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return "";
  return match[0].replace(/[),.;!?，。；！？]+$/g, "");
}

function detectPlatform(urlOrText) {
  try {
    const match = (extractUrl(urlOrText) || String(urlOrText || "")).match(/^https?:\/\/([a-z0-9.-]+)(?:[/?#]|$)/i);
    if (!match) return "unknown";
    const host = match[1].toLowerCase();
    const matches = (domains) => domains.some(domain => host === domain || host.endsWith("." + domain));
    if (matches(["x.com", "twitter.com", "t.co"])) return "x";
    if (matches(["douyin.com", "iesdouyin.com", "toutiao.com"])) return "douyin";
    if (matches(["kuaishou.com", "gifshow.com", "chenzhongtech.com"])) return "kuaishou";
  } catch { /* invalid URL */ }
  return "unknown";
}

function platformLabel(platform) {
  const map = {
    x: "X",
    douyin: "抖音",
    kuaishou: "快手",
    unknown: "未知平台",
  };
  return map[platform] || "未知平台";
}

function extractUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  return [...new Set(matches.map(extractUrl).filter(url => detectPlatform(url) !== "unknown"))];
}

module.exports = {
  extractUrl,
  extractUrls,
  detectPlatform,
  platformLabel,
};
