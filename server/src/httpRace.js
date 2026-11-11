const dns = require("dns").promises;
const http = require("http");

function raceHttp(url, { headers = {}, timeout = 2500 } = {}) {
  const target = new URL(url);
  return dns.resolve4(target.hostname).then((ips) => {
    if (!ips.length) throw new Error("网络请求失败（DNS）");
    const requests = [];
    const attempts = ips.map(
      (ip) =>
        new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: ip,
              port: Number(target.port || 80),
              method: "GET",
              path: `${target.pathname}${target.search}`,
              headers: {
                Host: target.host,
                Connection: "close",
                "user-agent": headers["user-agent"] || "Mozilla/5.0",
                ...(headers.referer ? { referer: headers.referer } : {}),
                ...(headers.range ? { range: headers.range } : {}),
                ...(headers.accept ? { accept: headers.accept } : {}),
              },
              timeout,
            },
            (res) => {
              resolve({
                status: res.statusCode || 0,
                headers: res.headers,
                stream: res,
                req,
              });
            }
          );
          requests.push(req);
          req.on("timeout", () => {
            req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
          });
          req.on("error", reject);
          req.end();
        })
    );

    return Promise.any(attempts)
      .then((winner) => {
        for (const req of requests) {
          if (req !== winner.req) req.destroy();
        }
        return winner;
      })
      .catch((err) => {
        const reason = err?.errors?.[0]?.code || err?.message || "ECONNRESET";
        throw new Error(`网络请求失败（${reason}）`);
      });
  });
}

module.exports = { raceHttp };
