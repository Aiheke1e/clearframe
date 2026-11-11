const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createUsageCounter } = require("../src/usageCounter");

async function counterFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clearframe-usage-test-"));
  const file = path.join(directory, "usage.json");
  t.after(async () => {
    await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    await fs.rmdir(directory);
  });
  return file;
}

test("concurrent successful calls persist without lost counts and survive reopening", async t => {
  const file = await counterFile(t);
  const counter = createUsageCounter(file);
  assert.equal(await counter.get(), 0);
  const values = await Promise.all(Array.from({ length: 25 }, () => counter.increment()));
  assert.deepEqual(values, Array.from({ length: 25 }, (_, i) => i + 1));
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { count: 25 });
  assert.equal(await createUsageCounter(file).get(), 25);
});

test("corrupt JSON is preserved instead of silently resetting the count", async t => {
  const file = await counterFile(t);
  await fs.writeFile(file, "corrupt");
  const counter = createUsageCounter(file);
  await assert.rejects(counter.increment());
  assert.equal(await fs.readFile(file, "utf8"), "corrupt");
  await fs.writeFile(file, '{"count":7}');
  assert.equal(await counter.increment(), 8);
});

test("API counts successful requests once, including partial batches; reads and failures do not count", async t => {
  const file = await counterFile(t);
  const originalFile = process.env.CLEARFRAME_USAGE_FILE;
  process.env.CLEARFRAME_USAGE_FILE = file;
  const parser = require("../src/parsers/douyin");
  const originalParser = parser.parseDouyin;
  parser.parseDouyin = async url => {
    if (url.includes("failed")) throw new Error("解析失败");
    return { ok: true, platform: "douyin", items: url.includes("empty") ? [] : [{ type: "image", url: "https://sample.douyinpic.com/image.jpg" }] };
  };
  delete require.cache[require.resolve("../src/index")];
  const app = require("../src/index");
  parser.parseDouyin = originalParser;
  if (originalFile === undefined) delete process.env.CLEARFRAME_USAGE_FILE;
  else process.env.CLEARFRAME_USAGE_FILE = originalFile;
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async () => (await (await fetch(base + "/api/usage")).json()).count;
  const parse = async text => {
    const response = await fetch(base + "/api/parse", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
    });
    return { status: response.status, data: await response.json() };
  };
  assert.equal(await read(), 0);
  assert.equal((await parse("https://v.douyin.com/good/")).data.usageCount, 1);
  const batch = await parse("\r\n分享文案\r\nhttps://v.douyin.com/good/\r\n\r\nhttps://v.douyin.com/failed/\r\nhttps://v.douyin.com/failed/");
  assert.equal(batch.data.success, 1);
  assert.equal(batch.data.failed, 1);
  assert.equal(batch.data.usageCount, 2);
  assert.deepEqual(batch.data.errors, [{
    url: "https://v.douyin.com/failed/", platform: "douyin", message: "解析失败",
    lineNumbers: [5, 6], linkIndex: 2,
  }]);
  const failedBatch = await parse("\nhttps://v.douyin.com/failed-a/ https://v.douyin.com/failed-b/\n\nhttps://v.douyin.com/failed-a/");
  assert.equal(failedBatch.status, 500);
  assert.equal(failedBatch.data.total, 2);
  assert.equal(failedBatch.data.success, 0);
  assert.equal(failedBatch.data.failed, 2);
  assert.deepEqual(failedBatch.data.items, []);
  assert.deepEqual(failedBatch.data.errors.map(({ url, lineNumbers, linkIndex }) => ({ url, lineNumbers, linkIndex })), [
    { url: "https://v.douyin.com/failed-a/", lineNumbers: [2, 4], linkIndex: 1 },
    { url: "https://v.douyin.com/failed-b/", lineNumbers: [2], linkIndex: 2 },
  ]);
  assert.equal((await parse("https://v.douyin.com/failed/")).status, 500);
  assert.equal((await parse("")).status, 400);
  await parse("https://v.douyin.com/empty/");
  await fetch(base + "/health");
  assert.equal(await read(), 2);
  assert.equal(await read(), 2);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { count: 2 });
});
