const { extractUrl, extractUrls, detectPlatform } = require("./platform");

function getBases() {
  const app = getApp();
  return {
    cn: (app && app.globalData && app.globalData.cnApiBase) || "",
    overseas: (app && app.globalData && app.globalData.overseasApiBase) || "",
  };
}

function pickBase(platform) {
  const bases = getBases();
  if (platform === "x") return bases.overseas;
  return bases.cn;
}

function request({ url, method = "GET", data }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      data,
      timeout: 30000,
      header: {
        "content-type": "application/json",
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
          return;
        }
        const msg =
          (res.data && (res.data.message || res.data.error)) ||
          `请求失败(${res.statusCode})`;
        reject(new Error(msg));
      },
      fail(err) {
        const message = (err && err.errMsg) || "网络异常";
        if (/url not in domain list/i.test(message)) {
          // 仅在域名拦截时提供现场信息，不记录用户分享内容。
          let account = {};
          try {
            account = typeof wx.getAccountInfoSync === "function"
              ? (wx.getAccountInfoSync().miniProgram || {}) : {};
          } catch (_) {}
          reject(new Error([
            message,
            "连接排查版：20261111-1",
            `接口：${url.split("?")[0]}`,
            `AppID：${account.appId || "未获取"}`,
            `环境：${account.envVersion || "未获取"}`,
            `版本：${account.version || "未提供"}`,
          ].join("\n")));
          return;
        }
        reject(new Error(message));
      },
    });
  });
}

/**
 * 解析分享链接，返回统一媒体结构。
 * { platform, title, author, items: [{ type: 'video'|'image', url, cover, quality }] }
 */
async function parseUrl(url) {
  const platform = detectPlatform(url);
  if (platform === "unknown") {
    throw new Error("暂仅支持抖音、快手、X（Twitter）链接");
  }

  const base = pickBase(platform);
  if (!base || /example\.com/i.test(base)) {
    throw new Error(
      platform === "x" ? "X 服务准备中，请稍后再试" : "解析服务暂不可用，请稍后再试"
    );
  }

  const data = await request({
    url: `${base.replace(/\/$/, "")}/api/parse`,
    method: "POST",
    data: { url, platform },
  });

  if (!data || data.ok === false) {
    throw new Error((data && data.message) || "解析失败");
  }

  const items = (Array.isArray(data.items) ? data.items : []).filter(item => item && item.url);
  if (!items.length) throw new Error("未解析到可下载的图片或视频");
  const proxyUrl = (value) => value ? `${base.replace(/\/$/, "")}/api/media?url=${encodeURIComponent(value)}` : "";
  return { ...data, items: items.map(item => ({
    ...item,
    originalUrl: item.url,
    url: proxyUrl(item.url),
    cover: proxyUrl(item.cover),
    platform,
    sourceUrl: url,
    title: data.title || "",
    author: data.author || "",
  })) };
}

async function parseShareText(text) {
  const urls = extractUrls(text);
  if (!urls.length) throw new Error("未识别到有效链接，请粘贴抖音 / 快手 / X 分享链接");
  if (urls.length > 20) throw new Error("一次最多解析 20 条链接");
  if (urls.length === 1) return parseUrl(urls[0]);
  // 同一节点的多条链接交给后端统一批量解析，与网页一样整次计数 +1。
  const platforms = urls.map(detectPlatform);
  const base = pickBase(platforms[0]);
  if (base && !/example\.com/i.test(base) && platforms.every(platform => platform !== "unknown" && pickBase(platform) === base)) {
    const data = await request({
      url: `${base.replace(/\/$/, "")}/api/parse`, method: "POST", data: { text: urls.join("\n") },
    });
    const items = (Array.isArray(data && data.items) ? data.items : []).filter(item => item && item.url);
    if (!data || data.ok === false || !items.length) throw new Error((data && data.message) || "未解析到可下载的图片或视频");
    const proxyUrl = value => value ? `${base.replace(/\/$/, "")}/api/media?url=${encodeURIComponent(value)}` : "";
    return { ...data, items: items.map(item => ({
      ...item, originalUrl: item.url, url: proxyUrl(item.url), cover: proxyUrl(item.cover),
    })) };
  }
  const rows = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const index = next++;
      const url = urls[index];
      try {
        rows[index] = { data: await parseUrl(url) };
      } catch (err) {
        rows[index] = { error: { url, platform: detectPlatform(url), message: err.message || "解析失败" } };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker));
  const errors = rows.filter(row => row.error).map(row => row.error);
  const items = rows.reduce((all, row) => all.concat(row.data ? row.data.items : []), []);
  if (!items.length) throw new Error(errors.map(error => error.message).join("；"));
  return { ok: true, batch: true, total: urls.length, success: urls.length - errors.length, failed: errors.length, items, errors };
}

async function getUsageCount() {
  const base = getBases().cn;
  if (!base || /example\.com/i.test(base)) throw new Error("解析服务暂不可用");
  const data = await request({ url: `${base.replace(/\/$/, "")}/api/usage` });
  if (!data || !Number.isSafeInteger(data.count) || data.count < 0) throw new Error("调用次数暂不可用");
  return data.count;
}

module.exports = {
  parseShareText,
  getUsageCount,
  pickBase,
  extractUrl,
  detectPlatform,
};
