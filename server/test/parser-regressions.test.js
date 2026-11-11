const { test } = require("node:test");
const assert = require("node:assert/strict");

test("Kuaishou atlas excludes escaped embedded JSON and preserves caption/author", async () => {
  const utils = require("../src/utils");
  const original = utils.fetchText;
  const paths = ["/ufile/atlas/sample_0.jpg", "/ufile/atlas/sample_1.jpg"];
  const html = JSON.stringify({
    embedded: JSON.stringify({ image: paths[0] }),
    atlas: { cdnList: [{ cdn: "p2.a.yximgs.com" }], list: paths },
    caption: '作品 "原图"',
    user_name: "作者",
  });
  utils.fetchText = async () => ({ text: html });
  try {
    const { parseKuaishou } = require("../src/parsers/kuaishou");
    const result = await parseKuaishou("https://v.kuaishou.com/test");
    assert.deepEqual(result.items.map(item => item.url), paths.map(path => "https://p2.a.yximgs.com" + path));
    assert.equal(result.title, '作品 "原图"');
    assert.equal(result.author, "作者");
  } finally { utils.fetchText = original; }
});

test("Douyin rejects live links with an actionable client error", async () => {
  const network = require("../src/network");
  const original = network.safeFetch;
  let calls = 0;
  network.safeFetch = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://webcast.amemv.com/douyin/webcast/reflow/123" } });
  };
  try {
    const { parseDouyin } = require("../src/parsers/douyin");
    await assert.rejects(parseDouyin("https://live.douyin.com/123"), err => err.statusCode === 400 && /不支持直播/.test(err.message));
    assert.equal(calls, 0);
    await assert.rejects(parseDouyin("https://v.douyin.com/live/"), err => err.statusCode === 400 && /短视频或图集/.test(err.message));
    assert.equal(calls, 1);
  } finally { network.safeFetch = original; }
});
