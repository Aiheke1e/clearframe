const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function pageInstance(wx, api = {}) {
  let definition;
  const source = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/index/index.js"), "utf8");
  vm.runInNewContext(source, {
    Page: page => { definition = page; }, wx,
    require: id => id.endsWith("/api") ? api : { platformLabel: value => value },
  });
  return { ...definition, data: { ...definition.data }, setData(update) { Object.assign(this.data, update); } };
}

test("mini program submits domestic links as one batch and reads the shared counter without incrementing it", async () => {
  const calls = [];
  global.getApp = () => ({ globalData: { cnApiBase: "https://cn.test", overseasApiBase: "" } });
  global.wx = { request(options) {
    calls.push(options);
    options.success({ statusCode: 200, data: options.method === "GET" ? { count: 12 } : {
      ok: true, batch: true, total: 2, success: 1, failed: 1, usageCount: 12,
      items: [{ platform: "douyin", url: "https://p.douyinpic.com/image.jpg", sourceUrl: "https://v.douyin.com/good/" }],
      errors: [{ platform: "kuaishou", message: "解析失败" }],
    } });
  } };
  try {
    const api = require("../../miniprogram/utils/api");
    const data = await api.parseShareText("https://v.douyin.com/good/ https://v.kuaishou.com/failed/");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].data.text.split("\n").length, 2);
    assert.equal(data.failed, 1);
    assert.equal(data.usageCount, 12);
    assert.ok(data.items[0].url.startsWith("https://cn.test/api/media?"));
    assert.equal(await api.getUsageCount(), 12);
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].url, "https://cn.test/api/usage");
  } finally { delete global.wx; delete global.getApp; }
});

test("selection and select-all stay consistent; bulk save only handles selected media and continues after a failure", async () => {
  const page = pageInstance({ showToast() {} });
  page.data.result = { items: [
    { type: "image", url: "image", selected: false },
    { type: "video", url: "video", selected: false },
    { type: "image", url: "broken", selected: false },
    { type: "image", url: "unselected", selected: false },
  ] };
  page.onSelectAll();
  assert.equal(page.data.selectedCount, 4);
  assert.equal(page.data.allSelected, true);
  page.onToggleItem({ currentTarget: { dataset: { index: 3 } } });
  assert.equal(page.data.selectedCount, 3);
  assert.equal(page.data.allSelected, false);
  const downloads = [], saved = [];
  page.ensurePrivacyAuth = async () => {};
  page.ensureAlbumAuth = async () => {};
  page.downloadFile = async url => { downloads.push(url); if (url === "broken") throw new Error("interrupted"); return url; };
  page.saveImage = async file => saved.push(file);
  page.saveVideo = async file => saved.push(file);
  await page.onSaveSelected();
  assert.deepEqual(downloads, ["image", "video", "broken"]);
  assert.deepEqual(saved, ["image", "video"]);
  assert.match(page.data.statusText, /已保存 2 个媒体，1 个保存失败/);
  assert.equal(page.data.savingBatch, false);
});

test("bulk save respects privacy refusal and keeps the current selection", async () => {
  let album = 0, downloads = 0;
  const page = pageInstance({
    requirePrivacyAuthorize: ({ fail }) => fail(), showToast() {},
    getSetting: () => { album++; },
  });
  page.data.result = { items: [{ type: "image", url: "image", selected: true }] };
  page.data.selectedCount = 1;
  page.downloadFile = async () => { downloads++; };
  await page.onSaveSelected();
  assert.equal(album, 0);
  assert.equal(downloads, 0);
  assert.equal(page.data.selectedCount, 1);
  assert.equal(page.data.savingBatch, false);
});
