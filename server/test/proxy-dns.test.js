const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createLookup } = require("../src/proxyDns");

test("overseas DNS coalesces concurrent lookups, honors TTL and pins a public IPv4 address", async () => {
  let calls = 0, clock = 0;
  const lookup = createLookup(async hostname => {
    assert.equal(hostname, "pbs.twimg.com"); calls++;
    return { Status: 0, Answer: [{ type: 5, data: "cdn.example", TTL: 60 }, { type: 1, data: "151.101.40.159", TTL: 30 }] };
  }, () => clock);
  const results = await Promise.all(Array.from({ length: 5 }, () => lookup("pbs.twimg.com")));
  assert.ok(results.every(address => address === "151.101.40.159"));
  assert.equal(calls, 1);
  await lookup("pbs.twimg.com"); assert.equal(calls, 1);
  clock = 31000;
  await lookup("pbs.twimg.com"); assert.equal(calls, 2);
});

test("overseas DNS rejects mixed private answers and never queries domestic or arbitrary hosts", async () => {
  let calls = 0;
  const lookup = createLookup(async () => {
    calls++;
    return { Status: 0, Answer: [{ type: 1, data: "8.8.8.8", TTL: 30 }, { type: 1, data: "127.0.0.1", TTL: 30 }] };
  });
  await assert.rejects(lookup("pbs.twimg.com"), /公网/);
  for (const host of ["www.douyin.com", "www.kuaishou.com", "x.com.evil.org", "127.0.0.1", "x.com@127.0.0.1"]) {
    await assert.rejects(lookup(host), /不支持/);
  }
  assert.equal(calls, 1);
});
