const { test } = require("node:test");
const assert = require("node:assert/strict");
const proxy = require("../src/proxyFetch");
let tweet;
proxy.proxyFetch = async () => ({ status: 200, text: async () => JSON.stringify({ tweet }) });
const { parseX } = require("../src/parsers/x");

test("X retains separate clips and chooses the best encoding of each", async () => {
  const first = "https://video.twimg.com/ext_tw_video/111/vid/avc1/";
  const second = "https://video.twimg.com/ext_tw_video/222/vid/avc1/";
  tweet = {
    author: { avatar: { url: "https://pbs.twimg.com/profile_images/avatar.jpg" } },
    media: { videos: [
      { url: first + "320x180/low.mp4", variants: [{ url: first + "1280x720/high.mp4", content_type: "video/mp4" }] },
      { url: second + "720x1280/second.mp4" },
    ], photos: [{ url: "https://pbs.twimg.com/media/photo.jpg?name=small" }] },
  };
  const data = await parseX("https://x.com/test/status/1234567890123456789");
  assert.deepEqual(data.items.filter(item => item.type === "video").map(item => item.url), [first + "1280x720/high.mp4", second + "720x1280/second.mp4"]);
  assert.deepEqual(data.items.filter(item => item.type === "image").map(item => item.url), ["https://pbs.twimg.com/media/photo.jpg?name=orig"]);
});

test("mini-program routes each link and preserves partial failures", async () => {
  global.getApp = () => ({ globalData: { cnApiBase: "https://cn.test", overseasApiBase: "https://overseas.test" } });
  const calls = [];
  let active = 0, maxActive = 0;
  global.wx = { request(options) {
    calls.push(options);
    maxActive = Math.max(maxActive, ++active);
    setTimeout(() => {
      active--;
      if (options.data.platform === "kuaishou") return options.success({ statusCode: 502, data: { message: "模拟失败" } });
      options.success({ statusCode: 200, data: { ok: true, platform: options.data.platform, title: "标题", items: [{ type: "video", url: "https://video.twimg.com/test.mp4" }] } });
    }, 5);
  } };
  try {
    const { parseShareText } = require("../../miniprogram/utils/api");
    const data = await parseShareText("https://x.com/u/status/1 https://v.douyin.com/2 https://v.kuaishou.com/3 https://x.com/u/status/4 https://x.com/u/status/1");
    assert.equal(calls.length, 4);
    assert.equal(maxActive, 3);
    assert.equal(data.total, 4);
    assert.equal(data.success, 3);
    assert.equal(data.failed, 1);
    assert.equal(data.errors[0].platform, "kuaishou");
    assert.equal(calls[0].url, "https://overseas.test/api/parse");
    assert.equal(calls[1].url, "https://cn.test/api/parse");
    assert.ok(data.items[0].url.startsWith("https://overseas.test/api/media?"));
    assert.ok(data.items[1].url.startsWith("https://cn.test/api/media?"));
    assert.equal(calls[0].data.text, undefined);
  } finally { delete global.wx; delete global.getApp; }
});

test("privacy refusal prevents clipboard access and album writes", async () => {
  let page, clipboardCalls = 0, albumCalls = 0;
  global.Page = definition => { page = definition; };
  global.wx = {
    requirePrivacyAuthorize: ({ fail }) => fail({ errMsg: "privacy denied" }),
    getClipboardData: () => { clipboardCalls++; },
    getSetting: () => { albumCalls++; },
    showToast: () => {},
  };
  try {
    require("../../miniprogram/pages/index/index");
    const instance = { ...page, data: { ...page.data }, setData(update) { Object.assign(this.data, update); } };
    await instance.onPasteAndParse();
    assert.equal(clipboardCalls, 0);
    assert.equal(instance.data.loading, false);
    assert.match(instance.data.statusText, /隐私/);
    instance.data.result = { items: [{ url: "https://cn.test/api/media?url=test", type: "video" }] };
    await instance.onSave({ currentTarget: { dataset: { index: 0 } } });
    assert.equal(albumCalls, 0);
    assert.equal(instance.data.savingIndex, -1);
  } finally { delete global.Page; delete global.wx; }
});
