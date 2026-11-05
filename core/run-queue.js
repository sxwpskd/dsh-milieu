// dsh-milieu —— **串行运行队列**（纯模块：零依赖、无副作用、不读写文件、不访问宿主）
//
// 为什么需要它（2026-11-02）：
//   · 插件挂载后有两个长期 effect 会"整段跑一次可能写文件"的动作——预加载监控（写受管会话表）
//     与工作区监控（写 `milieu-state.json`）；
//   · 两边同时读-改-写同一份 `milieu-state.json` 时，**后写的会把前一个刚写的覆盖掉**
//     （典型：预加载刚登记的受管会话被扫描写回旧表）。串行化是最小、最稳的修法。
//
// 语义（调用方可依赖的契约）：
//   · **FIFO 串行**：前一个结束（无论成功 / 失败）才跑下一个；不并发；
//   · `enqueue(fn)` 返回 Promise，解析为 `fn` 的返回值（fn 返回 Promise 会平展）；
//   · `fn` reject → 该次 `enqueue` 返回的 Promise reject（调用方自己处理），
//     **但队列不断**：后面的任务照跑；
//   · `size()` = 已入队未完成数（含正在跑的那个），排障 / 测试用；
//   · **不提供 cancel**：停止语义由调用方保证（monitor 在排队任务里先查自己的 stopped）。
//
// 为什么不是"一把锁 + 重试"：本插件的写入都是同步 fs 能力（`adapter/fs.js`），
//   没有可重入的异步临界区；队列把"整段运行"串起来就够，且失败可见（不吞错）。

/**
 * 造一个串行队列（**一个插件 / 一个工作区一份**；不要每轮新建，否则没意义）。
 * @returns {{enqueue: (fn: Function) => Promise<any>, size: () => number}}
 */
export function createSerialQueue() {
  /** 链尾：永远 resolve（不让前一个失败把队列断掉）；下一个任务挂在它后面。 */
  let tail = Promise.resolve();
  /** 已入队未完成数（含正在跑的那个）。 */
  let pending = 0;

  /**
   * 排队执行一段任务。
   * @param {Function} fn 要串行执行的任务（可以是 async）
   * @returns {Promise<any>} 解析为 `fn` 的返回值；`fn` 失败时 reject（队列继续）
   */
  function enqueue(fn) {
    if (typeof fn !== 'function') {
      // 坏输入不许悄悄入队成一个"什么都没发生"的任务——直接让人看见。
      throw new TypeError('createSerialQueue().enqueue(fn)：fn 必须是函数');
    }
    pending += 1;
    const run = tail.then(() => fn());
    // 链尾吞掉成功/失败，只把"该跑下一个了"传下去；pending 在下一个开始前减好。
    tail = run.then(
      () => { pending -= 1; },
      () => { pending -= 1; },
    );
    // 调用方拿到的是**原任务的 Promise**：可以 await / catch；不接也不会造成未处理拒绝
    // （run 上已挂了链尾处理器）。
    return run;
  }

  return { enqueue, size: () => pending };
}
