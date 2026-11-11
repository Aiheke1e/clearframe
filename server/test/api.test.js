const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

test("API starts and rejects invalid targets before any upstream request", async () => {
  const fixture = `
    const network = require('./src/network');
    network.safeFetch = async (url, { signal, headers, timeout }) => {
      if (headers['accept-encoding'] !== 'identity' || timeout !== 600000) throw new Error('incorrect media transport options');
      if (headers.range === 'bytes=0-2') return new Response(new Uint8Array([7, 8, 9]), {
        status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '3', 'content-range': 'bytes 0-2/10', 'accept-ranges': 'bytes' }
      });
      return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        if (url.includes('broken')) setTimeout(() => controller.error(new Error('upstream broken')), 30);
        else signal.addEventListener('abort', () => {
          process.stdout.write('MEDIA_ABORTED\\n');
          controller.error(new Error('cancelled'));
        }, { once: true });
      }
    }), { headers: { 'content-type': 'video/mp4' } });
    };
    const server = require('./src/index').listen(0, '127.0.0.1', () => {
      console.log('listening on http://127.0.0.1:' + server.address().port);
    });
  `;
  const child = spawn(process.execPath, ["-e", fixture], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: "0", REGION: "all" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("startup timeout")), 5000);
      child.on("error", reject);
      child.on("exit", code => reject(new Error(`early exit ${code}`)));
      child.stdout.on("data", chunk => {
        const match = String(chunk).match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    assert.equal((await fetch(base + "/health").then(res => res.json())).ok, true);
    assert.equal((await fetch(base + "/")).status, 200);
    for (const body of [{}, { url: "http://127.0.0.1/?next=kuaishou.com" }, { url: "http://127.0.0.1/", platform: "kuaishou" }, { url: "https://x.com/u/status/123", platform: "kuaishou" }, { text: Array.from({ length: 21 }, (_, i) => `https://x.com/u/status/${i}`).join(" ") }]) {
      const res = await fetch(base + "/api/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    for (const url of ["", "file:///test", "http://127.0.0.1/test", "https://video.twimg.com@127.0.0.1/test"]) {
      assert.equal((await fetch(base + "/api/media?url=" + encodeURIComponent(url))).status, 400);
    }
    const range = await fetch(base + "/api/media?url=" + encodeURIComponent("https://v.douyinvod.com/video.mp4"), { headers: { Range: "bytes=0-2" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-length"), "3");
    assert.equal(range.headers.get("content-range"), "bytes 0-2/10");
    assert.equal(range.headers.get("x-accel-buffering"), "no");
    assert.deepEqual(new Uint8Array(await range.arrayBuffer()), new Uint8Array([7, 8, 9]));
    const broken = await fetch(base + "/api/media?url=" + encodeURIComponent("https://v.douyinvod.com/broken.mp4"));
    await assert.rejects(broken.arrayBuffer());
    assert.equal((await fetch(base + "/health")).status, 200);
    const aborted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("upstream not aborted")), 2000);
      child.stdout.on("data", chunk => { if (String(chunk).includes("MEDIA_ABORTED")) { clearTimeout(timer); resolve(); } });
    });
    const slow = await fetch(base + "/api/media?url=" + encodeURIComponent("https://v.douyinvod.com/slow.mp4"));
    await slow.body.cancel();
    await aborted;
    assert.equal((await fetch(base + "/health")).status, 200);
  } finally {
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
  }
});
