const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseShareText } = require("../../miniprogram/utils/api");

test("domain rejection identifies the actual mini program and API without exposing the share text", async () => {
  global.getApp = () => ({ globalData: { cnApiBase: "https://aihekele.xyz" } });
  global.wx = {
    request: ({ fail }) => fail({ errMsg: "request:fail url not in domain list" }),
    getAccountInfoSync: () => ({ miniProgram: {
      appId: "wx-test-actual", envVersion: "trial", version: "1.0.4",
    } }),
  };
  try {
    await assert.rejects(parseShareText("私密分享文字 https://v.douyin.com/test/"), error => {
      assert.match(error.message, /https:\/\/aihekele.xyz\/api\/parse/);
      assert.match(error.message, /wx-test-actual/);
      assert.match(error.message, /trial/);
      assert.match(error.message, /1\.0\.4/);
      assert.doesNotMatch(error.message, /私密|v\.douyin/);
      return true;
    });
  } finally { delete global.wx; delete global.getApp; }
});

test("unavailable account information does not hide the original network error", async () => {
  global.getApp = () => ({ globalData: { cnApiBase: "https://aihekele.xyz" } });
  global.wx = {
    request: ({ fail }) => fail({ errMsg: "request:fail url not in domain list" }),
    getAccountInfoSync: () => { throw new Error("not available"); },
  };
  try {
    await assert.rejects(parseShareText("https://v.douyin.com/test/"), /request:fail url not in domain list/);
    global.wx.request = ({ fail }) => fail({ errMsg: "request:fail timeout" });
    await assert.rejects(parseShareText("https://v.douyin.com/test/"), error => error.message === "request:fail timeout");
  } finally { delete global.wx; delete global.getApp; }
});
