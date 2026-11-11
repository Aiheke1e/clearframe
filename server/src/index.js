const net = require("net");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { safeFetch, validateUrl, MEDIA_DOMAINS, requestContext } = require("./network");
const express = require("express");

// Windows 上默认的地址竞速会让抖音/快手连接一直等到超时，表现为 fetch failed。
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}
const cors = require("cors");
const config = require("./config");
const { extractUrl, extractUrlEntries, detectPlatform } = require("./utils");
const { proxyFetch, getProxyAgent } = require("./proxyFetch");
const { shouldUseProxy } = require("./proxyRouting");
const { parseX } = require("./parsers/x");
const { parseDouyin } = require("./parsers/douyin");
const { parseKuaishou } = require("./parsers/kuaishou");
const { createUsageCounter } = require("./usageCounter");
const usage = createUsageCounter(process.env.CLEARFRAME_USAGE_FILE || path.join(__dirname, "../data/usage.json"));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/usage", async (_req, res) => {
  res.setHeader("cache-control", "no-store");
  try {
    res.json({ count: await usage.get() });
  } catch {
    res.status(503).json({ message: "调用次数暂不可用" });
  }
});

async function withUsage(data) {
  // 有媒体结果才算成功。批量请求整体只计一次。
  if (data?.ok === false || !data?.items?.some(item => item && item.url)) return data;
  try {
    return { ...data, usageCount: await usage.increment() };
  } catch (error) {
    console.error("[ClearFrame] usage counter:", error.message);
    return data;
  }
}
app.use("/api/parse", (_req, res, next) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  res.once("close", () => { clearTimeout(timer); controller.abort(); });
  requestContext.run({ signal: controller.signal }, next);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    region: config.REGION,
    enable: {
      douyin: config.enableDouyin,
      kuaishou: config.enableKuaishou,
      x: config.enableX,
    },
  });
});

function mediaReferer(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host.endsWith(".twimg.com")) return "https://x.com/";
  if (/\.(yximgs|kwimgs|kwaicdn)\.com$/.test(host)) return "https://www.kuaishou.com/";
  return "https://www.douyin.com/";
}

function downloadName(requested, contentType) {
  const raw = String(requested || "").replace(/[^\w.\-]+/g, "");
  if (raw && /\.(mp4|jpg|jpeg|png|webp)$/i.test(raw)) return raw;
  const type = String(contentType || "");
  if (type.includes("png")) return "clearframe.png";
  if (type.includes("webp")) return "clearframe.webp";
  if (type.includes("jpeg") || type.includes("jpg")) return "clearframe.jpg";
  return "clearframe.mp4";
}

async function fetchMedia(url, headers, signal) {
  const options = { headers, signal, timeout: 120000 };
  if (shouldUseProxy(url)) return proxyFetch(url, options, MEDIA_DOMAINS);
  return safeFetch(url, options, MEDIA_DOMAINS);
}

app.get("/api/media", async (req, res) => {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on("close", onClose);
  try {
    let target;
    try {
      target = validateUrl(String(req.query.url || ""), MEDIA_DOMAINS);
    } catch {
      res.status(400).json({ ok: false, message: "不支持的媒体地址" });
      return;
    }
    const upstream = await fetchMedia(target.href, {
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      referer: mediaReferer(target.hostname),
      accept: "*/*",
      ...(req.headers.range ? { range: req.headers.range } : {}),
    }, controller.signal);
    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel();
      res.status(upstream.status || 502).json({ ok: false, message: "媒体下载失败" });
      return;
    }
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    res.status(upstream.status);
    res.setHeader("content-type", contentType);
    const length = upstream.headers.get("content-length");
    if (length) res.setHeader("content-length", length);
    const range = upstream.headers.get("content-range");
    if (range) res.setHeader("content-range", range);
    res.setHeader("accept-ranges", upstream.headers.get("accept-ranges") || "bytes");
    if (req.query.download) {
      res.setHeader(
        "content-disposition",
        `attachment; filename="${downloadName(req.query.name, contentType)}"`
      );
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (!res.headersSent && !res.destroyed) {
      res.status(502).json({ ok: false, message: err?.message || "媒体请求失败" });
    } else if (!res.destroyed) {
      res.destroy(err);
    }
  } finally {
    res.off("close", onClose);
    controller.abort();
  }
});

async function parseOne(url, platformHint) {
  const platform = detectPlatform(url);
  if (platform === "unknown" || (platformHint && platformHint !== platform)) {
    throw new Error("不支持的分享地址或平台不匹配");
  }

  if (platform === "x") {
    if (!config.enableX) {
      throw new Error("当前节点未启用 X 解析，请走海外服务");
    }
    return parseX(url);
  }

  if (platform === "douyin") {
    if (!config.enableDouyin) {
      throw new Error("当前节点未启用抖音解析，请走国内服务");
    }
    return parseDouyin(url);
  }

  if (platform === "kuaishou") {
    if (!config.enableKuaishou) {
      throw new Error("当前节点未启用快手解析，请走国内服务");
    }
    return parseKuaishou(url);
  }

  throw new Error("暂仅支持抖音、快手、X（Twitter）");
}

async function mapLimit(list, limit, worker) {
  const results = new Array(list.length);
  let next = 0;
  async function run() {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await worker(list[index], index);
    }
  }
  const runners = Array.from({ length: Math.min(limit, list.length) }, () => run());
  await Promise.all(runners);
  return results;
}

app.post("/api/parse", async (req, res) => {
  try {
    const text = String(req.body?.text || req.body?.url || "");
    const entries = extractUrlEntries(text);
    const urls = entries.map(entry => entry.url);
    const sources = new Map(entries.map(entry => [entry.url, entry]));
    const failure = (url, err) => ({
      ...sources.get(url), url, platform: detectPlatform(url), message: err?.message || "解析失败",
    });
    const single = extractUrl(text) || String(req.body?.url || "");
    const targets = urls.length ? urls : single ? [single] : [];
    if (!targets.length) {
      res.status(400).json({ ok: false, message: "缺少分享链接" });
      return;
    }
    if (targets.length > 20) {
      res.status(400).json({ ok: false, message: "一次最多解析 20 条链接" });
      return;
    }
    if (targets.some(url => detectPlatform(url) === "unknown") ||
        (targets.length === 1 && req.body?.platform && req.body.platform !== detectPlatform(targets[0]))) {
      res.status(400).json({ ok: false, message: "不支持的分享地址或平台不匹配" });
      return;
    }

    if (targets.length === 1) {
      const url = targets[0];
      const platform = String(req.body?.platform || detectPlatform(url)).toLowerCase();
      try {
        const data = await parseOne(url, platform);
        res.json(await withUsage(data));
      } catch (err) {
        res.status(err?.statusCode === 400 ? 400 : 500).json({
          ok: false, message: err?.message || "解析失败", errors: [failure(url, err)],
        });
      }
      return;
    }

    const settled = await mapLimit(targets, 3, async (url) => {
      try {
        const data = await parseOne(url, detectPlatform(url));
        const items = (Array.isArray(data.items) ? data.items : [])
          .filter((item) => item && item.url)
          .map((item) => ({
            ...item,
            platform: data.platform || detectPlatform(url),
            sourceUrl: url,
            title: data.title || "",
            author: data.author || "",
          }));
        return { ok: true, url, platform: data.platform, items };
      } catch (err) {
        return {
          ok: false,
          ...failure(url, err),
          items: [],
        };
      }
    });

    const items = settled.flatMap((row) => row.items || []);
    const errors = settled
      .filter((row) => !row.ok)
      .map(({ items: _items, ok: _ok, ...error }) => error);

    if (!items.length) {
      res.status(500).json({
        ok: false,
        batch: true,
        total: targets.length,
        success: 0,
        failed: errors.length,
        items: [],
        message: errors[0]?.message || "批量解析失败",
        errors,
      });
      return;
    }

    res.json(await withUsage({
      ok: true,
      batch: true,
      total: targets.length,
      success: settled.filter((row) => row.ok).length,
      failed: errors.length,
      items,
      errors,
    }));
  } catch (err) {
    res.status(err?.statusCode === 400 ? 400 : 500).json({
      ok: false,
      message: err?.message || "解析失败",
    });
  }
});

if (require.main === module) {
  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(
      `[ClearFrame] region=${config.REGION} listening on http://127.0.0.1:${server.address().port}`
    );
    getProxyAgent(true).catch(err => console.error("[ClearFrame] proxy initialization:", err.message));
  });
}

module.exports = app;
