// dsh-milieu —— 发一次"读工作区"的请求（**只走平台自己的消息通道**）
//
// **2026-10-18 真机事故（journal/041）**：
//   我们曾手写 `{ role, content, source }` 直接塞给 `agent.followup`，缺平台要求的消息 id，
//   把会话写坏（`session event at seq 9 lacks an identified message`，整条会话打不开）。
//   **不要再手写消息**——平台要求消息由它自己建（补 id / 来源 / 排队）。
//
// 现在只有一条路：**`session/prompt`**。
//   · 宿主侧（建完预加载会话）：`sessionController.prompt(...)`，见 `preload-session.js`；
//   · 客户端点"重读"：`remote.prompt(...)`，就是本文件的 `promptReadViaRemote`。
import { buildReadText } from './texts.js';

export { buildPreloadText, buildRereadText, buildReadText, PRELOAD_SOURCE, REREAD_SOURCE } from './texts.js';

/**
 * 生成一个请求 id（`session/prompt` 需要）。
 * **不 import 宿主的 id 工具**（那会引入依赖）；用平台普遍可用的 `crypto.randomUUID`，
 * 没有就退到一个"时间 + 随机"的可用值。**id 的语义是"标识这次请求"，格式不重要。**
 */
export function makeRequestId() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch { /* 没有就算了 */ }
  return 'milieu-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * 走**现成的 `session/prompt` Remote** 把"读一遍"发进那条会话。
 *
 * 为什么用它而不是自己造：这是平台已有的接口（`@Remote('prompt')`），
 *   **客户端直接就能调**——不需要自建 Remote、不需要代码生成；
 *   而且平台会负责建消息、补 id、补来源、排队。**我们只给"要说什么"**。
 *
 * @param {object} o
 *   · remote   —— `ctx.remote.session`（有就够；没有就返回失败）
 *   · sessionId—— 目标会话
 *   · kind / changeIndex / libs / now
 *   · mode     —— 'queue'（默认，排队）| 'steer'
 * @returns {Promise<{ok:boolean, reason:string, text:string}>}
 */
export async function promptReadViaRemote(o = {}) {
  const { remote, sessionId, kind = 'reread', changeIndex, events, activityAt, libs, now = Date.now(), mode = 'queue', templates, criteria } = o;
  const text = buildReadText(kind, { changeIndex, events, activityAt, libs, now, templates, criteria });
  if (!remote || typeof remote.prompt !== 'function') {
    return { ok: false, reason: '没有 session.prompt Remote —— 发不出去', text };
  }
  if (!sessionId) return { ok: false, reason: '没有目标会话 id', text };
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
    return { ok: false, reason: '发送失败：' + String((err && err.message) || err), text };
  }
}
