const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const dns = require("node:dns");

test("proxy CONNECT uses validated public IP and retains the HTTP hostname", async () => {
  const server = http.createServer();
  let tunnelTarget, hostHeader;
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("connect", (req, socket) => {
    tunnelTarget = req.url;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", chunk => {
      hostHeader = String(chunk).match(/\r\nhost: ([^\r]+)/i)?.[1];
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const originalLookup = dns.lookup;
  const originalProxy = process.env.HTTPS_PROXY;
  dns.lookup = (hostname, options, callback) => hostname === "x.com"
    ? callback(null, [{ address: "8.8.8.8", family: 4 }])
    : originalLookup(hostname, options, callback);
  process.env.HTTPS_PROXY = `http://127.0.0.1:${server.address().port}`;
  const proxyDns = require("../src/proxyDns");
  const originalProxyLookup = proxyDns.lookupProxyAddress;
  proxyDns.lookupProxyAddress = async hostname => { assert.equal(hostname, "x.com"); return "8.8.8.8"; };
  let agent;
  try {
    const { proxyFetch, getProxyAgent } = require("../src/proxyFetch");
    agent = await getProxyAgent(true);
    const response = await proxyFetch("http://x.com/test", { timeout: 1000 });
    assert.equal(await response.text(), "ok");
    assert.equal(tunnelTarget, "8.8.8.8:80");
    assert.equal(hostHeader, "x.com");
  } finally {
    dns.lookup = originalLookup;
    proxyDns.lookupProxyAddress = originalProxyLookup;
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalProxy;
    await agent?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
