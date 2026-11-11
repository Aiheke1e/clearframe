const OVERSEAS_DOMAINS = ["x.com", "twitter.com", "t.co", "twimg.com", "fxtwitter.com"];

function shouldUseProxy(input) {
  try {
    const url = new URL(String(input));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    return OVERSEAS_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain));
  } catch { return false; }
}

module.exports = { shouldUseProxy };
