const { test } = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns");
const undici = require("undici");
let fetchImpl;
const originalFetch = undici.fetch;
undici.fetch = (...args) => fetchImpl(...args);
const { safeFetch, validateUrl, isPublicAddress, publicLookup } = require("../src/network");
undici.fetch = originalFetch;
const { detectPlatform } = require("../src/utils");
const mini = require("../../miniprogram/utils/platform");

test("platform detection rejects URL spoofing and credentials", () => {
  for (const url of ["http://127.0.0.1/?next=kuaishou.com", "https://kuaishou.com.evil.org/", "https://evil.org/x.com/", "https://x.com@evil.org/", "https://user:pass@x.com/test", "https://x.com:8080/a"]) {
    assert.equal(detectPlatform(url), "unknown", url);
    assert.equal(mini.detectPlatform(url), "unknown", url);
  }
  for (const [url, platform] of [["https://v.douyin.com/a/", "douyin"], ["https://v.kuaishou.com/a", "kuaishou"], ["https://x.com/a/status/123", "x"]]) {
    assert.equal(detectPlatform(url), platform);
    assert.equal(mini.detectPlatform(url), platform);
  }
});

test("reserved IP ranges and DNS answers are blocked", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  const original = dns.lookup;
  dns.lookup = (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]);
  try {
    await assert.rejects(new Promise((resolve, reject) => publicLookup("www.kuaishou.com", {}, (err, value) => err ? reject(err) : resolve(value))), /内网/);
  } finally { dns.lookup = original; }
});

test("redirect to an internal or unapproved host is never requested", async () => {
  let calls = 0;
  fetchImpl = async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); };
  await assert.rejects(safeFetch("https://www.kuaishou.com/a"), /不支持/);
  assert.equal(calls, 1);
  assert.throws(() => validateUrl("file:///etc/passwd"), /不支持/);
});

test("redirects strip cross-origin credentials and change POST to GET", async () => {
  const calls = [];
  fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? new Response(null, { status: 303, headers: { location: "https://www.douyin.com/next" } }) : new Response("done");
  };
  const result = await safeFetch("https://www.iesdouyin.com/start", { method: "POST", body: "{}", headers: { cookie: "secret", authorization: "secret", "content-type": "application/json" } });
  assert.equal(await result.text(), "done");
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[1].options.body, undefined);
  assert.equal(calls[1].options.headers.has("cookie"), false);
  assert.equal(calls[1].options.headers.has("authorization"), false);
});

test("deadline aborts stalled upstream and caller cancellation propagates", async () => {
  fetchImpl = (_url, { signal }) => new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(safeFetch("https://x.com/", { timeout: 20 }), { name: "TimeoutError" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(safeFetch("https://x.com/", { signal: controller.signal }), { name: "AbortError" });
  } finally { clearInterval(keepAlive); }
});

test("proxy routing is reevaluated at every redirect and never forwarded as an HTTP option", async () => {
  const proxy = { name: "overseas" };
  const calls = [];
  fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://www.douyin.com/next" } }) : new Response("direct");
  };
  const response = await safeFetch("https://x.com/start", { dispatcherForUrl: url => url.hostname === "x.com" ? proxy : null });
  assert.equal(await response.text(), "direct");
  assert.equal(calls[0].options.dispatcher, proxy);
  assert.notEqual(calls[1].options.dispatcher, proxy);
  assert.equal(calls[0].options.dispatcherForUrl, undefined);
});
