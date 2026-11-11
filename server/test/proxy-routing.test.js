const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { shouldUseProxy } = require("../src/proxyRouting");

test("only X-related hosts use the overseas proxy", () => {
  for (const url of ["https://x.com/test", "https://api.fxtwitter.com/status/1", "https://video.twimg.com/a.mp4", "https://pbs.twimg.com/a.jpg", "https://t.co/test", "https://twitter.com/test"]) {
    assert.equal(shouldUseProxy(url), true, url);
  }
  for (const url of ["https://v.douyin.com/test", "https://www.kuaishou.com/test", "https://p.douyinpic.com/a.jpg", "https://p.yximgs.com/a.jpg", "https://aihekele.xyz/", "https://x.com.evil.org/test", "https://x.com@evil.org/test", "https://127.0.0.1/?x.com", "file:///x.com"]) {
    assert.equal(shouldUseProxy(url), false, url);
  }
});

test("domestic traffic never probes or connects to the proxy, even when one is configured", async () => {
  const calls = [];
  const output = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/proxyFetch.js"), "utf8"), {
    module: output, exports: output.exports, process: { env: { OUTBOUND_PROXY: "http://127.0.0.1:7897" } },
    require: name => {
      if (name === "net") return { connect() { throw new Error("proxy probing forbidden"); } };
      if (name === "undici") return { ProxyAgent: class { constructor() { throw new Error("proxy connection forbidden"); } } };
      if (name === "./network") return { safeFetch: async (url, options) => { calls.push({ url, options }); return "direct"; } };
      if (name === "./proxyRouting") return { shouldUseProxy };
      if (name === "./proxyDns") return { lookupProxyAddress() { throw new Error("overseas DNS forbidden for domestic requests"); } };
      throw new Error(name);
    },
  });
  for (const url of ["https://www.kuaishou.com/", "https://www.douyin.com/", "https://p.douyinpic.com/a.jpg"]) {
    assert.equal(await output.exports.proxyFetch(url, { dispatcher: "must-not-use", dispatcherForUrl: () => "must-not-use" }), "direct");
  }
  assert.equal(calls.length, 3);
  for (const call of calls) { assert.equal(call.options.dispatcher, undefined); assert.equal(call.options.dispatcherForUrl, undefined); }
});
