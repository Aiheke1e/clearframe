const { extractUrl, fetchText, okResult } = require("../utils");
const { safeFetch } = require("../network");

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

let cachedTtwid = "";

function httpUrl(url) {
  return String(url || "").replace(/^https:/i, "http:");
}

function networkError(err) {
  const reason = err?.cause?.code || err?.cause?.message || err?.message || "fetch failed";
  return new Error(`网络请求失败（${reason}）`);
}

async function registerTtwid() {
  let res;
  try {
    res = await safeFetch("https://ttwid.bytedance.com/ttwid/union/register/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": MOBILE_UA,
      },
      body: JSON.stringify({
        region: "cn",
        aid: 1768,
        needFid: false,
        service: "www.iesdouyin.com",
        migrate_info: { ticket: "", source: "node" },
        cbUrlProtocol: "https",
        union: true,
      }),
    });
  } catch (err) {
    throw networkError(err);
  }
  const cookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const raw = cookies.find((item) => item.includes("ttwid=")) || "";
  const matched = raw.match(/ttwid=([^;]+)/);
  await res.body?.cancel();
  if (!res.ok || !matched) throw new Error("抖音会话初始化失败");
  cachedTtwid = decodeURIComponent(matched[1]);
  return cachedTtwid;
}

async function getTtwid(refresh) {
  if (cachedTtwid && !refresh) return cachedTtwid;
  return registerTtwid();
}

async function resolveDouyinEntry(startUrl) {
  const requestUrl = /\/\/v\.douyin\.com\//i.test(startUrl) ? httpUrl(startUrl) : startUrl;
  const res = await safeFetch(requestUrl, {
    redirect: "manual",
    headers: { "user-agent": MOBILE_UA, referer: "https://www.douyin.com/" },
  });
  await res.body?.cancel();
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    return new URL(location, requestUrl).href;
  }
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return requestUrl;
}

async function resolveMediaUrl(rawUrl) {
  let url = String(rawUrl || "")
    .replace(/playwm/gi, "play")
    .replace(/\/watermark\//gi, "/");
  if (!url) return "";

  if (/snssdk\.com/i.test(url)) {
    const res = await safeFetch(httpUrl(url), {
      redirect: "manual",
      headers: { "user-agent": MOBILE_UA, referer: "https://www.iesdouyin.com/" },
    });
    await res.body?.cancel();
    const location = res.headers.get("location");
    if (location) url = new URL(location, url).href;
  }


  return url;
}

function listUrls(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(listUrls);
  return [
    ...(Array.isArray(value.url_list) ? value.url_list : []),
    ...(value.url ? [value.url] : []),
    ...(Array.isArray(value.download_url_list) ? value.download_url_list : []),
    ...listUrls(value.play_addr),
  ];
}

function preferCleanUrl(urls, kind) {
  const list = [
    ...new Set(
      urls
        .map((url) => String(url || "").replace(/\\u002F/g, "/"))
        .filter((url) => /^https?:\/\//i.test(url))
    ),
  ];
  const clean = list.filter((url) => !/playwm|watermark|-water/i.test(url));
  const pool = clean.length ? clean : list;
  if (kind === "image") {
    return (
      pool.find((url) => /\.jpe?g(\?|$)/i.test(url)) ||
      pool.find((url) => /\.webp(\?|$)/i.test(url)) ||
      pool[0] ||
      ""
    );
  }
  return pool.find((url) => /\.mp4(\?|$)/i.test(url)) || pool[0] || "";
}

function isPlayableVideo(url) {
  const text = String(url || "");
  if (!text || /\.mp3(\?|$)/i.test(text) || /video_id=https?:/i.test(text)) return false;
  return !/mime_type=audio/i.test(text);
}

function pickLargestUrl(candidates = []) {
  const list = candidates
    .map((c) => {
      if (!c) return null;
      if (typeof c === "string") return { url: c, width: 0, height: 0 };
      const url = c.url_list?.[0] || c.url || c.download_url || "";
      if (!url) return null;
      return {
        url,
        width: Number(c.width || 0),
        height: Number(c.height || 0),
      };
    })
    .filter(Boolean);

  if (!list.length) return "";
  list.sort((a, b) => b.width * b.height - a.width * a.height);
  return list[0].url;
}

function extractAwemeId(url) {
  const patterns = [
    /\/share\/(?:video|slides|note|image)\/(\d+)/i,
    /\/(?:video|note|slides)\/(\d+)/i,
    /aweme_id=(\d+)/i,
    /modal_id=(\d+)/i,
    /item_id=(\d+)/i,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return "";
}

function parseRenderData(html) {
  const patterns = [
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/,
    /id="RENDER_DATA"\s+type="application\/json">([^<]+)</,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try {
      const raw = m[1].trim();
      const jsonText = raw.startsWith("%") || raw.includes("%7B")
        ? decodeURIComponent(raw)
        : raw;
      return JSON.parse(jsonText);
    } catch {
      /* try next */
    }
  }
  return null;
}

function findAwemeDetail(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return null;
  if (node.aweme_detail && typeof node.aweme_detail === "object") {
    return node.aweme_detail;
  }
  if (node.aweme && node.aweme.video) return node.aweme;
  if ((node.aweme_id || node.item_id) && (node.video || node.images || node.image_list)) {
    return node;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findAwemeDetail(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const value of Object.values(node)) {
    const hit = findAwemeDetail(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function loadDetail(awemeId, refresh) {
  const ttwid = await getTtwid(refresh);
  const share = await fetchText(`https://www.iesdouyin.com/share/video/${awemeId}/`, {
    headers: {
      referer: "https://www.iesdouyin.com/",
      cookie: `ttwid=${ttwid}`,
    },
  });
  return findAwemeDetail(parseRenderData(share.text));
}

async function parseDouyin(input) {
  const startUrl = extractUrl(input);
  if (!startUrl) throw new Error("未识别到抖音链接");

  function rejectLive(url) {
    const target = new URL(url);
    if (target.hostname === "live.douyin.com" || target.pathname.includes("/webcast/")) {
      throw Object.assign(new Error("暂不支持直播链接，请分享已发布的短视频或图集"), { statusCode: 400 });
    }
  }
  rejectLive(startUrl);

  let awemeId = extractAwemeId(startUrl);
  if (!awemeId) {
    const landed = await resolveDouyinEntry(startUrl);
    rejectLive(landed);
    awemeId = extractAwemeId(landed);
  }
  if (!awemeId) throw new Error("未识别到抖音作品编号");

  let detail = await loadDetail(awemeId, false);
  if (!detail) detail = await loadDetail(awemeId, true);

  if (!detail) {
    throw new Error("抖音解析失败，分享页没有返回作品数据");
  }

  const video = detail.video || {};
  const noWatermark = preferCleanUrl(
    [
      ...listUrls(video.play_addr),
      ...listUrls(video.download_addr),
      ...listUrls(video.bit_rate),
    ],
    "video"
  );

  const resolvedVideo = await resolveMediaUrl(noWatermark);
  const videoUrl = isPlayableVideo(resolvedVideo) ? resolvedVideo : "";

  const cover = await resolveMediaUrl(
    pickLargestUrl(video.cover ? [video.cover] : []) ||
      pickLargestUrl(video.origin_cover ? [video.origin_cover] : []) ||
      pickLargestUrl(video.dynamic_cover ? [video.dynamic_cover] : []) ||
      ""
  );

  const images = [];
  const seenImages = new Set();
  const imageList = detail.images || detail.image_list || [];
  for (const img of imageList) {
    const picked = preferCleanUrl(
      [...listUrls(img.url_list), ...listUrls(img.download_url_list), ...listUrls(img)],
      "image"
    );
    if (!picked) continue;
    const url = await resolveMediaUrl(picked);
    const key = (url.match(/\/([^/?]+)~tplv/i) || [url, url])[1];
    if (seenImages.has(key)) continue;
    seenImages.add(key);
    images.push(url);
  }

  const items = [];
  if (videoUrl) {
    items.push({
      type: "video",
      url: videoUrl,
      cover,
      quality: "no-watermark",
    });
  }
  for (const url of images) {
    items.push({ type: "image", url, quality: "orig" });
  }

  if (!items.length) {
    throw new Error("未找到抖音无水印媒体地址");
  }

  return okResult({
    platform: "douyin",
    title: detail.desc || detail.title || "",
    author:
      detail.author?.nickname ||
      detail.authorInfo?.nickname ||
      detail.author?.unique_id ||
      "",
    items,
  });
}

module.exports = { parseDouyin };
