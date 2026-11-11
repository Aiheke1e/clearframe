const { extractUrl, fetchText, okResult } = require("../utils");

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function collectAtlasImages(html) {
  const cdnMatch = html.match(/"cdnList"\s*:\s*\[\s*\{\s*"cdn"\s*:\s*"([^"]+)"/);
  const cdn = cdnMatch ? cdnMatch[1] : "p2.a.yximgs.com";
  const paths = unique(
    [...html.matchAll(/"(\/ufile\/atlas\/[^"\\]+?\.(?:jpe?g|webp|png))"/gi)].map((m) => m[1])
  );
  const jpgs = paths.filter((path) => /\.jpe?g$/i.test(path));
  return (jpgs.length ? jpgs : paths).map((path) => `https://${cdn}${path}`);
}

function collectVideos(html) {
  return unique(
    [...html.matchAll(/"(https?:[^"\\]+?\.mp4[^"\\]*)"/gi)].map((m) =>
      m[1].replace(/\\u002F/g, "/")
    )
  ).filter((url) => !/\/ufile\/atlas\//i.test(url));
}

async function parseKuaishou(input) {
  const startUrl = extractUrl(input);
  if (!startUrl) throw new Error("未识别到快手链接");

  const page = await fetchText(startUrl, {
    headers: {
      referer: "https://www.kuaishou.com/",
    },
  });

  const images = collectAtlasImages(page.text);
  const videos = images.length ? [] : collectVideos(page.text);

  const titleMatch =
    page.text.match(/"caption"\s*:\s*"((?:\\.|[^"\\])*)"/i) ||
    page.text.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
  const authorMatch = page.text.match(/"(?:userName|user_name)"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  function decodeText(value) {
    try { return JSON.parse(`"${value}"`); } catch { return value || ""; }
  }

  const items = [];
  if (videos[0]) {
    items.push({
      type: "video",
      url: videos[0],
      cover: images[0] || "",
      quality: "hd",
    });
  }
  for (const url of images) {
    items.push({ type: "image", url, quality: "orig" });
  }

  if (!items.length) {
    throw new Error("快手解析失败，可能是私密作品或页面结构变更");
  }

  return okResult({
    platform: "kuaishou",
    title: titleMatch ? decodeText(titleMatch[1]) : "",
    author: authorMatch ? decodeText(authorMatch[1]) : "",
    items,
  });
}

module.exports = { parseKuaishou };
