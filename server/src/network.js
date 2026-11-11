const dns = require("dns");
const net = require("net");
const { AsyncLocalStorage } = require("async_hooks");
const { Agent, fetch: undiciFetch } = require("undici");

const SHARE_DOMAINS = ["douyin.com", "iesdouyin.com", "toutiao.com", "kuaishou.com", "gifshow.com", "chenzhongtech.com", "x.com", "twitter.com", "t.co"];
const MEDIA_DOMAINS = ["douyinvod.com", "douyinpic.com", "douyincdn.com", "byteimg.com", "pstatp.com", "yximgs.com", "kwimgs.com", "kwaicdn.com", "twimg.com"];
const UPSTREAM_DOMAINS = [...SHARE_DOMAINS, ...MEDIA_DOMAINS, "snssdk.com", "bytedance.com", "fxtwitter.com"];
const requestContext = new AsyncLocalStorage();

function hostMatches(host, domains) {
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function validateUrl(input, domains = UPSTREAM_DOMAINS) {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !hostMatches(url.hostname, domains)) {
    throw new Error("不支持的请求地址");
  }
  return url;
}

function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Only global IPv6 unicast; exclude documentation and transition ranges.
  const ip = address.toLowerCase();
  return net.isIP(ip) === 6 && /^[23]/.test(ip) &&
    !/^2001:(?:0:|db8:|10:|20:)/.test(ip) && !ip.startsWith("2002:");
}

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) {
      return callback(new Error("禁止访问内网或保留地址"));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

// Validate the DNS result used by the socket itself to prevent DNS rebinding.
const dispatcher = new Agent({ connect: { lookup: publicLookup } });

async function safeFetch(input, options = {}, domains = UPSTREAM_DOMAINS) {
  const { timeout = 20000, dispatcherForUrl, ...requestOptions } = options;
  const deadline = AbortSignal.timeout(timeout);
  const signals = [deadline, options.signal, requestContext.getStore()?.signal].filter(Boolean);
  const signal = AbortSignal.any(signals);
  let url = validateUrl(input, domains);
  let current = { ...requestOptions };
  for (let hop = 0; hop <= 5; hop += 1) {
    const selectedDispatcher = dispatcherForUrl ? (await dispatcherForUrl(url)) || dispatcher : current.dispatcher || dispatcher;
    const response = await undiciFetch(url, { ...current, dispatcher: selectedDispatcher, signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get("location") || options.redirect === "manual") return response;
    await response.body?.cancel();
    if (hop === 5) throw new Error("重定向次数过多");
    const next = validateUrl(new URL(response.headers.get("location"), url), domains);
    if (next.origin !== url.origin) {
      const headers = new Headers(current.headers);
      headers.delete("cookie");
      headers.delete("authorization");
      current.headers = headers;
    }
    if (response.status === 303 || ([301, 302].includes(response.status) && current.method === "POST")) {
      current.method = "GET";
      delete current.body;
      const headers = new Headers(current.headers);
      headers.delete("content-type");
      headers.delete("content-length");
      current.headers = headers;
    }
    url = next;
  }
}

module.exports = { safeFetch, validateUrl, isPublicAddress, publicLookup, hostMatches, SHARE_DOMAINS, MEDIA_DOMAINS, requestContext };
