// dsh-milieu —— 预加载会话的**身份、形状与选项组装**（纯模块：无宿主依赖、无副作用）
//
// 它只回答四件事（前两件**都是在 2026-10-14 查实了平台契约之后写的**，见 DEVELOPMENT.md「M5 的 API 契约」）：
//   ① 会话 id 长什么样 → `mintSessionId()`
//   ② 建会话/建 agent 要喂什么 → `buildAgentCreateOptions()` / `buildSessionCreateRequest()`
//   ③ 受管表里哪些是预加载会话 → `listPreloadSessions()` / `findPreloadSession()`
//   ④ 会话表怎么读 → `sessionListIndex()`；会话事件里哪条算"人在说话" → `isHumanMessage()`
//
// ③④ 是 2026-11 真机 bug 之后加的：**受管表里 role==='preload' 允许有多条**（历史遗留），
//   而"这个会话被用过没有"只能看**人**的消息——不看 `user/message` 这个外壳（见 `isHumanMessage`）。
//
// **不在这里做的事**：不调 `ctx.agents.create`、不读文件、不发消息——
// 那些是动作（`core/preload.js` 与宿主 `index.js`），判据与组装必须能脱离宿主验。
//
// 契约的两个要点（照抄平台，不发明）：
//   · `SessionId` 是**纯编译期品牌**（`Branded<'SessionId'>`）；官方 `brandString(v)` 的实现
//     就是 `return value`——所以**不引依赖**，直接给字符串，格式照平台：
//     `session-<uuid>`（平台自己的会话接口建会话/派生会话时就是这么造的）。
//   · 建 agent 的入参是 `{ sessionId, meta: { cwd }, agentOptions: {} }`：
//     `meta.cwd` 是**工作区根**（"fresh-session workspace metadata"）；
//     `agentOptions` 留空 = 用平台默认模型（我们**不指定模型**，那是用户/平台的事）。
import { randomUUID } from 'node:crypto';

/** 平台自己的会话 id 前缀（平台会话接口建的 id 就是这个形状）。 */
export const SESSION_ID_PREFIX = 'session-';

/**
 * 造一个会话 id。**格式照平台**：`session-<uuid>`。
 * @param {string} [uuid] 测试用；不给就现造一个 v4。
 */
export function mintSessionId(uuid) {
  const u = typeof uuid === 'string' && uuid ? uuid : randomUUID();
  return SESSION_ID_PREFIX + u;
}

/** 像不像一个能用的会话 id（我们自己造的 + 平台造的都要认）。 */
export function looksLikeSessionId(id) {
  return typeof id === 'string' && id.length > 8 && !/\s/.test(id);
}

/**
 * 生成一个请求 id（`session/prompt` 需要）。
 * **不 import 宿主的 id 工具**（那会引入依赖）；用平台普遍可用的 `crypto.randomUUID`，
 * 没有就退到一个"时间 + 随机"的可用值。**id 的语义是"标识这次请求"，格式不重要。**
 *
 * 说明（跨任务决定，2026-10-30）：本函数原样复制自 `actions.js`；B 的 `core/preload.js`
 * 与 C 的 `ui/remote.js` 都从这里引，保证"请求 id 只有一个家"。旧 `actions.js` 里的那份
 * 由 C 迁移时改为引用本文件。
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
 * `ctx.agents.create(...)` 的入参。
 * @param {object} o
 *   · sessionId  会话 id（不给就 mint 一个）
 *   · cwd        工作区根（写进 meta.cwd；拿不到就不写，交给平台默认）
 *   · agentPreset 可选的预设名（不给我们不写）
 *   · agentOptions 覆盖（默认空对象 = 平台默认模型）
 * @returns {object} 可直接喂给 `ctx.agents.create` 的对象
 */
export function buildAgentCreateOptions(o = {}) {
  const { sessionId, cwd, agentPreset, agentOptions } = o;
  const id = looksLikeSessionId(sessionId) ? sessionId : mintSessionId();
  const meta = {};
  if (typeof cwd === 'string' && cwd) meta.cwd = cwd;
  if (typeof agentPreset === 'string' && agentPreset) meta.agentPreset = agentPreset;
  return {
    sessionId: id,
    ...(Object.keys(meta).length ? { meta } : {}),
    agentOptions: agentOptions && typeof agentOptions === 'object' ? agentOptions : {},
  };
}

/**
 * 平台面那条路（Remote 的会话 create）的入参。
 * **注意**：`workspaceId` 与 `cwd` **只能给一个**（两个都给，平台会报 `gateway/bad-request`）。
 */
export function buildSessionCreateRequest(o = {}) {
  const { sessionId, cwd, workspaceId, agentPreset } = o;
  if (cwd && workspaceId) {
    throw new Error('session.create 只接受 workspaceId 或 cwd 之一，不能两个都给');
  }
  const req = {};
  if (looksLikeSessionId(sessionId)) req.sessionId = sessionId;
  if (typeof workspaceId === 'string' && workspaceId) req.workspaceId = workspaceId;
  else if (typeof cwd === 'string' && cwd) req.cwd = cwd;
  if (typeof agentPreset === 'string' && agentPreset) req.agentPreset = agentPreset;
  return req;
}

/**
 * 从受管会话表里找**预加载会话**（我们要认领/创建的那一条）。
 * 判据只有一处：`role === 'preload'`。
 * @returns {object|null} 那一条（含 sessionId / lastReadAt），没找到返回 null
 */
export function findPreloadSession(managedSessions) {
  return listPreloadSessions(managedSessions)[0] || null;
}

/**
 * 受管会话表里**所有**预加载记录（保持表序；表序即优先级）。
 *
 * 为什么是"所有"：老实现只认第一条，而受管表**允许历史上留下多条** `role==='preload'`
 * （重复启动、并发调度、旧版本写坏的账）。只认第一条 → 第二条永远留在表里，
 * 真机上表现为侧栏里冒出多条预加载会话，而且永远对不上账。
 * 对账（哪条真存在、保留哪条）是动作层的事；这里只负责把候选**照表序**列出来。
 *
 * @param {Array} managedSessions 受管会话表（可能是任意坏输入）
 * @returns {Array<{sessionId:string, role:string, source:string|null}>} 表序
 */
export function listPreloadSessions(managedSessions) {
  const list = Array.isArray(managedSessions) ? managedSessions : [];
  return list.filter((e) => e && e.role === 'preload' && looksLikeSessionId(e.sessionId));
}

/**
 * 把 `host.session.list()` 的行归一成"存在性 + 活动时间"索引（纯函数，便于离线验）。
 *
 * 行形状是能力契约（adapter 已归一成 `[{id, updatedAt}]`）；这里再容错 `sessionId` /
 * 非数字时间两种拼法——**形状差异不该变成"没有会话"**，那会让对账把真会话清掉。
 *
 * @param {Array} rows `host.session.list()` 的值（`[{id, updatedAt}]`）
 * @returns {{ids: Set<string>, updatedAt: Map<string, number>}}
 */
export function sessionListIndex(rows) {
  const ids = new Set();
  const updatedAt = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' && row.id ? row.id
      : (typeof row.sessionId === 'string' ? row.sessionId : '');
    if (!looksLikeSessionId(id)) continue;
    ids.add(id);
    // 没有可用时间就不记：调用方靠"查不到时间"走保守分支，而不是拿 0 当"很久没动"。
    if (typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)) updatedAt.set(id, row.updatedAt);
  }
  return { ids, updatedAt };
}

/**
 * 这条会话事件是不是"**人**在说话"？
 *
 * 为什么不能只看 `type === 'user/message'`（2026-11 真机 bug）：`user/message` 只是**外壳**——
 * 插件自己发的预加载阅读请求、平台注入的提示，都可能以 `user/message` 落进会话日志。
 * 老实现按"所有 user/message"计数，于是**只有 1 条人类消息的预加载会话被判成"用过了"**，
 * 每次启动都把它毕业、再建一条新的（会话列表越滚越多）。
 * 真正的"人在用"必须看来源：`data.source.kind === 'user'`。
 * 预加载那次阅读请求恰好贡献 1 条 → `used = 人类消息数 > 1`。
 *
 * @param {object} event 会话事件（`inspect` 返回的 `events` 里的一条）
 * @returns {boolean}
 */
export function isHumanMessage(event) {
  if (!event || event.type !== 'user/message') return false;
  const source = event.data && event.data.source;
  return !!(source && source.kind === 'user');
}
