// dsh-milieu —— 读状态文件（界面层：只读、不判断、不渲染）
//
// 位置：`<认知库>/review/milieu-state.json`（宿主写、这里**只读**）。
// 责任边界（ARCHITECTURE.md 工作包 C）：两种 `remote.read` 签名、`{ok, value}` 拆包、读超时
//   都在这里；这里**不做**"该不该弹"的判断（在 `ui/card-criteria.js`）。
//
// 读不到 / 超时 / 报错，一律当"没有"——不弹、不崩。
//   **文件不存在是正常情况**（宿主还没生成），所以只记诊断、不算错误。
//
// 日志（task-8）：关键失败接**结构化事件**（`ui.read.failed` / `error.caught`），
//   经调用方传入的 `event` 口写进客户端内存日志；**不改**原有 reason / 返回值 / 日志文案。
//   失败事件每个读取器**最多记一次**（轮询每次失败都记会刷屏，也会挤掉内存缓冲里的其他记录）。
//
// 扩展点由调用方（`ui/plugin.js`）包成 `getRemote` 传进来：本文件不 import ctx，也不写 DOM。
import { guardAsync } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';

/** 状态文件在**认知库**里的相对路径。宿主写、这里读。 */
export const STATE_REL_PATH = 'review/milieu-state.json';

/**
 * 造一个状态文件读取器。
 * @param {object} deps
 *   · getRemote    —— 取 `ctx.remote`（调用方负责，真环境读未声明属性会抛错）
 *   · getTimeoutMs —— 取读超时（判据来自状态文件；读之前用默认值）
 *   · log          —— (level, msg) => void；日志失败不影响读取
 *   · event        —— (eventName, message, fields) => void；结构化日志（LOG-SCHEMA 事件）
 * @returns {{ read: (sessionId: string) => Promise<string|null>, last: () => object }}
 *          `last()` 是最近一次读的结果（`{ok:true,via}` / `{ok:false,reason}`），给调试行用
 */
export function createStateReader({ getRemote, getTimeoutMs, log = () => {}, event = () => {} }) {
  // 最近一次读状态文件的结果（诊断行用；也帮我们确认签名/路径）
  let lastRead = { ok: false, reason: 'not tried' };
  // 失败事件**每个读取器最多一条**（先到先得；轮询失败不刷屏）
  let readFailureNoted = false;

  /** 记一条 `ui.read.failed`（首个失败才记；event 自己坏了也不能影响读取）。 */
  function noteReadFailure(message, data) {
    if (readFailureNoted) return;
    readFailureNoted = true;
    try {
      event('ui.read.failed', message, { ok: false, code: CODES.UI_READ_FAILED, blockedBy: 'ui', data });
    } catch {
      /* 结构化日志自己坏了：读取结果不受影响 */
    }
  }

  /** 读一次（内部实现：所有已知失败都返回 null，不抛）。 */
  async function readOnce(sessionId) {
    let remote;
    try { remote = getRemote(); } catch { remote = undefined; }
    const files = remote && remote.workspaceFiles;
    if (!files || typeof files.read !== 'function') {
      lastRead = { ok: false, reason: 'no workspaceFiles remote' };
      log('info', '没有 workspaceFiles Remote —— 将不弹卡');
      noteReadFailure('状态文件读取失败，本次不弹卡', { reason: 'no-remote' });
      return null;
    }
    // 超时走判据（默认 4 秒）；拿不到数值就不带 signal，交给 Remote 自己的默认。
    const timeoutMs = typeof getTimeoutMs === 'function' ? getTimeoutMs() : undefined;
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout && typeof timeoutMs === 'number'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    // 官方文档形状是 `read(path, { offset?, limit? })`；旧代码写的是 `read(sessionId, path, …)`。
    // **两种都试**，谁先成功用谁；失败原因留给诊断行。
    const attempts = [
      ['read(path, opts)', () => files.read(STATE_REL_PATH, {}, signal)],
      ['read(sessionId, path, opts, signal)', () => files.read(sessionId, STATE_REL_PATH, {}, signal)],
    ];
    let lastErr = null;
    for (const [label, call] of attempts) {
      try {
        const res = await call();
        // 真机返回的是 **Remote 包装**：{ ok: true, value: { absolutePath, version, text, … } }
        const v = (res && res.ok === true && res.value) ? res.value : res;
        let text = null;
        if (typeof v === 'string') text = v;
        else if (v && v.kind === 'text' && typeof v.text === 'string') text = v.text;
        else if (v && typeof v.text === 'string') text = v.text;
        if (text !== null) { lastRead = { ok: true, via: label }; return text; }
        lastErr = label + ': shape=' + JSON.stringify(res).slice(0, 120);
      } catch (err) {
        lastErr = label + ': ' + String((err && err.message) || err);
      }
    }
    lastRead = { ok: false, reason: lastErr || 'unknown' };
    // 文件不存在是**正常情况**（还没生成），不是错误——但读不到就是"本次读失败"，事件照记；
    // 旧日志文案保持 info（既有可见行为不变）。
    log('info', '读状态文件未成功（通常是没有这个文件）：' + lastRead.reason);
    noteReadFailure('状态文件读取失败，本次不弹卡', { reason: String(lastRead.reason).slice(0, 200) });
    return null;
  }

  /**
   * 读状态文件（异常边界）：已知失败已由 `readOnce` 当"没有"处理；
   * 意料之外的 throw 也不能把界面搞崩——归一、记一条 info（可选步骤，fail-open），返回 null。
   */
  async function read(sessionId) {
    const result = await guardAsync('读状态文件', () => readOnce(sessionId), {
      optional: true,
      log,
      code: CODES.UI_READ_FAILED,
      blockedBy: 'ui',
    });
    if (result && result.ok === false && result.code) {
      lastRead = { ok: false, reason: result.reason };
      // 意料之外的异常：guard 已报告一次；这里再补一条结构化 `error.caught`
      //   （不改返回值：调用方拿到的仍是 null，调试行也照旧）。
      try {
        const fields = {
          ok: false,
          code: result.code,
          blockedBy: result.blockedBy || 'ui',
          data: { reason: String(result.reason || '').slice(0, 200) },
        };
        if (result.cause !== undefined) fields.error = result.cause;
        event('error.caught', '读状态文件时捕获异常（已跳过）', fields);
      } catch {
        /* 结构化日志自己坏了：读取结果不受影响 */
      }
      return null;
    }
    return result === undefined ? null : result;
  }

  return { read, last: () => lastRead };
}
