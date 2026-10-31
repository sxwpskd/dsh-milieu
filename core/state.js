// dsh-milieu —— 状态文件的**解析与选择器**（纯模块：不定义形状、不读写文件）
//
// 为什么要有这个文件：判据只能有一处。宿主算变更（要读文件系统），客户端只显示。
// 位置：`<认知库>/milieu-state.json`
// 作者：**宿主**（由 `milieu-state.js` 生成）。**客户端只读它，绝不写。**
// 依赖：形状在 `../model/state.js`；投影算法在 `./changes.js`（这里不重写）。
import { project } from './changes.js';
import { emptyState, normalizeEvents, normalizeManagedSessions } from '../model/state.js';
import { STATE_VERSION } from '../constant/state.js';
import { DEFAULT_CRITERIA, mergeCriteria } from '../config/criteria.js';

/**
 * 解析客户端读到的文本。**任何异常都返回 null，不抛**——
 * 客户端读到一个坏文件时，正确行为是"什么都别弹"，不是把页面搞崩。
 */
export function parseState(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.stateVersion !== STATE_VERSION) return null;   // 版本不认识 → 当没有
  const empty = emptyState(Date.now(), mergeCriteria(DEFAULT_CRITERIA));
  const events = normalizeEvents(raw.events);
  // **六个桶与计数由事件流派生**——不接受文件里自带的那份（同一件事只许一处算法）。
  const derived = project(events, { ...empty.libs, ...(raw.libs || {}) });
  return {
    ...empty,
    ...raw,
    libs: { ...empty.libs, ...(raw.libs || {}) },
    managedSessions: normalizeManagedSessions(raw.managedSessions),
    events,
    archived: typeof raw.archived === 'number' && raw.archived > 0 ? raw.archived : 0,
    changeIndex: derived.changeIndex,
    counts: derived.counts,
    criteria: mergeCriteria(DEFAULT_CRITERIA, raw.criteria),
  };
}

/** 受管会话的 id 列表（"这条会话归不归我们管"用的就是它）。 */
export function managedIds(state) {
  return (state && Array.isArray(state.managedSessions) ? state.managedSessions : []).map((e) => e.sessionId);
}

/** 这条会话归不归我们管。 */
export function isManaged(state, sessionId) {
  return managedIds(state).includes(sessionId);
}

/** 这个变更索引里到底有没有东西（客户端判断"要不要弹"的第一道关）。 */
export function hasChanges(changeIndex) {
  if (!changeIndex || typeof changeIndex !== 'object') return false;
  for (const v of Object.values(changeIndex)) if (Array.isArray(v) && v.length) return true;
  return false;
}

/**
 * **注意：变更索引的"归一"只有一个家在 `core/criteria.js`**（`normalizeChangeIndex`）。
 * 别处不许再写一份——"同一件事两个版本"曾经让"有变化"静默变成"没变化"。
 */

/** 汇总成给人看的计数（卡片标题用）。 */
export function changeTotals(changeIndex) {
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  const ci = changeIndex || {};
  const review = n(ci.reviewAdded) + n(ci.reviewChanged) + n(ci.reviewGone);
  const other = n(ci.otherAdded) + n(ci.otherChanged) + n(ci.otherGone);
  return { review, other, total: review + other };
}
