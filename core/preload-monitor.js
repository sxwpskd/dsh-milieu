// dsh-milieu —— **预加载会话的长期监控**（核心层：不写宿主服务名、不 import 'node:fs'）
//
// 它解决的是什么（2026-10-31 定）：
//   · 预加载以前是"启动时算一次"——用户真的用了那条预加载会话之后，插件要到**下次重启**
//     才发现"它已经毕业了、该给工作区建一条新的"；
//   · 现在把它变成**挂载后的长期 effect**：轮次事件（`turn/end`）即时触发 + 低频定时兜底。
//   一个工作区一份（由 `core/boot.js` 在服务就绪的回调里启动）。
//
// 它**只做调度与写字**，不做判断：该不该建 / 该不该毕业 / 恰好一条的对账，全在
// `core/preload.js`。这里负责：
//   ① 触发（初始一次 / 定时 / `turn/end` 去抖）；
//   ② 单飞（同一时刻只跑一次；运行中再触发只排队一次，不丢事件也不并发）；
//   ③ 日志（**只在状态变化时写**；稳定态每 tick 都安静的，不刷屏）。
//
// 日志纪律（LOG-SCHEMA.md）：不新增事件名，复用 `preload.create` / `preload.skip` /
//   `preload.failed` / `error.caught`。判据是 `preloadSession` 返回结果的**签名变化**：
//   · 建了 → preload.create；对账修复 / 毕业 → preload.skip（info）；首次 readiness 跳过 → preload.skip；
//   · 失败 → error.caught（带 code 的边界失败）或 preload.failed；**同一签名连续出现只写一次**；
//   · 只补读 / 已存在 / 未空闲 / 不知道活动时间 → 静默（这些是稳定态，不是状态变化）。
//
// 生命周期：start 返回 `{stop, tick, initial}`；`stop` 同步清定时器、去抖计时器与事件监听，
//   并**忽略在飞结果**（不写日志、不写文件）。timer 一律 `unref()`——监控不能拖住宿主进程退出。
//
// 测试口子：`timers` / `runPreload` / `debounceMs` 可注入（纯 node 断言，不碰真宿主）。
//   `initial` 是第一次运行的 Promise（测试用来确定初始轮跑完；线上不用）。
import { preloadSession } from './preload.js';
import { DEFAULT_CRITERIA } from '../config/criteria.js';
import { CODES } from '../exception/codes.js';
import { workspaceKey } from '../utils/path.js';

/** 轮次事件触发后的去抖窗口：一轮里可能有多个 turn/end 相关的持久事件，攒一下再跑。 */
const DEFAULT_DEBOUNCE_MS = 300;

/** 日志里允许出现的 `blockedBy`（`log/schema.js` 的 BLOCKED_BY 契约）。 */
const BLOCKED_BYS = ['host', 'fs', 'config', 'protocol', 'session', 'state', 'ui', 'unknown'];

/** 安全地写一条事件日志（日志通道坏了不能反噬监控）。 */
function emit(log, event, message, fields) {
  try {
    if (log && typeof log.event === 'function') return log.event(event, message, fields || {});
  } catch { /* 日志坏了：监控照跑 */ }
  return null;
}

/** 取一个非负有限数；坏值退到 fallback。 */
function positiveMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 定时器归一：注入点没给的方法退回全局（Node/浏览器都有）。 */
function pickTimers(timers) {
  const source = timers && typeof timers === 'object' ? timers : {};
  const pick = (name) => (typeof source[name] === 'function'
    ? source[name].bind(source)
    : globalThis[name].bind(globalThis));
  return {
    setInterval: pick('setInterval'),
    clearInterval: pick('clearInterval'),
    setTimeout: pick('setTimeout'),
    clearTimeout: pick('clearTimeout'),
  };
}

/** 尝试 `unref()`——Node 的 Timeout 有，浏览器 / 假定时器未必有。 */
function unrefTimer(timer) {
  try {
    if (timer && typeof timer.unref === 'function') timer.unref();
  } catch { /* 没有就算了 */ }
}

/** 失败结果的人话（没有 message 也要说清来源）。 */
function reasonOf(err) {
  return String((err && err.message) || err || '未知原因');
}

/** readiness 不达标：新形状看 `skipped`，旧形状（A 改造前）看 `readiness.ready === false`。 */
function isReadinessSkip(result) {
  if (!result) return false;
  if (result.skipped === 'readiness') return true;
  return !!(result.created !== true && result.readiness && result.readiness.ready === false);
}

/**
 * 结果签名：**只有签名变化才值得写一条日志**。
 * 稳定态（只补读 / 已存在 / 未空闲 / 不知道活动时间）也各有签名——它们静默，
 * 但签名变化会让下一次真正的状态变化重新被当成"变化"。
 */
function signatureOf(result) {
  if (!result) return 'none';
  if (result.ok === false) {
    if (isReadinessSkip(result)) return 'readiness';
    // 失败签名**只认分类**（code + blockedBy），不认 reason 里的动态内容
    // （例如时间差 / 路径 / 平台错误原文）——否则同一类失败会因文案变化每 tick 重写一条 error。
    const blockedBy = BLOCKED_BYS.includes(result.blockedBy) ? result.blockedBy : 'session';
    return 'fail:' + String(result.code || '') + ':' + blockedBy;
  }
  if (result.created === true) return 'created:' + String(result.sessionId || '');
  // `repaired` / `converged` 是**次数**（task-1 的 preloadSession 契约）：次数变了也是状态变化。
  if (result.repaired || result.converged || result.graduatedFrom) {
    return 'state:' + [
      'r' + (Number(result.repaired) || 0),
      'c' + (Number(result.converged) || 0),
      result.graduatedFrom ? 'g:' + String(result.graduatedFrom) : '',
    ].join('|');
  }
  // readiness 跳过：新形状是 ok:true + skipped:'readiness'（有意 0 条，不是失败）。
  if (isReadinessSkip(result)) return 'readiness';
  // 稳定态：只补读 / 已存在 / 未空闲 / 不知道活动时间 / 什么都没做
  return 'stable:' + String(result.skipped || (result.didRead ? 'read' : 'none'));
}

/**
 * 启动预加载会话监控（**一个工作区一份**；由 `core/boot.js` 在服务就绪后调用）。
 *
 * @param {object} o
 *   · host / fs / root / libs / texts / criteria —— 与 `preloadSession` 同一份入参，原样转发
 *   · log        —— 可选：`{event(name, message, fields)}`（`log/logger.js` 的新形态）；只写事件日志
 *   · timers     —— 可选注入：`{setInterval, clearInterval, setTimeout, clearTimeout}`；默认全局
 *   · runPreload —— 可选注入：默认 `core/preload.js` 的 `preloadSession`（测试用来控制"在飞"）
 *   · enqueue    —— 可选注入：共享串行队列的 `enqueue(fn)`（`core/run-queue.js`）；
 *                    默认直通 `(fn) => fn()`。给了就与工作区监控串行，**避免并发写同一份状态文件**。
 *   · debounceMs —— 可选：turn/end 去抖窗口，默认 300ms
 * @returns {{stop:Function, tick:Function, initial:Promise<object>}}
 *   · `tick()`  手动触发一轮（**不走 300ms 去抖**）；返回解析为该轮结果的 Promise。
 *                若已有运行在飞：排队一次，返回的 Promise 解析为**补跑**那次的结果。
 *   · `stop()`  同步停止；幂等；之后 `tick()` 立即解析为 `{ok:false, skipped:'stopped'}`。
 *   · `initial` 第一次运行的 Promise（永不 reject；测试用于确定初始轮结束）。
 */
export function startPreloadMonitor(o = {}) {
  const {
    host, fs, root, libs, texts, criteria,
  } = o;
  const log = o.log || null;
  const timers = pickTimers(o.timers);
  const debounceMs = positiveMs(o.debounceMs, DEFAULT_DEBOUNCE_MS);
  const runPreload = typeof o.runPreload === 'function' ? o.runPreload : preloadSession;
  // 共享串行队列：默认直通（单测/独立使用时不强制依赖 boot 的队列）。
  const enqueue = typeof o.enqueue === 'function' ? o.enqueue : ((fn) => fn());
  const pollMs = positiveMs(
    criteria && criteria.preloadPollMs,
    positiveMs(DEFAULT_CRITERIA.preloadPollMs, 60 * 1000),
  );
  const wk = root ? workspaceKey(root) : null;

  /** 停止后的统一结果（tick 不再跑；等人的 promise 也解析成它，不 reject）。 */
  const stoppedResult = () => ({ ok: false, skipped: 'stopped', reason: '预加载监控已停止' });

  let stopped = false;
  let running = false;      // 有 run 在飞
  let queued = false;       // 运行中又被触发：只排队一次
  let queuedWaiters = [];   // 排队触发者的 resolve（解析为补跑结果）
  let lastSignature = null; // 上一次运行的结果签名（**只在变化时写日志**）
  let pollTimer = null;
  let debounceTimer = null;
  let disposeListener = null;
  let handle = null;        // preloadSession 若返回 agent handle，stop 时替它释放

  /** 解析所有排队等待者（补跑结束 / stop 时）。 */
  function flushQueuedWaiters(result) {
    const waiters = queuedWaiters;
    queuedWaiters = [];
    for (const resolve of waiters) {
      try { resolve(result); } catch { /* 等待者的回调坏了不影响别人 */ }
    }
  }

  /** 一条结果 → 该不该写日志、写哪个事件。**只在签名变化时**走到这里。 */
  function report(result) {
    const r = result && typeof result === 'object' ? result : null;
    const signature = signatureOf(r);
    if (signature === lastSignature) return; // 同一状态：稳定态不刷 info
    lastSignature = signature;
    if (!r) return;

    if (r.created === true) {
      emit(log, 'preload.create', '[milieu] ' + String(r.reason || '建了一条预加载会话'), {
        ok: true,
        workspaceKey: wk,
        sessionId: r.sessionId,
        data: {
          didRead: !!r.didRead,
          repaired: Number(r.repaired) || 0,
          converged: Number(r.converged) || 0,
          graduated: !!r.graduatedFrom,
        },
      });
      return;
    }

    if (r.repaired || r.converged || r.graduatedFrom) {
      // 受管会话表的状态变化（清理冗余 / 收敛成一条 / 旧的转 active）：info，不是失败也不是新建。
      emit(log, 'preload.skip', '[milieu] 预加载对账：' + String(r.reason || '受管会话表已修复'), {
        ok: true,
        workspaceKey: wk,
        sessionId: r.sessionId,
        data: {
          repaired: Number(r.repaired) || 0,
          converged: Number(r.converged) || 0,
          graduated: !!r.graduatedFrom,
        },
      });
      return;
    }

    // readiness 不达标：新形状是 ok:true + skipped:'readiness'（有意 0 条，不是失败）；
    // 旧形状是 ok:false + readiness.ready===false。两种都按"正常跳过"报，且只报首次。
    if (isReadinessSkip(r)) {
      emit(log, 'preload.skip', '[milieu] ' + String(r.reason || '认知库没到预加载门槛'), {
        ok: false,
        workspaceKey: wk,
        data: { reason: 'readiness' },
      });
      return;
    }

    if (r.ok === true) return; // 只补读 / 已存在 / 未空闲：稳定态，静默

    const blockedBy = BLOCKED_BYS.includes(r.blockedBy) ? r.blockedBy : 'session';
    if (r.code) {
      // 边界归一出来的意外失败：只报一次（签名再变才再报），不每 tick 刷 error。
      emit(log, 'error.caught', '[milieu] 预加载监控意外失败：' + String(r.reason || '未知原因'), {
        level: 'error',
        ok: false,
        code: r.code,
        blockedBy,
        workspaceKey: wk,
        sessionId: r.sessionId,
        error: r.cause instanceof Error ? r.cause : undefined,
      });
      return;
    }

    emit(log, 'preload.failed', '[milieu] 预加载会话没能建起来：' + String(r.reason || '未知原因'), {
      ok: false,
      code: CODES.SESSION_CREATE_FAILED,
      blockedBy,
      workspaceKey: wk,
      sessionId: r.sessionId,
      data: { retryable: !!r.retryable },
    });
  }

  /** 跑一轮（含异常归一；**永不 reject**）。 */
  async function runOnce() {
    let result;
    try {
      // 整段运行放进**共享串行队列**（boot 注入）：与工作区监控串行，避免两边同时
      // 读-改-写 `milieu-state.json` 时互相覆盖（预加载登记可能被扫描写回旧表）。
      // 队列本身不提供 cancel；**stop 后排队任务不执行**由下面这句 stopped 检查保证。
      result = await enqueue(() => {
        if (stopped) return stoppedResult();
        return runPreload({ host, fs, root, libs, texts, criteria });
      });
    } catch (err) {
      // `preloadSession` 自己包了 guardAsync（不会 reject）；注入的 runPreload 可能抛，这里收掉。
      result = {
        ok: false,
        code: CODES.HOST_CALL_FAILED,
        reason: reasonOf(err),
        blockedBy: 'host',
      };
    }
    if (stopped) return result; // 在飞结果被忽略：不写日志、不碰资源
    if (result && result.handle) handle = result.handle;
    report(result);
    return result;
  }

  /**
   * 单飞驱动：一轮结束 → 若有排队就补跑一次；否则解析排队者（若有）。
   * **不 await 补跑**——每个 `drive()` 的 Promise 只代表它自己那一轮。
   */
  async function drive() {
    // stop 之后任何路径（含已排队的补跑）都不许再跑：在飞结果已被忽略，
    // 补跑若真执行还可能建会话（stop 后不该有副作用）。这里同时清排队标记。
    if (stopped) {
      queued = false;
      flushQueuedWaiters(stoppedResult());
      return stoppedResult();
    }
    running = true;
    let result;
    try {
      result = await runOnce();
    } catch (err) {
      // runOnce 理论上不抛；兜底保证 drive 永不 reject（否则会是未处理的 Promise 拒绝）。
      result = { ok: false, code: CODES.HOST_CALL_FAILED, reason: reasonOf(err), blockedBy: 'host' };
    } finally {
      running = false;
    }
    if (stopped) {
      queued = false;
      flushQueuedWaiters(stoppedResult());
      return stoppedResult(); // 在飞期间被 stop：本轮结果不再算数（也没有报告过）
    }
    if (queued) {
      queued = false;
      void drive(); // 补跑一次；它的结果解析给排队者（见 drive 末尾 flush）
    } else {
      flushQueuedWaiters(result);
    }
    return result;
  }

  /** 事件 / 定时触发：不返回 Promise（调用方不关心结果）。 */
  function requestRun() {
    if (stopped) return;
    if (running) { queued = true; return; }
    void drive();
  }

  /** 手动触发一轮；返回 Promise（排队时解析为补跑结果）。 */
  function tick() {
    if (stopped) return Promise.resolve(stoppedResult());
    if (running) {
      queued = true;
      return new Promise((resolve) => { queuedWaiters.push(resolve); });
    }
    return drive();
  }

  /** `turn/end` → 去抖后触发（一轮里可能连着好几个持久事件，攒一下）。 */
  function scheduleDebouncedRun() {
    if (stopped) return;
    if (debounceTimer !== null) {
      try { timers.clearTimeout(debounceTimer); } catch { /* 计时器坏了也不影响下一轮 */ }
      debounceTimer = null;
    }
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = null;
      requestRun();
    }, debounceMs);
    unrefTimer(debounceTimer);
  }

  /** 停止：清计时器、去抖、事件监听，忽略在飞结果；幂等。 */
  function stop() {
    if (stopped) return;
    stopped = true;
    queued = false; // 排队中的补跑作废（drive 开头还有一道同样的闸）
    if (pollTimer !== null) {
      try { timers.clearInterval(pollTimer); } catch { /* 同上 */ }
      pollTimer = null;
    }
    if (debounceTimer !== null) {
      try { timers.clearTimeout(debounceTimer); } catch { /* 同上 */ }
      debounceTimer = null;
    }
    if (typeof disposeListener === 'function') {
      try { disposeListener(); } catch { /* 取消订阅失败不能反噬卸载 */ }
      disposeListener = null;
    }
    if (handle && typeof handle.dispose === 'function') {
      try {
        Promise.resolve(handle.dispose()).catch(() => { /* 卸载期释放失败不报 */ });
      } catch { /* 同上 */ }
      handle = null;
    }
    flushQueuedWaiters(stoppedResult());
  }

  // ① 先挂长期触发（事件监听 + 低频定时），再跑初始一次——初始跑的同时事件已经能排队。
  try {
    disposeListener = host && typeof host.onSessionEvent === 'function'
      ? host.onSessionEvent((session, event) => {
        if (!event || event.type !== 'turn/end') return;
        scheduleDebouncedRun();
      })
      : null;
    if (typeof disposeListener !== 'function') disposeListener = null;
  } catch {
    disposeListener = null; // 宿主订阅失败：退回只靠定时兜底（不炸）
  }

  pollTimer = timers.setInterval(() => requestRun(), pollMs);
  unrefTimer(pollTimer);

  // ② 初始跑一次（`initial` 只给测试/诊断等它结束；线上不等）。
  const initial = tick();

  return { stop, tick, initial };
}
