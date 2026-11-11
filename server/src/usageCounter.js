const fs = require("fs/promises");
const path = require("path");

function createUsageCounter(filePath) {
  // 串行提交并原子替换 JSON，避免同一服务并发请求丢失计数。
  let pending = Promise.resolve();
  function enqueue(task) {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  }
  async function readCount() {
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!Number.isSafeInteger(data.count) || data.count < 0) {
        throw new Error("调用次数 JSON 中的 count 必须为非负安全整数");
      }
      return data.count;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return 0;
    }
  }
  return {
    get: () => enqueue(readCount),
    increment: () => enqueue(async () => {
      const next = (await readCount()) + 1;
      if (!Number.isSafeInteger(next)) throw new Error("调用次数超出安全整数范围");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ count: next }, null, 2) + "\n", "utf8");
        await fs.rename(temporary, filePath);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      return next;
    }),
  };
}

module.exports = { createUsageCounter };
