/**
 * REGION=cn      只启用抖音/快手（国内服务器）
 * REGION=overseas 只启用 X（海外服务器，如 Render）
 * REGION=all     本地调试全开
 */
const REGION = String(process.env.REGION || "all").toLowerCase();
const PORT = Number(process.env.PORT || 8787);

module.exports = {
  REGION,
  PORT,
  HOST: process.env.HOST || "0.0.0.0",
  enableDouyin: REGION === "all" || REGION === "cn",
  enableKuaishou: REGION === "all" || REGION === "cn",
  enableX: REGION === "all" || REGION === "overseas" || process.env.ENABLE_X === "1",
};
