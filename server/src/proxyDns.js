const net = require("node:net");
const { ProxyAgent, fetch } = require("undici");
const { isPublicAddress } = require("./network");
const { shouldUseProxy } = require("./proxyRouting");

function createLookup(query, now = Date.now) {
  const cache = new Map();
  const pending = new Map();
  return async hostname => {
    if (!/^[a-z0-9.-]+$/i.test(hostname) || !shouldUseProxy(`https://${hostname}`)) throw new Error("不支持的海外域名");
    const cached = cache.get(hostname);
    if (cached && cached.expires > now()) return cached.address;
    if (pending.has(hostname)) return pending.get(hostname);
    const task = (async () => {
      const result = await query(hostname);
      const records = (result.Answer || []).filter(record => record.type === 1);
      if (result.Status !== 0 || !records.length || records.some(record => net.isIP(record.data) !== 4 || !isPublicAddress(record.data))) {
        throw new Error("海外 DNS 未返回有效公网地址");
      }
      const ttl = Math.max(0, Math.min(300, ...records.map(record => Number.isFinite(record.TTL) ? record.TTL : 0)));
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(hostname, { address: records[0].data, expires: now() + ttl * 1000 });
      return records[0].data;
    })();
    pending.set(hostname, task);
    try { return await task; } finally { pending.delete(hostname); }
  };
}

const resolvers = new Map();
async function lookupProxyAddress(hostname, proxyUri) {
  let resolver = resolvers.get(proxyUri);
  if (!resolver) {
    // 固定公网引导地址避免本地 DNS 污染；HTTPS 证书仍正常校验。
    const agent = new ProxyAgent(proxyUri);
    const lookup = createLookup(async name => {
      let lastError;
      for (const address of ["1.1.1.1", "1.0.0.1"]) {
        try {
          const response = await fetch(`https://${address}/dns-query?name=${encodeURIComponent(name)}&type=A`, {
            dispatcher: agent, headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000), redirect: "error",
          });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`海外 DNS HTTP ${response.status}`); }
          return await response.json();
        } catch (error) { lastError = error; }
      }
      throw lastError;
    });
    resolver = { agent, lookup };
    resolvers.set(proxyUri, resolver);
  }
  return resolver.lookup(hostname);
}

async function closeProxyDns() {
  await Promise.all([...resolvers.values()].map(resolver => resolver.agent.destroy()));
  resolvers.clear();
}

module.exports = { createLookup, lookupProxyAddress, closeProxyDns };
