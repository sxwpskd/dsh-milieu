// dsh-milieu —— **工作区改动监控**（核心层：不写宿主服务名、不 import 'node:fs'）
//
// 它解决的是什么（2026-11-02）：
//   · 工作区改动以前**只在启动时扫一次**——插件挂着的时候用户改了文件，状态账/注入页要等
//     下次重启才更新（重读卡片因此看到旧账）；
//   · 现在把它变成**挂载后的长期 effect**：轮次事件（`turn/end`）去抖触发 + 低频定时兜底。
//   一个工作区一份（由 `core/boot.js` 在 `autoState` 打开时启动）。
//
// 它**只做调度**：扫描本身由 boot 注入的 `scan()` 负责（generateState → 条件追加原始日志 →
//   条件写状态文件 → 刷新注入页）。这里负责：
//   ① 触发（`turn/end` 去抖 300ms / `workspacePollMs` 定时 / 测试用 `tick()`）；
//   ② 单飞（同一时刻只跑一次；运行中再触发只排队一次，不丢事件也不并发）；
//   ③ 日志（**只在有新事件 / 首轮基线 / 失败 / 原始日志追加失败时写**；稳定态安静）；
//   ④ 串行（通过注入的 `enqueue` 与预加载监控排队，避免两边同时写 `milieu-state.json`）。
//
// 与 `core/preload-monitor.js` 的关键区别：**启动时不额外跑一次**——boot 已经做过初始扫描，
//   再做一次只会白读一遍工作区。
//
// 日志纪律（LOG-SCHEMA.md）：不新增事件名，只复用
//   `state.generate` / `state.generate.failed` / `error.caught`
//   （+ 扫描内部的 `state.page.refresh` / `state.page.skip`）。
//   失败不静默；稳定态不刷日志。
//
// 生命周期：start 返回 `{stop, tick, initial}`；`stop` 同步清定时器、去抖计时器与事件监听，
//   并**忽略在飞结果**；timer 一律 `unref()`。测试口子：`timers` / `enqueue` / `debounceMs` 可注入。
import { DEFAULT_CRITERIA } from '../config/criteria.js';
import { CODES } from '../exception/codes.js';

/** 轮次事件触发后的去抖窗口（一轮里可能连着多个持久事件，攒一下再扫）。 */
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

/** 从扫描结果里拿 workspaceKey（boot 的 scan 会带；假 scan 不带也没关系）。 */
function workspaceKeyOf(result) {
  return result && typeof result.workspaceKey === 'string' ? result.workspaceKey : null;
}

/**
 * 把一轮扫描结果报成日志（**boot 的首扫与 monitor 的每轮共用这一处判定**）。
 *
 * 判定（“只在新事件 / 首轮基线 / 失败时写；稳定态不写”）：
 *   · 正常跳过（`skipped` / `firstBoot`）：静默；只有 boot 首扫按老行为报一条 info；
 *   · 失败：`state.generate.failed`（error，不静默）；
 *   · 原始变更日志追加失败：`error.caught`（warn，不阻断状态写）；
 *   · 成功且（首扫 / 有变化 / 首轮基线）：`state.generate`（info）；
 *   · 其余（稳定态）：静默。
 *
 * @param {object|null} log
 * @param {object} result `scan()` 的返回值
 * @param {{workspaceKey?: string|null, initial?: boolean}} [o]
 * @returns {'silent'|'skip'|'generated'|'failed'|'thrown'}
 */
export function reportScanResult(log, result, o = {}) {
  const r = result && typeof result === 'object' ? result : null;
  const wk = o.workspaceKey !== undefined ? o.workspaceKey : workspaceKeyOf(r);
  const initial = o.initial === true;

  if (!r) {
    emit(log, 'state.generate.failed', '[milieu] 工作区扫描没有返回结果', {
      ok: false, code: CODES.STATE_SCAN_FAILED, blockedBy: 'state', workspaceKey: wk,
    });
    return 'failed';
  }

  // ① 首装等清单（老路径的正常首启状态）/ 配置边界导致的跳过：不是失败，不写错误。
  if (r.firstBoot === true) {
    if (initial) {
      emit(log, 'state.generate', '[milieu] 状态文件先不生成（' + String(r.reason || '等清单') + '）', {
        ok: true, workspaceKey: wk, data: { firstBoot: true },
      });
    }
    return 'skip';
  }
  if (r.skipped === true) return 'skip';

  // ② 失败：必须可见（不静默）。
  if (r.ok === false) {
    emit(log, 'state.generate.failed', '[milieu] 状态文件没能生成：' + String(r.reason || '未知原因'), {
      ok: false,
      code: r.code || CODES.STATE_SCAN_FAILED,
      blockedBy: BLOCKED_BYS.includes(r.blockedBy) ? r.blockedBy : 'state',
      workspaceKey: wk,
      error: r.error instanceof Error ? r.error : undefined,
    });
    return 'failed';
  }

  // ③ 原始变更日志追加失败：不阻断状态写，但必须报告（否则“原始日志少了”没人知道）。
  if (r.rawAppend && r.rawAppend.ok === false) {
    emit(log, 'error.caught', '[milieu] 原始变更日志追加失败（状态文件照写）：' + String(r.rawAppend.reason || '未知原因'), {
      level: 'warn',
      ok: false,
      code: r.rawAppend.code || CODES.STATE_WRITE_FAILED,
      blockedBy: BLOCKED_BYS.includes(r.rawAppend.blockedBy) ? r.rawAppend.blockedBy : 'fs',
      workspaceKey: wk,
    });
  }

  // ④ 成功：首扫 / 有新事件 / 首轮基线才写；稳定态静默（不每 60 秒刷一条）。
  // 注意 `changed` 只由 scan 给（boot 的 scan 会算好）；但**新事件本身就是变化**，
  // 这里再兜一次底——测试/别处注入的 scan 可能只给 freshEvents 不给 changed。
  const fresh = Array.isArray(r.freshEvents) ? r.freshEvents.length : 0;
  const changed = r.changed === true || r.firstRun === true || fresh > 0;
  if (initial || changed) {
    emit(log, 'state.generate', '[milieu] ' + String(r.summary || r.reason || '状态文件已更新'), {
      ok: true,
      workspaceKey: wk,
      data: {
        fresh: fresh > 0 ? fresh : (Number(r.fresh) || 0),
        firstRun: r.firstRun === true,
        wroteState: r.wroteState === true,
      },
    });
    return 'generated';
  }
  return 'silent';
}

/**
 * 启动工作区改动监控（**一个工作区一份**；由 `core/boot.js` 在 `autoState` 打开时调用）。
 *
 * @param {object} o
 *   · host    —— 宿主能力（只用 `onSessionEvent` 订阅轮次事件；没有就退回纯定时）
 *   · scan    —— `() => result`（boot 注入；同步或 async 均可）。result 形状见
 *                `reportScanResult`：至少 `{ok}`，有变化时 `{changed/firstRun/freshEvents}`。
 *   · criteria —— 读 `workspacePollMs`（缺省用 `DEFAULT_CRITERIA.workspacePollMs`）
 *   · log     —— `{event(name,message,fields)}`（`log/logger.js` 新形态）
 *   · enqueue —— 可选：串行队列的 `enqueue(fn)`（默认直通 `(fn) => fn()`）
 *   · timers  —— 可选注入：`{setInterval, clearInterval, setTimeout, clearTimeout}`
 *   · debounceMs —— 可选：turn/end 去抖窗口，默认 300ms
 * @returns {{stop:Function, tick:Function, initial:null}}
 *   · **不跑初始扫描**（boot 已做过），所以 `initial` 恒为 null；
 *   · `tick()` 手动触发一轮（不走 300ms 去抖），返回解析为该轮 scan 结果的 Promise；
 *     在飞时排队一次，解析为补跑那轮的结果；stop 后立即解析为 `{ok:false, skipped:'stopped'}`。
 *   · `stop()` 同步、幂等；清 timer / 去抖 / 监听，作废排队，忽略在飞结果。
 */
export function startWorkspaceMonitor(o = {}) {
  const scan = typeof o.scan === 'function' ? o.scan : null;
  const log = o.log || null;
  const timers = pickTimers(o.timers);
  const debounceMs = positiveMs(o.debounceMs, DEFAULT_DEBOUNCE_MS);
  const enqueue = typeof o.enqueue === 'function' ? o.enqueue : ((fn) => fn());
  const pollMs = positiveMs(
    o.criteria && o.criteria.workspacePollMs,
    positiveMs(DEFAULT_CRITERIA.workspacePollMs, 60 * 1000),
  );

  /** 停止后的统一结果。 */
  const stoppedResult = () => ({ ok: false, skipped: 'stopped', reason: '工作区监控已停止' });

  let stopped = false;
  let running = false;
  let queued = false;
  let queuedWaiters = [];
  let pollTimer = null;
  let debounceTimer = null;
  let disposeListener = null;

  function flushQueuedWaiters(result) {
    const waiters = queuedWaiters;
    queuedWaiters = [];
    for (const resolve of waiters) {
      try { resolve(result); } catch { /* 等待者坏了不影响别人 */ }
    }
  }

  /** 跑一轮（经共享队列；含异常归一，**永不 reject**）。 */
  async function runOnce() {
    if (stopped) return stoppedResult();
    if (!scan) {
      // 没注入扫描：如实报一次失败（调用方接线错了，不该静默）。
      const missing = { ok: false, reason: '工作区监控没有可用的 scan（boot 未注入）', code: CODES.CONFIG_INVALID, blockedBy: 'config' };
      reportScanResult(log, missing, { workspaceKey: null });
      return missing;
    }
    let result;
    try {
      result = await enqueue(() => {
        // **stop 后排队任务不执行**：队列不提供 cancel，由这一句保证。
        if (stopped) return stoppedResult();
        return scan();
      });
    } catch (err) {
      if (stopped) return stoppedResult();
      const reason = reasonOf(err);
      emit(log, 'error.caught', '[milieu] 工作区扫描抛错（已忽略，等待下一轮）：' + reason, {
        level: 'warn',
        ok: false,
        code: CODES.STATE_SCAN_FAILED,
        blockedBy: 'state',
        workspaceKey: null,
        error: err instanceof Error ? err : undefined,
      });
      return { ok: false, reason, code: CODES.STATE_SCAN_FAILED, blockedBy: 'state', thrown: true };
    }
    if (stopped) return stoppedResult(); // 在飞结果被忽略：不写日志、不碰状态
    reportScanResult(log, result, { workspaceKey: workspaceKeyOf(result) });
    return result;
  }

  /** 单飞驱动：一轮结束 → 有排队就补跑一次；否则解析排队者。 */
  async function drive() {
    // stop 之后任何路径（含已排队的补跑）都不许再跑：scan 会写文件，stop 后不该有副作用。
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
      // runOnce 设计上不抛；兜底保证 drive 永不 reject。
      result = { ok: false, reason: reasonOf(err), code: CODES.STATE_SCAN_FAILED, blockedBy: 'state' };
    } finally {
      running = false;
    }
    if (stopped) {
      queued = false;
      flushQueuedWaiters(stoppedResult());
      return stoppedResult();
    }
    if (queued) {
      queued = false;
      void drive(); // 补跑一次；它的结果解析给排队者
    } else {
      flushQueuedWaiters(result);
    }
    return result;
  }

  /** 事件 / 定时触发：不返回 Promise。 */
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

  /** `turn/end` → 去抖后触发。 */
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

  /** 停止：清计时器、去抖、事件监听，作废排队；幂等。 */
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
    flushQueuedWaiters(stoppedResult());
  }

  // ① 先挂长期触发（事件监听 + 低频定时）。**不跑初始扫描**：boot 已经扫过了。
  try {
    disposeListener = o.host && typeof o.host.onSessionEvent === 'function'
      ? o.host.onSessionEvent((session, event) => {
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

  return { stop, tick, initial: null };
}
