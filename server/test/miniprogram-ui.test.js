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

test("download progress comes from bytes, reaches the album-saving phase, and finishes after the save callback", async () => {
  let options, progress, album, removed;
  const page = pageInstance({
    downloadFile(value) { options = value; return { onProgressUpdate(fn) { progress = fn; }, offProgressUpdate(fn) { removed = fn; } }; },
    saveVideoToPhotosAlbum(value) { album = value; },
  });
  page.beginTransfer(1);
  const pending = page.saveTransfer({ type: "video", url: "video" }, 0);
  assert.equal(options.timeout, 600000);
  page._transferLastUpdate = 0;
  progress({ progress: 25, totalBytesWritten: 512, totalBytesExpectedToWrite: 2048 });
  assert.equal(page.data.downloadRows[0].percent, 25);
  assert.equal(page.data.downloadRows[0].known, true);
  assert.match(page.data.downloadRows[0].detail, /KB/);
  assert(page.data.downloadProgress > 0 && page.data.downloadProgress < 100);
  options.success({ statusCode: 200, tempFilePath: "downloaded.mp4" });
  await new Promise(setImmediate);
  assert.equal(page.data.downloadRows[0].phase, "saving");
  assert.equal(page.data.downloadProgress, 95);
  assert.equal(album.filePath, "downloaded.mp4");
  album.success({});
  await pending;
  assert.equal(page.data.downloadProgress, 100);
  assert.equal(page.data.downloadSummary, "已完成 1 / 1");
  assert.equal(page._downloadTasks.size, 0);
  assert.equal(removed, progress);
});

test("unknown-size downloads show bytes without a fabricated percentage and unloading aborts them", async () => {
  let options, progress, aborted = 0;
  const page = pageInstance({ downloadFile(value) {
    options = value;
    return { onProgressUpdate(fn) { progress = fn; }, abort() { aborted++; options.fail({ errMsg: "abort" }); } };
  } });
  page.beginTransfer(1);
  const pending = page.saveTransfer({ type: "image", url: "image" }, 0);
  page._transferLastUpdate = 0;
  progress({ totalBytesWritten: 4096, totalBytesExpectedToWrite: 0 });
  assert.equal(page.data.downloadRows[0].known, false);
  assert.equal(page.data.downloadRows[0].detail, "4 KB");
  page.onUnload();
  await assert.rejects(pending, /abort/);
  assert.equal(aborted, 1);
});

test("bulk downloads use two workers and keep successful album saves when a file fails", async () => {
  const page = pageInstance({ showToast() {} });
  page.data.result = { items: Array.from({ length: 4 }, (_, index) => ({ type: "image", url: String(index), selected: true })) };
  page.ensurePrivacyAuth = page.ensureAlbumAuth = async () => {};
  let active = 0, maxActive = 0;
  const saved = [];
  page.downloadFile = async url => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    if (url === "1") throw new Error("failed");
    return url;
  };
  page.saveImage = async file => saved.push(file);
  await page.onSaveSelected();
  assert.equal(maxActive, 2);
  assert.deepEqual(saved, ["0", "2", "3"]);
  assert.match(page.data.statusText, /已保存 3 个媒体，1 个保存失败/);
  assert.equal(page.data.downloadProgress, 100);
});

test("video preview is separate from selection and stops when closed or saving starts", async () => {
  let paused = 0;
  const page = pageInstance({ createVideoContext(id) { assert.equal(id, "media-preview"); return { pause() { paused++; } }; } });
  page.data.result = { items: [{ type: "video", url: "video", selected: false }] };
  page.onPreviewItem({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.previewItem.url, "video");
  assert.equal(page.data.result.items[0].selected, false);
  page.beginTransfer(1);
  assert.equal(page.data.previewItem, null);
  assert.equal(paused, 1);
  page.data.savingBatch = true;
  page.onPreviewItem({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.previewItem, null);
});
