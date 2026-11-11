const { extractUrl, okResult } = require("../utils");
const { proxyFetch } = require("../proxyFetch");

function pickBestMp4(urls) {
  const list = [...new Set((urls || []).filter(url => /\.mp4(?:\?|$)/i.test(url)))];
  if (!list.length) return null;

  const scored = list.map((url) => {
    let score = 0;
    const dim = url.match(/\/(\d+)x(\d+)\//);
    if (dim) score += Number(dim[1]) * Number(dim[2]);
    const tag = url.match(/[?&]tag=(\d+)/);
    if (tag) score += Number(tag[1]);
    if (/\/amplify_video\//.test(url) || /\/ext_tw_video\//.test(url)) score += 50;
    if (/\.mp4(\?|$)/i.test(url)) score += 20;
    if (/\.m3u8/i.test(url)) score -= 1000;
    return { url, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > -500 ? scored[0].url : null;
}

function videoKey(url) {
  // Different encodings of one clip share its platform media ID.
  const match = url.match(/\/(ext_tw_video|amplify_video|tweet_video)\/([^/?]+)/i);
  return match ? `${match[1]}/${match[2]}` : url;
}

function bestVideos(urls) {
  const groups = new Map();
  for (const url of urls) {
    if (!/\.mp4(?:\?|$)/i.test(url)) continue;
    const key = videoKey(url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(url);
  }
  return [...groups.values()].map(pickBestMp4).filter(Boolean);
}

function walkMedia(node, bucket) {
  if (!node || typeof node !== "object") return;
  if (typeof node.url === "string") {
    if (/\.mp4/i.test(node.url)) bucket.videos.push(node.url);
    if (/^https?:\/\/pbs\.twimg\.com\/media\//i.test(node.url)) {
      bucket.images.push(node.url.replace(/name=\w+/i, "name=orig"));
    }
  }
  if (typeof node.video_url === "string") bucket.videos.push(node.video_url);
  if (typeof node.contentUrl === "string" && /\.mp4/i.test(node.contentUrl)) {
    bucket.videos.push(node.contentUrl);
  }
  if (Array.isArray(node.variants)) {
    for (const v of node.variants) {
      if (v?.url && (String(v.content_type || "").includes("mp4") || /\.mp4/i.test(v.url))) {
        bucket.videos.push(v.url);
      }
    }
  }
  if (Array.isArray(node.mediaURLs)) {
    for (const u of node.mediaURLs) {
      if (/\.mp4/i.test(u)) bucket.videos.push(u);
      else bucket.images.push(u);
    }
  }
  if (Array.isArray(node)) node.forEach((n) => walkMedia(n, bucket));
  else Object.values(node).forEach((n) => walkMedia(n, bucket));
}

function getTweetId(input) {
  const url = extractUrl(input) || String(input || "");
  const m = url.match(/\/status\/(\d+)/i) || url.match(/(\d{10,})/);
  return m ? m[1] : "";
}

function getScreenName(input) {
  const url = extractUrl(input) || String(input || "");
  const m = url.match(/(?:x|twitter)\.com\/([^/?#]+)\/status\//i);
  if (!m) return "";
  const name = decodeURIComponent(m[1]);
  if (/^(i|intent|share)$/i.test(name)) return "";
  return name;
}

function explainFromText(text) {
  const raw = String(text || "");
  if (/suspended account/i.test(raw) || /账号已被冻结|账号已被停用|Account suspended/i.test(raw)) {
    return "该 X 账号已被封禁，无法解析";
  }
  if (/Age[- ]restricted|年龄限制|Sensitive content/i.test(raw)) {
    return "该内容有年龄或敏感限制，无法解析";
  }
  if (/This Post was deleted|Post deleted|已被删除|Tweet deleted/i.test(raw)) {
    return "该帖子已被删除，无法解析";
  }
  if (/protected|protected account|私密账号|受保护/i.test(raw)) {
    return "该账号是私密账号，无法解析";
  }
  if (/TweetTombstone|unavailable|不再可用|这条帖子不可用/i.test(raw)) {
    return "该帖子当前不可用，无法解析";
  }
  return "";
}

async function fetchJsonSafe(url) {
  let res;
  try {
    res = await proxyFetch(url, {
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        accept: "application/json",
      },
    });
  } catch (err) {
    const reason = err?.cause?.code || err?.cause?.message || err?.message || "fetch failed";
    throw new Error(`网络请求失败（${reason}）`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, text, data };
}

async function inspectHtmlReason(tweetId, screenName) {
  const path = screenName
    ? `https://x.com/${encodeURIComponent(screenName)}/status/${tweetId}`
    : `https://x.com/i/status/${tweetId}`;
  try {
    const res = await proxyFetch(path, {
      headers: {
        accept: "text/html",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });
    const text = await res.text();
    return explainFromText(text);
  } catch {
    return "";
  }
}

async function parseX(input) {
  const tweetId = getTweetId(input);
  if (!tweetId) {
    throw new Error("无法识别 X 推文 ID");
  }
  const screenName = getScreenName(input);

  const bucket = { videos: [], images: [] };
  let title = "";
  let author = "";
  let unavailableReason = "";
  let networkError = null;

  try {
    const fx = await fetchJsonSafe(`https://api.fxtwitter.com/status/${tweetId}`);
    if (fx.status === 404 || fx.data?.code === 404 || /NOT_FOUND/i.test(fx.data?.message || "")) {
      unavailableReason = unavailableReason || "未找到该帖子，可能已删除或账号异常";
    } else if (fx.data) {
      const tweet = fx.data.tweet || fx.data;
      title = tweet?.text || tweet?.raw_text?.text || "";
      author = tweet?.author?.screen_name || tweet?.user_screen_name || "";
      walkMedia(tweet, bucket);
      unavailableReason =
        unavailableReason ||
        explainFromText(JSON.stringify(fx.data)) ||
        explainFromText(title);
    }
  } catch (err) {
    networkError = err;
  }

  if (!bucket.videos.length && !bucket.images.length) {
    try {
      const syn = await fetchJsonSafe(
        `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=1`
      );
      if (syn.data) {
        title = title || syn.data?.text || "";
        author = author || syn.data?.user?.screen_name || "";
        walkMedia(syn.data, bucket);
        unavailableReason =
          unavailableReason ||
          explainFromText(JSON.stringify(syn.data)) ||
          explainFromText(title);
      }
    } catch (err) {
      networkError = networkError || err;
    }
  }

  const items = [];
  for (const url of bestVideos(bucket.videos)) {
    items.push({ type: "video", url, quality: "best" });
  }
  const images = [...new Set(bucket.images)];
  for (const url of images) {
    items.push({ type: "image", url, quality: "orig" });
  }
  if (items.length) {
    return okResult({ platform: "x", title, author, items });
  }

  if (!unavailableReason || /未找到该帖子/.test(unavailableReason)) {
    const htmlReason = await inspectHtmlReason(tweetId, screenName);
    if (htmlReason) unavailableReason = htmlReason;
  }

  if (unavailableReason) {
    throw new Error(unavailableReason);
  }
  if (networkError) {
    throw networkError;
  }
  throw new Error("未找到可下载的 X 媒体（仅支持公开内容）");
}

module.exports = { parseX };
