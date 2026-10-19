// dsh-milieu —— 状态文件（宿主写、客户端读的**唯一一份材料**）
//
// 为什么要有这个文件：判据只能有一处。宿主算变更（要读文件系统），客户端只显示。
// 位置：`<认知库>/milieu-state.json`
// 作者：**宿主**（由 tools/milieu-state.mjs 生成）。**客户端只读它，绝不写。**
// 依赖：**只依赖 `changes.js`**（六个桶与计数由事件流派生）——判据与目录都不在这里重写。
import { project } from './changes.js';
import { DEFAULT_CRITERIA, mergeCriteria } from './criteria.js';

// 形状（版本化：变了就升 stateVersion，旧的按旧的读）：
// {
//   "stateVersion": 3,
//   "generatedAt": 1791800000000,
//   "workspaceKey": "d:/dsh",
//   "libs": { "review": "review", "tools": "tools", "external": "external" },
//   "managedSessions": [ { "sessionId": "…", "role": "preload", "source": "preload" } ],
//   "events": [ { "path": "review/a.md", "kind": "changed", "time": 1791700000000,
//                 "before": 1024, "after": 1144, "delta": 120 } ],   // **唯一事实**
//   "archived": 0,                                                   // 有界：更早的压掉了多少条
//   "changeIndex": { … 六个桶 … },   // **投影**：由 events 算出来（字段留着，界面直接可用）
//   "counts":      { added, changed, gone }   // **投影**
// }
//
// **为什么事件流是唯一源头**（2026-10-16 主人定）：六个桶与计数也描述"变了什么"，
//   若各算各的，同一个"变了 5 个"会有两处说法，而且**不一致时不报错**。
//   所以：events 是事实，changeIndex / counts 是它的**投影**——只允许一处算法（`changes.js` 的 `project()`）。
//
// **名单丢了会失忆**（主人定：不兜底）：这张表是我们自己写在工作区里的账，
//   它没了就认不回自己的会话；不做"扫标题/扫 cwd 重新认领"的兜底。

export const STATE_FILE = 'milieu-state.json';
export const STATE_VERSION = 3;

/** 受管会话的角色（先留这两种；将来有别的再加）。 */
export const ROLES = ['preload', 'active'];

/** 造一个空状态（宿主还没写过时用它）。 */
export function emptyState(now = Date.now()) {
  return {
    stateVersion: STATE_VERSION,
    generatedAt: now,
    workspaceKey: null,
    libs: { review: 'review', tools: 'tools', external: 'external' },
    managedSessions: [],
    events: [],
    archived: 0,
    changeIndex: { reviewAdded: [], reviewChanged: [], reviewGone: [], otherAdded: [], otherChanged: [], otherGone: [] },
    counts: { added: 0, changed: 0, gone: 0 },
    // **生效的判据阈值**：宿主写、客户端读。客户端拿它弹卡/选视图，不再各写一份默认值。
    criteria: mergeCriteria(DEFAULT_CRITERIA),
  };
}

/** 归一事件流：字段只有五个，多的一律不要；扔坏条目。 */
export function normalizeEvents(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const path = typeof raw.path === 'string' ? raw.path.replace(/\\/g, '/') : '';
    if (!path) continue;
    if (!['created', 'changed', 'gone'].includes(raw.kind)) continue;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const before = num(raw.before), after = num(raw.after);
    out.push({
      path,
      kind: raw.kind,
      time: num(raw.time),
      before,
      after,
      delta: num(raw.delta) !== null ? num(raw.delta) : (after === null ? 0 : after) - (before === null ? 0 : before),
    });
  }
  return out;
}

/**
 * 归一受管会话表：去重（同一 sessionId 只留一条，后者覆盖前者）、扔掉不像话的。
 * **去重规则只有这一处**，别处一律调它。
 */
export function normalizeManagedSessions(list) {
  const out = [];
  const at = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
    if (!id) continue;
    const entry = {
      sessionId: id,
      role: ROLES.includes(raw.role) ? raw.role : 'active',
      source: typeof raw.source === 'string' && raw.source ? raw.source : null,
    };
    if (at.has(id)) out[at.get(id)] = entry;      // 后来者覆盖同 id 的旧条目
    else { at.set(id, out.length); out.push(entry); }
  }
  return out;
}

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
  const empty = emptyState();
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
 * **注意：变更索引的"归一"只有一个家在 `core.js`**（`normalizeChangeIndex`）。
 * 这里原来也有一份，属于"同一件事两个版本"——已被删掉。
 * 需要归一的地方**从 core.js 引**，别在这儿重新发明。
 */

/** 汇总成给人看的计数（卡片标题用）。 */
export function changeTotals(changeIndex) {
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  const ci = changeIndex || {};
  const review = n(ci.reviewAdded) + n(ci.reviewChanged) + n(ci.reviewGone);
  const other = n(ci.otherAdded) + n(ci.otherChanged) + n(ci.otherGone);
  return { review, other, total: review + other };
}
