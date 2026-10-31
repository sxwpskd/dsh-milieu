// dsh-milieu —— 客户端内存日志 sink（纯内存：不写文件、不访问宿主、无副作用）
//
// 依据 `plugin/dsh-milieu/LOG-SCHEMA.md` §6.2：
//   · 客户端**不直接写文件**；用内存环形缓冲（初始 200 条）；
//   · 保留现有 `criteria.debug` 调试行（那是界面用的，不是日志文件）；
//   · 需要排查时通过调试行或测试口子读取内存日志；**不把客户端日志写进工作区**。
//
// sink 的调用约定与 `log/logger.js` 一致：`write(line, record)`（函数或 `{ write }` 对象都行）。
// 这里额外接受**单参** `write(record)`，便于测试/调试直接塞一条记录。
// **不抛**：日志通道自身出错不能反噬主流程（LOG-SCHEMA §3/§7）。

/** 内存缓冲的默认上限（LOG-SCHEMA §6.2 的"初始 200 条"）。 */
export const DEFAULT_MEMORY_LIMIT = 200;

/** 归一上限：正有限数取整；坏输入退回默认值。 */
function normalizeLimit(limit) {
  const n = Number(limit);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MEMORY_LIMIT;
}

/**
 * 造一个内存 sink（每个页面/插件实例一份；生命周期跟实例走，不落盘）。
 *
 * @param {{limit?: number}} [options] `limit` 默认 200 条
 * @returns {{
 *   limit: number,
 *   write: (lineOrRecord: unknown, record?: unknown) => void,
 *   list: () => object[],
 *   snapshot: () => {limit: number, size: number, records: object[]},
 *   size: () => number,
 *   clear: () => void,
 * }}
 *   · `list()`     —— 记录数组（旧→新，返回副本，改它不影响缓冲）；
 *   · `snapshot()` —— `{ limit, size, records }`（调试/测试一眼看全）；
 *   · 到上限**丢最旧**（环形缓冲语义）。
 */
export function createMemorySink(options = {}) {
  const limit = normalizeLimit(options && options.limit);
  /** @type {object[]} 记录对象（不存 JSONL 行：记录本身就是源头，行只是序列化结果） */
  let records = [];

  /**
   * 收一条记录：
   *   · `write(line, record)` —— logger 的 sink 约定（第二个参数才是记录对象）；
   *   · `write(record)`       —— 单参用法（测试/调试直接塞记录）。
   * 永远不抛。
   */
  function write(lineOrRecord, record) {
    try {
      const item = (record !== null && record !== undefined && typeof record === 'object' && !Array.isArray(record))
        ? record
        : lineOrRecord;
      records.push(item);
      // 到上限丢最旧（一次写入保证不超上限，不会反复 splice）
      if (records.length > limit) records.splice(0, records.length - limit);
    } catch {
      /* 日志通道自身出错不反噬主流程（内存 sink 实现固定，理论上到不了这里） */
    }
  }

  return {
    limit,
    write,
    /** 记录数组（旧→新）的副本。 */
    list: () => records.slice(),
    /** `{ limit, size, records }`：调试/测试用的一眼快照。 */
    snapshot: () => ({ limit, size: records.length, records: records.slice() }),
    /** 当前条数。 */
    size: () => records.length,
    /** 清空（测试/调试用）。 */
    clear: () => { records = []; },
  };
}
