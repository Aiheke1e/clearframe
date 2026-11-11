const net = require("net");
const { ProxyAgent, Client } = require("undici");
const { safeFetch, publicLookup } = require("./network");
const { shouldUseProxy } = require("./proxyRouting");
const { lookupProxyAddress } = require("./proxyDns");

const COMMON_PORTS = [7897, 7890, 10809, 10808, 1080, 8888];

let proxyPromise = null;
let agent = null;

function envProxy() {
  return (
    process.env.OUTBOUND_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.all_proxy ||
    ""
  );
}

function canConnect(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family: 4 });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

async function detectProxy() {
  const fromEnv = envProxy();
  if (fromEnv) return fromEnv;
  for (const port of COMMON_PORTS) {
    if (await canConnect("127.0.0.1", port)) {
      return `http://127.0.0.1:${port}`;
    }
  }
  return "";
}

async function getProxyAgent(forceRefresh = false) {
  if (!forceRefresh && agent) return agent;
  if (!forceRefresh && proxyPromise) {
    const url = await proxyPromise;
    return url ? agent : null;
  }
  proxyPromise = detectProxy();
  const url = await proxyPromise;
  if (!url) {
    agent = null;
    return null;
  }
  agent = new ProxyAgent({
    uri: url,
    clientFactory(origin, options) {
      const client = new Client(origin, options);
      const connect = client.connect.bind(client);
      client.connect = async (request) => {
        const target = new URL(`http://${request.path}`);
        const address = shouldUseProxy(`https://${target.hostname}`)
          ? await lookupProxyAddress(target.hostname, url)
          : await new Promise((resolve, reject) => {
            publicLookup(target.hostname, { family: 4 }, (err, ip) => err ? reject(err) : resolve(ip));
          });
        // CONNECT to the validated IP; the original hostname is retained for TLS/SNI.
        return connect({ ...request, path: `${address}:${target.port || 80}` });
      };
      return client;
    },
  });
  console.log("[ClearFrame] outbound proxy enabled");
  return agent;
}

async function proxyFetch(url, options = {}, domains) {
  if (!shouldUseProxy(url)) {
    const { dispatcher, dispatcherForUrl, ...directOptions } = options;
    return safeFetch(url, directOptions, domains);
  }
  const deadline = AbortSignal.timeout(options.timeout || 20000);
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline };
  const dispatcher = await getProxyAgent(false);
  if (!dispatcher) {
    return safeFetch(url, options, domains);
  }
  try {
    return await safeFetch(url, { ...options, dispatcherForUrl: target => shouldUseProxy(target) ? dispatcher : null }, domains);
  } catch (err) {
    if (options.signal?.aborted || err.name === "TimeoutError" || err.name === "AbortError") throw err;
    // 代理失效时再探测一次，仍失败就回退直连
    agent = null;
    proxyPromise = null;
    const again = await getProxyAgent(true);
    if (again) {
      return safeFetch(url, { ...options, dispatcherForUrl: target => shouldUseProxy(target) ? again : null }, domains);
    }
    return safeFetch(url, options, domains);
  }
}

module.exports = { proxyFetch, getProxyAgent };
