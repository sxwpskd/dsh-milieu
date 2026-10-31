// dsh-milieu —— 状态文件的**形状与归一**（纯模块：不判断业务、不解析文本、不读写文件）
//
// 为什么要有这个文件：判据只能有一处。宿主算变更（要读文件系统），客户端只显示。
// 位置：`<认知库>/milieu-state.json`
// 作者：**宿主**（由 `milieu-state.js` 生成）。**客户端只读它，绝不写。**
// 依赖：只有 `constant/state.js`——形状与常量不在这里之外再造一份。
import { STATE_VERSION, ROLES } from '../constant/state.js';

// 形状（版本化：变了就升 stateVersion，旧的按旧的读）：
// {
//   "stateVersion": 3,
//   "generatedAt": 1791800000000,
//   "workspaceKey": "d:/work",
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
//   所以：events 是事实，changeIndex / counts 是它的**投影**——只允许一处算法（`core/changes.js` 的 `project()`）。
//
// **名单丢了会失忆**（主人定：不兜底）：这张表是我们自己写在工作区里的账，
//   它没了就认不回自己的会话；不做"扫标题/扫 cwd 重新认领"的兜底。

/**
 * 造一个空状态（宿主还没写过时用它）。
 *
 * `criteria` 由调用方传进来（**本层不 import config/**）：宿主/解析层把生效判据叠进来；
 * 拿不到时留空对象——读的人会再用 `mergeCriteria(DEFAULT_CRITERIA, …)` 兜底。
 * @param {number} [now] 生成时间（毫秒）
 * @param {object} [criteria] 生效判据（形状见 `config/criteria.js`）
 */
export function emptyState(now = Date.now(), criteria = {}) {
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
    criteria: criteria && typeof criteria === 'object' && !Array.isArray(criteria) ? { ...criteria } : {},
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
