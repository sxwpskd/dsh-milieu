// dsh-milieu —— 界面半边：发一次"读工作区"的请求（**只走平台自己的消息通道**）
//
// **2026-10-18 真机事故（journal/041）**：
//   我们曾手写 `{ role, content, source }` 直接塞给 `agent.followup`，缺平台要求的消息 id，
//   把会话写坏（`session event at seq 9 lacks an identified message`，整条会话打不开）。
//   **不要再手写消息**——平台要求消息由它自己建（补 id / 来源 / 排队）。
//
// 现在只有一条路：**`session/prompt`**。
//   · 宿主半边（建完预加载会话）：走平台自己的 prompt 通道，见 `core/preload.js` 与 `adapter/`；
//   · 客户端点"重读"：`ctx.remote.session.prompt`，就是本文件的 `promptReadViaRemote`。
//
// 请求 id 的生成只有一个家（`../model/session.js` 的 `makeRequestId`）：宿主与界面都要用。
// 文本拼装也只有一个家（`../core/texts.js` 的 `buildReadText`）：本文件只负责"发"。
//
// 日志（task-8）：失败接**结构化事件** `error.caught`（经调用方传入的 `event` 口写进客户端内存日志）；
//   **不改** reason 文案与返回形状——失败该怎么报还怎么报，只是多一条机器可读的日志。
import { buildReadText } from '../core/texts.js';
import { makeRequestId } from '../model/session.js';
import { guardAsync } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';

/**
 * 走**现成的 `session/prompt` Remote** 把"读一遍"发进那条会话（对外入口，**永不 reject**）。
 *
 * 异常边界（task-5）：已知的发送失败仍由内部实现返回 `{ok:false, reason, text}`（文案不变）；
 * 意料之外的 throw 归一成 `{ok:false, code, reason, blockedBy}` 并报一次，不抛到点击回调里。
 *
 * @param {object} o
 *   · remote   —— `ctx.remote.session`（有就够；没有就返回失败）
 *   · sessionId—— 目标会话
 *   · kind / changeIndex / events / activityAt / libs / now
 *   · mode     —— 'queue'（默认，排队）| 'steer'
 * @returns {Promise<{ok:boolean, reason:string, text?:string}>}
 */
export async function promptReadViaRemote(o = {}) {
  const event = o && typeof o.event === 'function' ? o.event : null;
  const result = await guardAsync('发送重读请求', () => promptReadViaRemoteOnce(o), {
    optional: false,
    log: o && o.log ? o.log : null,
    code: CODES.UI_SEND_FAILED,
    blockedBy: 'ui',
  });
  // 边界捕获（buildReadText 之类意外 throw）：补一条结构化 `error.caught`；返回形状不变。
  if (event && result && result.ok === false && result.code) {
    notifyCaught(event, '发送重读请求时捕获异常（已归一为失败结果）', {
      code: result.code,
      blockedBy: result.blockedBy || 'ui',
      reason: 'threw',
      cause: result.cause,
    });
  }
  return result;
}

/** 记一条 `error.caught`（event 自己坏了也不能影响发送；字段不改变返回值）。 */
function notifyCaught(event, message, extra = {}) {
  try {
    const fields = {
      ok: false,
      code: extra.code || CODES.UI_SEND_FAILED,
      blockedBy: extra.blockedBy || 'ui',
      data: { reason: extra.reason || 'send-failed' },
    };
    if (extra.cause !== undefined) fields.error = extra.cause;
    event('error.caught', message, fields);
  } catch {
    /* 结构化日志自己坏了：发送结果不受影响 */
  }
}

/** 发送内部实现（失败返回报告，不抛）。 */
async function promptReadViaRemoteOnce(o = {}) {
  const { remote, sessionId, kind = 'reread', changeIndex, events, activityAt, libs, now = Date.now(), mode = 'queue', templates, criteria } = o;
  const event = typeof o.event === 'function' ? o.event : null;
  const text = buildReadText(kind, { changeIndex, events, activityAt, libs, now, templates, criteria });
  if (!remote || typeof remote.prompt !== 'function') {
    if (event) notifyCaught(event, '发送重读请求失败：缺少 session.prompt Remote', { reason: 'no-remote' });
    return { ok: false, reason: '没有 session.prompt Remote —— 发不出去', text };
  }
  if (!sessionId) {
    if (event) notifyCaught(event, '发送重读请求失败：没有目标会话 id', { reason: 'no-session' });
    return { ok: false, reason: '没有目标会话 id', text };
  }
  try {
    const res = await remote.prompt({
      requestId: makeRequestId(),
      sessionId,
      mode,
      content: [{ type: 'text', text }],
      clientTimeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })(),
    });
    return { ok: true, reason: '已发出（' + kind + '）' + (res && res.messageId ? '，消息 ' + res.messageId : ''), text };
  } catch (err) {
    if (event) notifyCaught(event, '发送重读请求失败：捕获异常', { reason: 'threw', cause: err });
    return { ok: false, reason: '发送失败：' + String((err && err.message) || err), text };
  }
}
