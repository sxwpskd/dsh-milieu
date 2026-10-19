// dsh-milieu —— 客户端判据（纯函数，无副作用，可离线测）
//
// 它只回答一件事：**这张卡该不该弹。**
// 阈值判据**复用 core.js 的 `shouldPromptOnReturn`**——判断只能有一处，这里不另写一份。
//
// 不在这里做的事（各归各处）：
//   · 算变更 → 宿主（要读文件系统），结果落在 state.js 描述的状态文件里；
//   · 画界面 → card.js；
//   · 读文件 → client.js（用现成的 workspaceFiles Remote）。
import { shouldPromptOnReturn, evaluateInvalidation, PROMPT_THRESHOLD_MS, normalizeChangeIndex } from './core.js';
import { parseState, hasChanges, changeTotals, managedIds } from './state.js';
import { DEFAULT_CRITERIA } from './criteria.js';

/** 客户端自己记的"这条会话弹过了"（**只活在页面里**，不进工作区）。 */
export const CLIENT_MEMORY_LIMIT = DEFAULT_CRITERIA.clientMemoryLimit;

/** 记一次"弹过了"。返回新对象（不改原对象）。`limit` 可被状态文件里的 criteria 覆盖。 */
export function markShown(memory, sessionId, at, limit = CLIENT_MEMORY_LIMIT) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : CLIENT_MEMORY_LIMIT;
  const m = { ...(memory || {}) };
  m[sessionId] = at;
  const keys = Object.keys(m);
  if (keys.length > cap) {
    const drop = keys.sort((a, b) => (m[a] || 0) - (m[b] || 0)).slice(0, keys.length - cap);
    for (const k of drop) delete m[k];
  }
  return m;
}

/** 这条会话弹过了吗？（"一次只提示一次"） */
export function alreadyShown(memory, sessionId) {
  return !!(memory && Object.prototype.hasOwnProperty.call(memory, sessionId));
}

const NO = (reason) => ({ show: false, reason });

/**
 * 该不该弹卡？
 *
 * 判据链（逐关判；任何一关不过就**什么都不做**）：
 *   ① 这条会话是**我们管的**（在状态文件的 `managedSessions` 表里，唯一依据 = sessionId）——不是我们的一律不碰；
 *   ② **这一轮已经弹过就不弹**（"只提示一次"）；
 *   ③ 工作区**确实变了**（没变就"什么都没有"）；
 *   ④ 变化**够不够大**：结构（新增+消失）≥ `structuralThreshold`，或内容（改动）≥ `contentThreshold`；
 *   ⑤ **距这条会话最后活动 ≥ `promptThresholdMs`**（core.js 的 `shouldPromptOnReturn`）。
 *
 * 第 ④ 关就是“重读阈值”的另一半：**不只是时间，还要变化数量够**。
 * 第 ⑤ 关的基准是**这条会话自己的活动时间**（平台会话列表里的"最后更新时间"），
 * **不是**我们另记的"上次读"。理由（主人 2026-10-16，收成判据）：
 *   **只在用会话，改动基本可以忽略**——用户在使用中能接受的改动，AI 自然也能接受；
 *   会话搁置了才需要提醒"变了，要不要重读"。
 *
 * @param {string} currentSessionId 当前正在看的会话 id
 * @param {string} stateText 状态文件原文（客户端读到的字符串）
 * @param {object} memory 客户端记忆（弹过哪些）
 * @param {{now?:number, thresholdMs?:number, criteria?:object, activityAt?:number|null}} [opts]
 *        `activityAt` = 这条会话的最后活动时间（毫秒）；拿不到就传 null → 走"保守提示"
 *        `criteria` = 生效阈值（没有就用 `DEFAULT_CRITERIA`）
 */
export function shouldShowCard(currentSessionId, stateText, memory, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const criteria = opts.criteria || DEFAULT_CRITERIA;
  // **不能用 `||`**：`0` 是合法阈值（测试时会把阈值临时改成 0），`0 || 默认值` 会把它吞掉。
  const thresholdMs = typeof opts.thresholdMs === 'number'
    ? opts.thresholdMs
    : (typeof criteria.promptThresholdMs === 'number' ? criteria.promptThresholdMs : PROMPT_THRESHOLD_MS);
  const activityAt = typeof opts.activityAt === 'number' ? opts.activityAt : null;
  const state = parseState(stateText);

  // ① 有没有可用的材料、知不知道当前是哪条会话
  if (state === null || !currentSessionId) return NO('没有可用的状态或会话身份');

  // ② 归属：不是我们管的，一律不碰
  if (!managedIds(state).includes(currentSessionId)) return NO('这条会话不归我们管');

  // ③ 一次只提示一次
  if (alreadyShown(memory, currentSessionId)) return NO('这一轮已经提示过了');

  // ④ 没变就什么都没有
  if (!hasChanges(state.changeIndex)) return NO('工作区没有变化');

  // ⑤ 变化够不够大：先用 normalizeChangeIndex **归一**，再交给 core.js 的判据。
  //    这一步曾经漏掉过——两套字段名让"有变化"变成了"没变化"，自测当场抓住。
  const flat = normalizeChangeIndex(state.changeIndex);
  const inv = evaluateInvalidation(flat, null, criteria);
  if (!inv.prompt) return NO(inv.reason);

  // ⑥ 时间够不够久：距这条会话最后活动 ≥ 阈值。
  const gate = shouldPromptOnReturn(activityAt, flat, now, thresholdMs);
  if (!gate.prompt) return NO(gate.reason);

  return { show: true, reason: gate.reason, changeIndex: state.changeIndex, totals: changeTotals(state.changeIndex) };
}
