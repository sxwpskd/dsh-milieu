// 本文件由 tools/build-client.mjs 从 <包>/ 下列 24 个模块按序拼接生成：
//   constant/state.js , config/criteria.js , utils/path.js , model/state.js , model/session.js , core/changes.js , core/criteria.js , core/views.js , core/state.js , core/texts.js , exception/codes.js , exception/normalize.js , exception/guard.js , log/schema.js , log/memory-sink.js , log/logger.js , ui/card.js , ui/card-criteria.js , ui/activity.js , ui/state-reader.js , ui/remote.js , ui/error-boundary.js , ui/plugin.js , client.js
// **不要手改**：改源码后重跑 `node tools/build-client.mjs`。 src=e1c4c9f87c32
(function () {
"use strict";

// ===== constant/state.js =====
// dsh-milieu —— 状态文件的固定值（不随部署变化；可调阈值在 config/criteria.js）
//
// 位置：<认知库>/milieu-state.json

/** 状态文件名（宿主写、客户端读的**唯一一份材料**）。 */
const STATE_FILE = 'milieu-state.json';

/** 状态文件版本：形状变了就升；客户端的 parseState 只认这个版本。 */
const STATE_VERSION = 3;

/** 受管会话的角色（先留这两种；将来有别的再加）。 */
const ROLES = ['preload', 'active'];


// ===== config/criteria.js =====
// dsh-milieu —— **判据与显示阈值的唯一默认值表** + 合并逻辑
//
// 为什么单独一个文件：这些数**宿主和客户端都要用**——
//   · 宿主：建会话、写状态、生成事件流；
//   · 客户端：弹卡、选视图、轮询。
// 两边各写一份 = "同一件事两个版本"（这个工作区最怕的那种错）。
// 所以：**默认值只在这里**；宿主把**生效值**写进 `milieu-state.json` 的 `criteria` 字段，
// 客户端读同一份。配置覆盖走 `Config.criteria`（宿主）；客户端跟随状态文件。
//
// **纯模块、零 import**：core / changes / views / state / client 都能引，不产生环。
//
// 字段分四组：
//   判据（core/criteria.js）      structuralThreshold / contentThreshold / staleHintDays / promptThresholdMs / readiness / fingerprint
//   台账（core/changes.js）       eventKeepDays / eventKeepCount
//   视图（core/views.js）         staleDays / staleMaxReview
//   客户端 / 宿主                 clientMemoryLimit / pollMs / readTimeoutMs / agentLoopWaitMs
const DEFAULT_CRITERIA = {
  // ---- 判据：要不要"再读一遍"（core/criteria.js） ----
  structuralThreshold: 1,          // 新增/消失几个就重读
  contentThreshold: 5,             // 改动几个就重读
  staleHintDays: 30,               // 距上次阅读超过这么多天 → 只提示，不重读
  promptThresholdMs: 5 * 60 * 1000, // 距这条会话最后活动 ≥ 5 分钟才弹卡

  // ---- 判据：认知库"建立完成"的门槛（core/criteria.js 的 evaluateReadiness） ----
  readiness: {
    minFiles: 10,                  // 文件数 ≥ 10
    minBytes: 10 * 1024,           // 总大小 ≥ 10 KB
    windowMs: 5 * 60 * 1000,       // 观察窗：5 分钟
    maxGrowthRate: 0.30,           // 窗内新增速度 < 30%
    maxChangedRatio: 0.20,         // 窗内变动占比 < 20%
  },

  // ---- 判据：会话指纹保留策略（core/criteria.js 的 planFingerprintRetention） ----
  fingerprint: {
    keepDays: 1,                   // 最近 1 天
    keepRecent: 5,                 // ∪ 最近 5 条
  },

  // ---- 台账：事件流有界（core/changes.js 的 boundEvents） ----
  eventKeepDays: 30,               // 保留最近 30 天
  eventKeepCount: 500,             // ∪ 最近 500 条

  // ---- 视图：超过这么久没用 → 只给文件名（core/views.js） ----
  staleDays: 30,
  staleMaxReview: 20,              // 认知库最多列 20 条，超过写"改动过大"

  // ---- 客户端（client.js / ui/card-criteria.js） ----
  clientMemoryLimit: 20,           // 客户端记住"弹过"的会话数
  pollMs: 2000,                    // 盯当前会话的轮询间隔
  readTimeoutMs: 4000,             // 读状态文件的超时
  debug: false,                    // 客户端在 turnTail 里渲染一行自报状态（排查用，平时关）

  // ---- 宿主（index.js） ----
  agentLoopWaitMs: 10000,          // 等 agentLoop 的兜底尝试
};

/**
 * 把覆盖值叠到基准上（只深合并 `readiness` / `fingerprint` 两组）。
 * **坏输入不抛**：不是对象的覆盖值直接忽略。
 */
function mergeCriteria(base = DEFAULT_CRITERIA, override = {}) {
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base : DEFAULT_CRITERIA;
  const o = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
  return {
    ...b,
    ...o,
    readiness: { ...(b.readiness || {}), ...(o.readiness || {}) },
    fingerprint: { ...(b.fingerprint || {}), ...(o.fingerprint || {}) },
  };
}


// ===== utils/path.js =====
// dsh-milieu —— 路径归一（纯工具：不读文件、不访问宿主、不改全局状态）

/**
 * 工作区身份：同一个 cwd 就是同一个工作区（插件拿不到 workspaceId，只拿得到 cwd）。
 * @param {string} cwd
 * @returns {string|null} 归一键，拿不到返回 null
 */
function workspaceKey(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  // 统一分隔符与大小写：Windows 上同一个目录常有不带盘符大小写 / 斜杠方向两种写法
  return cwd.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}


// ===== model/state.js =====
// dsh-milieu —— 状态文件的**形状与归一**（纯模块：不判断业务、不解析文本、不读写文件）
//
// 为什么要有这个文件：判据只能有一处。宿主算变更（要读文件系统），客户端只显示。
// 位置：`<认知库>/milieu-state.json`
// 作者：**宿主**（由 `milieu-state.js` 生成）。**客户端只读它，绝不写。**
// 依赖：只有 `constant/state.js`——形状与常量不在这里之外再造一份。


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
function emptyState(now = Date.now(), criteria = {}) {
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
function normalizeEvents(list) {
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
function normalizeManagedSessions(list) {
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


// ===== model/session.js =====
// dsh-milieu —— 预加载会话的**身份与选项组装**（纯模块：无宿主依赖、无副作用）
//
// 它只回答两件事（**都是在 2026-10-14 查实了平台契约之后写的**，见 DEVELOPMENT.md「M5 的 API 契约」）：
//   ① 会话 id 长什么样 → `mintSessionId()`
//   ② 建会话/建 agent 要喂什么 → `buildAgentCreateOptions()` / `buildSessionCreateRequest()`
//
// **不在这里做的事**：不调 `ctx.agents.create`、不读文件、不发消息——
// 那些是动作（`../preload-session.js` 与宿主 `../index.js`），判据与组装必须能脱离宿主验。
//
// 契约的两个要点（照抄平台，不发明）：
//   · `SessionId` 是**纯编译期品牌**（`Branded<'SessionId'>`）；官方 `brandString(v)` 的实现
//     就是 `return value`——所以**不引依赖**，直接给字符串，格式照平台：
//     `session-<uuid>`（平台自己的会话接口建会话/派生会话时就是这么造的）。
//   · 建 agent 的入参是 `{ sessionId, meta: { cwd }, agentOptions: {} }`：
//     `meta.cwd` 是**工作区根**（"fresh-session workspace metadata"）；
//     `agentOptions` 留空 = 用平台默认模型（我们**不指定模型**，那是用户/平台的事）。


/** 平台自己的会话 id 前缀（平台会话接口建的 id 就是这个形状）。 */
const SESSION_ID_PREFIX = 'session-';

/**
 * 造一个会话 id。**格式照平台**：`session-<uuid>`。
 * @param {string} [uuid] 测试用；不给就现造一个 v4。
 */
function mintSessionId(uuid) {
  const u = typeof uuid === 'string' && uuid ? uuid : randomUUID();
  return SESSION_ID_PREFIX + u;
}

/** 像不像一个能用的会话 id（我们自己造的 + 平台造的都要认）。 */
function looksLikeSessionId(id) {
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
function makeRequestId() {
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
function buildAgentCreateOptions(o = {}) {
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
function buildSessionCreateRequest(o = {}) {
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
function findPreloadSession(managedSessions) {
  const list = Array.isArray(managedSessions) ? managedSessions : [];
  return list.find((e) => e && e.role === 'preload' && looksLikeSessionId(e.sessionId)) || null;
}


// ===== core/changes.js =====
// dsh-milieu —— **变更台账**（纯函数：扫描结果的组装、事件流的产出与投影）
//
// 它照 [dsh-milieu/CHANGE-STATE-MACHINE.md](../../../dsh-milieu/CHANGE-STATE-MACHINE.md) v2 写。一句话：
//   **把"工作区里哪些东西、什么时候、变了多少"记成一条有界的事件流；六个桶与计数是它的投影。**
//
// 分工（不要混）：
//   · 判"变没变" → 比 **字节 + 指纹**（上一次的表）；
//   · 事件的**时间** → 扫描时现读的**文件 mtime（毫秒原值）**；
//   · `manifest.md` 只给人看，**不参与判定**。
//
// 扫描范围（规范）：**认知库全递归**（每个文件一条）；**其它库只到一级**（文件夹按整棵求和、顶层文件按自身）；
// 索引文件单独成条；`aggregateOnly` 里的目录只记整棵合计。


/** 事件类型。 */
const KINDS = ['created', 'changed', 'gone'];

/** 默认参数（都可被配置覆盖；数值的单一来源是 config/criteria.js）。 */
const CHANGE_DEFAULTS = {
  keepDays: DEFAULT_CRITERIA.eventKeepDays,
  keepCount: DEFAULT_CRITERIA.eventKeepCount,
  recursiveLibs: ['review'],
  indexFiles: ['tools/manifest.md', 'external/retired/INDEX.md'],
  aggregateOnly: ['external/refs'],
};

/**
 * **机制自己的产物**：它们永远不算"工作区变了"。
 *
 * 为什么必须有这张表（2026-10-14 咬过一次，journal/016）：本机制每次运行都会写这两个文件；
 * 不排除的话，下一轮算差量时第一个"新增"就是**它自己**，而且**每轮都在给自己供料**——环自己转起来。
 * 排除**只影响判据**：清单里照旧记着它们（存在是事实）。
 *
 * 写成"库名 + 文件名"两段，避免把别处同名文件误伤。
 */
const SELF_ARTIFACTS = [
  { lib: 'review', name: 'milieu-state.json' },
  { lib: 'tools', name: '.milieu-state-prev.json' },
];

/**
 * **宿主日志文件**（LOG-SCHEMA §6.3）：`.dsh-milieu/milieu.log` 与轮转文件（`.1` / `.2`…）
 * 也是机制自己的产物，**必须排除出事件流**——否则每写一条日志都变成一次"工作区变了"，自己喂自己。
 *
 * 为什么这里写字面量而不 import `log/file-sink.js`：分层不允许 `core/` 依赖 `log/`；
 * 路径契约在 LOG-SCHEMA §6.1 里是同一份（写方 file-sink、排除方这里）。
 */
const LOG_ARTIFACT_REL = '.dsh-milieu/milieu.log';

/** 这个路径是不是日志文件（本体或轮转备份）。 */
function isLogArtifact(rel) {
  if (!rel.startsWith(LOG_ARTIFACT_REL)) return false;
  const rest = rel.slice(LOG_ARTIFACT_REL.length);
  return rest === '' || /^\.\d+$/.test(rest); // milieu.log / milieu.log.1 / milieu.log.2 …
}

/** 这个相对路径是不是机制自己的产物？ */
function isSelfArtifact(rel, libs = { review: 'review', tools: 'tools' }) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (isLogArtifact(p)) return true;
  return SELF_ARTIFACTS.some((a) => p === (libs[a.lib] || a.lib) + '/' + a.name);
}

const isUnder = (rel, prefix) => rel === prefix || rel.startsWith(prefix + '/');
const topOf = (rel) => rel.split('/')[0];

/**
 * 由清单里的文件表 + 排除子树统计，算出"要跟踪的条目表"。
 *
 * @param {object} o
 *   · files       [{ rel, size, mtime }]（清单里的文件；rel 用 `/` 分隔）
 *   · libs        { review, tools, external }
 *   · excluded    [{ rel, size, mtime }]（被清单排除、只记整棵合计的子树）
 *   · cfg         CHANGE_DEFAULTS 形状
 * @returns {Object<string, {size:number, mtime:number|null, kind:'file'|'dir'}>}
 */
function buildEntries(o = {}) {
  const { files = [], libs, excluded = [], cfg = {} } = o;
  const c = { ...CHANGE_DEFAULTS, ...cfg };
  const out = {};

  const firstLevelLibs = ['tools', 'external'].filter((k) => libs[k]);
  const recursive = c.recursiveLibs;

  for (const f of files) {
    const rel = String(f.rel || '').replace(/\\/g, '/');
    if (!rel) continue;
    const size = Number(f.size) || 0;
    const mtime = typeof f.mtime === 'number' ? f.mtime : null;

    // ① 索引文件：单独成条（无论它在哪个库）
    if (c.indexFiles.includes(rel)) { out[rel] = { size, mtime, kind: 'file' }; continue; }

    // ② 递归库：每个文件一条
    if (recursive.some((lib) => isUnder(rel, lib))) { out[rel] = { size, mtime, kind: 'file' }; continue; }

    // ③ 只到一级的库：顶层文件按自身，更深的折进它的一级文件夹
    const lib = firstLevelLibs.find((k) => isUnder(rel, libs[k]));
    if (!lib) continue;
    const rest = rel.slice(libs[lib].length + 1);
    const parts = rest.split('/');
    const key = parts.length === 1 ? rel : libs[lib] + '/' + parts[0];
    const kind = parts.length === 1 ? 'file' : 'dir';
    const cur = out[key];
    if (!cur) out[key] = { size, mtime, kind };
    else {
      if (kind === 'dir') cur.size += size;                       // 文件夹：整棵求和
      if (mtime !== null) cur.mtime = cur.mtime === null ? mtime : Math.max(cur.mtime, mtime);
    }
  }

  // ④ 被清单排除的子树：只记整棵合计（**与别的文件夹同规则**，差别只在"不列子文件"）
  for (const ex of excluded) {
    const rel = String(ex.rel || '').replace(/\\/g, '/');
    if (!rel) continue;
    out[rel] = { size: Number(ex.size) || 0, mtime: typeof ex.mtime === 'number' ? ex.mtime : null, kind: 'dir' };
  }

  return out;
}

/** 一条事件。字段只有这五个——**不许偷偷加**（状态机说明 §四）。 */
function makeEvent(entry, beforeEntry, at) {
  const { path, kind, size, mtime } = entry;
  const before = beforeEntry ? beforeEntry.size : null;
  const after = kind === 'gone' ? null : size;
  return {
    path,
    kind,                                            // created | changed | gone
    time: mtime !== null && mtime !== undefined ? mtime : (beforeEntry && beforeEntry.mtime) || null,
    before,
    after,
    delta: (after === null ? 0 : after) - (before === null ? 0 : before),
  };
}

/** 比较两次的表，产出事件（首轮 → 空）。**唯一判据是 字节 + 指纹**。 */
function diffEntries(prev, cur, isFirstRun) {
  if (isFirstRun) return [];
  const events = [];
  const paths = new Set([...Object.keys(prev || {}), ...Object.keys(cur || {})]);
  for (const path of paths) {
    const a = prev ? prev[path] : undefined;
    const b = cur ? cur[path] : undefined;
    if (a && b) {
      if ((a.size !== b.size) || (a.hash !== b.hash)) {
        events.push(makeEvent({ path, kind: 'changed', size: b.size, mtime: b.mtime }, a));
      }
    } else if (a && !b) {
      events.push(makeEvent({ path, kind: 'gone' }, a));
    } else if (!a && b) {
      events.push(makeEvent({ path, kind: 'created', size: b.size, mtime: b.mtime }, null));
    }
  }
  return events;
}

/** 有界：最近 `keepDays` 天 ∪ 最近 `keepCount` 条。更早的**不删干净**——由调用方记"归档了几条"。 */
function boundEvents(events, now, cfg = {}) {
  const c = { ...CHANGE_DEFAULTS, ...cfg };
  const list = [...(events || [])].sort((a, b) => (b.time || 0) - (a.time || 0));
  const cutoff = now - c.keepDays * 86400000;
  const withinDays = list.filter((e) => typeof e.time === 'number' && e.time >= cutoff);
  const recent = list.slice(0, c.keepCount);
  const keep = new Set();
  for (const e of withinDays) keep.add(e);
  for (const e of recent) keep.add(e);
  return { events: list.filter((e) => keep.has(e)), archived: list.length - keep.size };
}

/**
 * **投影**：把事件流算成六个桶与计数。
 * **这是唯一的算法**——别处不许再从差量另算一份（那会让两处说法不一致，而且不报错）。
 */
function project(events, libs = { review: 'review' }) {
  const changeIndex = { reviewAdded: [], reviewChanged: [], reviewGone: [], otherAdded: [], otherChanged: [], otherGone: [] };
  const counts = { added: 0, changed: 0, gone: 0 };
  // 事件的 kind → 桶的后缀 / 计数的名字。**这个映射只有这一处。**
  const kindOf = { created: { suffix: 'Added', count: 'added' }, changed: { suffix: 'Changed', count: 'changed' }, gone: { suffix: 'Gone', count: 'gone' } };
  const bucketOf = (path) => (isUnder(String(path || '').replace(/\\/g, '/'), libs.review) ? 'review' : 'other');
  for (const e of events || []) {
    const k = kindOf[e.kind];
    if (!k) continue;
    const prefix = bucketOf(e.path) === 'review' ? 'review' : 'other';
    const key = prefix + k.suffix;
    if (changeIndex[key]) changeIndex[key].push(e.path);
    counts[k.count] += 1;
  }
  return { changeIndex, counts };
}


// ===== core/criteria.js =====
// dsh-milieu —— 会话判据（纯函数，无副作用，可离线测）
//
// 这个文件回答三个问题：
//   ① 这个工作区的常驻会话是哪一条？（识别）
//   ② 它现在还算不算数？（有效性）
//   ③ 要不要让它"再读一遍"？（刷新判据）
//
// **刻意不含任何宿主依赖**：不 import 宿主包、不碰文件系统。
// 理由：这三问是**判据**，不是**动作**。判据必须能脱离宿主反复验证——
// 否则每次改判据都要真装一次包才能知道对不对。
//
// 设计依据（见 ../../DEVELOPMENT.md 阶段 B）：
//   · 过期条件是"工作区状态变了"，**不是时间**（主人 2026-10-13 纠正）；
//   · 正常路径下状态不会背着会话偷偷变——因为按规范，改工作区就该走会话；
//   · 但仍然要检测，**为了在规范被绕过时有人叫**（274→382 行、三个孤儿文件都是那么来的）。




/** 判据版本：判据本身变了要能看出来（旧记录按旧判据写的）。 */
const CRITERIA_VERSION = 2;   // v2：自愈改按"缓存失效"定义；新增认知库完备性门槛

/** 缺省阈值（**默认值在 config/criteria.js**；这里导出同一份，供判据函数直接引用）。 */
const DEFAULT_SETTINGS = {
  // 结构性变化（新增/消失）达到几个就重读
  structuralThreshold: DEFAULT_CRITERIA.structuralThreshold,
  // 内容性变化（改动）达到几个就重读
  contentThreshold: DEFAULT_CRITERIA.contentThreshold,
  // 距上次阅读超过这么多天，即使没变化也提示一次（仅提示，不强制；因为"时间不是过期条件"）
  staleHintDays: DEFAULT_CRITERIA.staleHintDays,
};

/**
 * 认知库"建立完成"的门槛（主人 2026-10-13 定的规格，逐字照记）。
 *
 * 为什么要这道门槛：认知库还在快速长的时候就去"预加载"，等于**把一份正在写的账读进脑子**——
 * 读完就过时，而且看起来完全正常。所以**先等它稳定下来**，才开始预加载会话。
 */
const READINESS_SPEC = { ...DEFAULT_CRITERIA.readiness };

const R = (v) => Math.round(v * 1000) / 1000;   // 便于阅读与断言的小数位

/**
 * **把变更索引归一到唯一的判据形状**（判据层唯一的"翻译层"）。
 *
 * 为什么必须有它：字段名曾经出现过**两套**——
 *   · 状态文件按**库**分：`reviewAdded / reviewChanged / reviewGone / otherAdded / …`（卡片要分两段显示）；
 *   · 判据按**性质**分：`added / changed / gone`（要算"结构变了没有"）。
 * **两套键名就是两个版本**，于是同一个对象，一个函数说"有变化"、另一个说"没有变化"——**静默走错分支**。
 * 这个坑我一共踩了三次（阈值判据、状态解析、变更索引文本），所以把它放在判据层，
 * **并让每个吃变更索引的函数自己先归一**，而不是指望调用方记得。
 */
function normalizeChangeIndex(changeIndex) {
  const ci = changeIndex || {};
  const n = (v) => (Array.isArray(v) ? v : []);
  const bucketedKeys = ['reviewAdded', 'reviewChanged', 'reviewGone', 'otherAdded', 'otherChanged', 'otherGone'];
  const isBucketed = bucketedKeys.some((k) => k in ci);
  if (isBucketed) {
    return {
      added: [...n(ci.reviewAdded), ...n(ci.otherAdded)],
      changed: [...n(ci.reviewChanged), ...n(ci.otherChanged)],
      gone: [...n(ci.reviewGone), ...n(ci.otherGone)],
    };
  }
  // 已经是扁平形状（或空）：原样取，缺的补空数组
  return { added: n(ci.added), changed: n(ci.changed), gone: n(ci.gone) };
}

/**
 * **提示阈值**（主人 2026-10-13 定）：**5 分钟**。
 *
 * 注意它与 `staleHintDays`（30 天）的分工完全不同，别混：
 *   · 本阈值管的是**"读会话时算不算旧"** → 到点就提示"要不要重读"；
 *   · `staleHintDays` 管的是**"这份认识是不是很久没核对过"** → 只是提示一句，不触发重读。
 */
const PROMPT_THRESHOLD_MS = DEFAULT_CRITERIA.promptThresholdMs;

/**
 * 切进一条会话时，该不该弹"要不要重读"的提示？
 *
 * 规则（照主人原话）：
 *   · **时间够久**（≥ `PROMPT_THRESHOLD_MS`）**且** 工作区确实变了 → 提示；
 *   · **工作区没变** → 什么都不做（"如果工作区没变，就什么都没有"）；
 *   · **不假设用户记得** → 每次切进来只要满足条件就提示，但**一次只提示一次**（由调用方保证去重）。
 *
 * @param sessionActivityAt 那条会话最后活动时间（毫秒）
 * @param changeIndex 工作区变更（null / 空 = 没变）
 * @param now
 * @param thresholdMs
 */
function shouldPromptOnReturn(sessionActivityAt, changeIndex, now = Date.now(), thresholdMs = PROMPT_THRESHOLD_MS) {
  const hasChange = !!(changeIndex && (
    (Array.isArray(changeIndex.added) && changeIndex.added.length) ||
    (Array.isArray(changeIndex.changed) && changeIndex.changed.length) ||
    (Array.isArray(changeIndex.gone) && changeIndex.gone.length)
  ));
  if (!hasChange) return { prompt: false, reason: '工作区没有变化' };
  if (typeof sessionActivityAt !== 'number') return { prompt: true, reason: '不知道这条会话上次什么时候用的——保守提示（不假设用户记得）' };
  const elapsed = now - sessionActivityAt;
  if (elapsed >= thresholdMs) {
    return { prompt: true, reason: '距上次使用 ' + Math.round(elapsed / 1000) + ' 秒（≥ ' + Math.round(thresholdMs / 1000) + ' 秒）且工作区有变化', elapsedMs: elapsed };
  }
  return { prompt: false, reason: '虽然变了，但距上次使用只有 ' + Math.round(elapsed / 1000) + ' 秒，未到阈值', elapsedMs: elapsed };
}

/**
 * 认知库是否可以开始预加载？
 *
 * @param snap 一份快照：{ files:number, bytes:number, addedInWindow:number, changedInWindow:number }
 *   全部**只针对认知库**（不含工具区与外部信息区）。
 * @returns { ready, reasons, need, rate, changedRatio } —— reasons 是**没满足的具体原因**，便于提示人看
 */
function evaluateReadiness(snap, spec = READINESS_SPEC) {
  const s = { ...READINESS_SPEC, ...spec };
  const reasons = [];

  const files = Number(snap && snap.files) || 0;
  const bytes = Number(snap && snap.bytes) || 0;
  const added = Number(snap && snap.addedInWindow) || 0;
  const changed = Number(snap && snap.changedInWindow) || 0;

  // 5 分钟内的"新增速度" = 新增数 / 期末总数。
  // 分母用 max(files, added) 并做 0 保护，避免"从 0 到 3"时算出无穷大而误判。
  const denom = Math.max(files, added, 1);
  const rate = R(added / denom);
  const changedRatio = R(changed / Math.max(files, 1));

  if (files < s.minFiles) reasons.push('文件数 ' + files + ' < ' + s.minFiles);
  if (bytes < s.minBytes) reasons.push('总大小 ' + bytes + ' 字节 < ' + s.minBytes);
  if (rate >= s.maxGrowthRate) reasons.push('窗内新增速度 ' + rate + ' ≥ ' + s.maxGrowthRate);
  if (changedRatio >= s.maxChangedRatio) reasons.push('窗内变动占比 ' + changedRatio + ' ≥ ' + s.maxChangedRatio);

  return {
    ready: reasons.length === 0,
    reasons,
    need: { files, bytes, added, changed },
    rate,
    changedRatio,
  };
}

/**
 * 缓存失效判定：工作区的变化**是否已经大到让之前那份理解失效**。
 *
 * 注意这是**判定要不要提示人**，不是"要不要自动重发"——
 * 按主人 2026-10-13 定的形态：**提示 → 得到许可 → 才发请求**。
 *
 * @param diff 清单差量 { added, changed, gone }（数组或顿号/逗号分隔的字符串）
 * @param record 上次阅读的记录 { readAt, fileCount }
 * @param settings 阈值
 */
function evaluateInvalidation(diff, record, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const toList = (v) => (Array.isArray(v) ? v
    : typeof v === 'string' && v.trim() && v.trim() !== '（无）'
      ? v.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) : []);
  if (!diff) {
    return { invalidated: false, prompt: false, reason: '拿不到差量（清单没跑过）——不据此提示，避免瞎动', counts: { added: 0, changed: 0, gone: 0 } };
  }
  const added = toList(diff.added), changed = toList(diff.changed), gone = toList(diff.gone);
  const counts = { added: added.length, changed: changed.length, gone: gone.length };
  const structural = counts.added + counts.gone;

  if (structural >= s.structuralThreshold) {
    return { invalidated: true, prompt: true, reason: '结构变了（新增 ' + counts.added + '、消失 ' + counts.gone + '）', counts };
  }
  if (counts.changed >= s.contentThreshold) {
    return { invalidated: true, prompt: true, reason: '改动较多（' + counts.changed + ' 个 ≥ ' + s.contentThreshold + '）', counts };
  }
  return { invalidated: false, prompt: false, reason: '变化未达阈值', counts };
}

/**
 * 生成"再读一遍"那次请求要带的**变更索引**（主人 2026-10-13 的要求）。
 *
 * 形态（照主人原话的意思）：
 *   · 认知库里变化的文件 → **单独列出，并强调"需要仔细阅读"**；
 *   · 其余库（工具区、外部信息区）→ **只给索引与索引表**，让 AI 自己去读。
 *
 * 这个函数**只拼装文本**，不决定发不发——发不发由人点头。
 */
function buildChangeIndexPrompt(diff, libs = { review: 'review', tools: 'tools', external: 'external' }) {
  // **自己先归一**——不指望调用方记得（这个坑踩过三次）
  const flat = normalizeChangeIndex(diff);
  const toList = (v) => (Array.isArray(v) ? v
    : typeof v === 'string' && v.trim() && v.trim() !== '（无）'
      ? v.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) : []);
  const added = toList(flat.added), changed = toList(flat.changed), gone = toList(flat.gone);

  const reviewPrefix = libs.review.replace(/\/+$/, '') + '/';
  const inReview = (p) => p.replace(/\\/g, '/').startsWith(reviewPrefix);
  const bucket = (list) => ({
    review: list.filter(inReview),
    other: list.filter((p) => !inReview(p)),
  });
  const a = bucket(added), c = bucket(changed), g = bucket(gone);

  const line = (label, arr) => (arr.length ? '- ' + label + '（' + arr.length + '）：' + arr.join('、') : null);
  const parts = [];
  parts.push('# 工作区变了，需要重读');
  parts.push('');
  if (c.review.length || a.review.length || g.review.length) {
    parts.push('## 认知库（' + libs.review + '/）—— **这些要仔细读**');
    for (const l of [line('新增', a.review), line('改动', c.review), line('消失', g.review)]) if (l) parts.push(l);
    parts.push('');
  }
  if (c.other.length || a.other.length || g.other.length) {
    parts.push('## 其余库 —— **只给索引，自行决定读不读**');
    parts.push('（工具区 ' + libs.tools + '/、外部信息区 ' + libs.external + '/）');
    for (const l of [line('新增', a.other), line('改动', c.other), line('消失', g.other)]) if (l) parts.push(l);
    parts.push('');
  }
  if (parts.length <= 3) parts.push('（差量为空——无需重读）');
  return parts.join('\n');
}

/**
 * 指纹保留策略（主人 2026-10-13 定）：**最近 1 天 ∪ 最近 5 条**。
 *
 * 意义：**有指纹的会话走"正向"判据**（精确，能算出变更索引）；
 * 指纹被淘汰的老会话走"反向"判据（粗，但**只会多提示、不会漏提示**）。
 */
const FINGERPRINT_POLICY = { ...DEFAULT_CRITERIA.fingerprint };

/**
 * 哪些会话的指纹该留？
 * @param entries [{ sessionId, at }]，at = 那条会话最后活动时间（毫秒）
 * @param policy
 * @param now
 * @returns { keep:Set<string>, dropped:string[] }
 */
function planFingerprintRetention(entries, policy = FINGERPRINT_POLICY, now = Date.now()) {
  const p = { ...FINGERPRINT_POLICY, ...policy };
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.sessionId === 'string') : [];
  const byTime = [...list].sort((a, b) => (b.at || 0) - (a.at || 0));
  const keep = new Set();
  // 方向上：最近 N 条
  for (const e of byTime.slice(0, p.keepRecent)) keep.add(e.sessionId);
  // 方向上：最近 keepDays 天
  const cutoff = now - p.keepDays * 86400000;
  for (const e of list) if ((e.at || 0) >= cutoff) keep.add(e.sessionId);
  const dropped = list.filter((e) => !keep.has(e.sessionId)).map((e) => e.sessionId);
  return { keep, dropped };
}

/**
 * 判定一个会话该走哪条判据。
 * @param sessionAt 那条会话最后一次活动时间
 * @param checkpoints 工作区一级的检查点记录 { lastThresholdAt, fingerprints:{[sid]:{at}} }
 */
function pickDirection(sessionAt, checkpoints) {
  const cp = checkpoints || {};
  const fps = cp.fingerprints || {};
  const hasFp = Object.values(fps).some((f) => f && f.at === sessionAt);
  if (hasFp) return 'forward';                                  // 有指纹 → 精确
  if (typeof cp.lastThresholdAt === 'number') return 'reverse';  // 没指纹但有阈值时间 → 粗判
  return 'unknown';                                             // 两者都没有 → 只能提示一次
}

/**
 * 正向判据：拿那条会话自己的指纹与当前清单比，算出**变更索引**。
 * 这是**精确**的那条路——也正是请求里要带的东西。
 */
function evaluateReturn(diff, sessionRecord, settings = DEFAULT_SETTINGS) {
  const base = evaluateInvalidation(diff, sessionRecord, settings);
  if (!base.prompt) return { ...base, direction: 'forward', changeIndex: null };
  return { ...base, direction: 'forward', changeIndex: buildChangeIndexPrompt(diff) };
}

/**
 * 反向判据：指纹已被淘汰的老会话，只有一个"上次阈值到达时间"可用。
 *
 * 判定：**会话的最后活动时间早于阈值时间 → 提示**（中间隔着一次"大到值得重读"的变化）。
 * 粗，但**只会多提示，不会漏提示**——这个方向的误差是安全的。
 */
function evaluateExpiredSession(sessionAt, checkpoints) {
  const cp = checkpoints || {};
  const t = cp.lastThresholdAt;
  if (typeof sessionAt !== 'number') return { prompt: false, direction: 'reverse', reason: '这个会话没有可用时间' };
  if (typeof t !== 'number') return { prompt: true, direction: 'reverse', reason: '工作区没有任何阈值记录——保守提示一次' };
  if (sessionAt < t) {
    return { prompt: true, direction: 'reverse', reason: '这个会话早于上次"变化达到阈值"的时刻（粗判：可能错过了大事）' };
  }
  return { prompt: false, direction: 'reverse', reason: '这个会话晚于上次阈值时刻，期间没有够大的变化' };
}

/**
 * 跨过阈值时，把"上次阈值到达时间"推进到现在。**这是反向判据的唯一依据，必须有人写。**
 * 返回新的检查点对象（不改原对象）。
 */
function markThresholdReached(checkpoints, reachedAt, sessionAt, fingerprint) {
  const cp = { ...(checkpoints || {}) };
  const fps = { ...(cp.fingerprints || {}) };
  if (typeof sessionAt === 'number' && fingerprint) fps[String(sessionAt)] = { at: sessionAt, fp: fingerprint };
  cp.lastThresholdAt = reachedAt;
  cp.fingerprints = fps;
  return cp;
}

/**
 * 从记录表里找出这个工作区的常驻会话。
 * 记录形状（由调用方提供，来自插件自己的小状态文件）：
 *   { [workspaceKey]: { sessionId, readAt, lastDiff } }
 * @returns { sessionId, readAt, lastDiff } 或 null
 */
function findResident(store, cwd) {
  if (!store || typeof store !== 'object') return null;
  const key = workspaceKey(cwd);
  if (!key) return null;
  const rec = store[key];
  if (!rec || typeof rec.sessionId !== 'string' || !rec.sessionId) return null;
  return rec;
}

/**
 * 这条常驻会话现在还算不算数？
 * `liveSessionIds` = 宿主当前活着的会话 id 集合（由调用方传进来，便于离线测）。
 * @returns { valid: boolean, reason: string }
 */
function isValidResident(record, liveSessionIds) {
  if (!record || !record.sessionId) return { valid: false, reason: '没有记录' };
  if (!(liveSessionIds instanceof Set)) return { valid: false, reason: '调用方没给出活会话集合' };
  if (!liveSessionIds.has(record.sessionId)) return { valid: false, reason: '记录里的会话不在活会话集合里' };
  return { valid: true, reason: '在活会话集合里' };
}

/**
 * 要不要让它"再读一遍"？
 * @param diff 清单差量：{ added: string[]|string, changed: string[]|string, gone: string[]|string } 或 null
 * @param record 常驻会话记录（含 lastDiff 与 readAt）
 * @param settings 阈值
 * @returns { refresh: boolean, reason: string, structural: number, content: number }
 */
function shouldRefresh(diff, record, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!record) return { refresh: true, reason: '还没有读过这个工作区', structural: 0, content: 0 };
  if (!diff) return { refresh: false, reason: '拿不到差量（清单没跑过）——不据此重读，避免瞎动', structural: 0, content: 0 };

  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/[、,]/).map((x) => x.trim()).filter(Boolean) : []);
  const added = list(diff.added);
  const changed = list(diff.changed);
  const gone = list(diff.gone);
  const structural = added.length + gone.length;
  const content = changed.length;

  if (structural >= s.structuralThreshold) {
    return { refresh: true, reason: '结构变了（新增 ' + added.length + '、消失 ' + gone.length + '）', structural, content };
  }
  if (content >= s.contentThreshold) {
    return { refresh: true, reason: '改动较多（' + content + ' 个，达到阈值 ' + s.contentThreshold + '）', structural, content };
  }
  return { refresh: false, reason: '变化未达阈值（结构 ' + structural + '、改动 ' + content + '）', structural, content };
}

/**
 * 只是"提示该看看了"——**不触发重读**。
 * 时间永远不是过期条件；但很久没核对过，值得提一句。
 */
function staleHint(record, settings = DEFAULT_SETTINGS, now = Date.now()) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!record || typeof record.readAt !== 'number') return null;
  const days = (now - record.readAt) / 86400000;
  if (days < s.staleHintDays) return null;
  return { days: Math.floor(days), reason: '距上次阅读 ' + Math.floor(days) + ' 天（仅提示，不重读）' };
}

/**
 * 自愈的定义与失效面（**主人 2026-10-13 收窄了定义**）。
 *
 * 定义：**自愈 = 工作区变化过大，导致之前对工作区的理解失效。**
 * 所以它的本性是**缓存失效**，不是"坏了要修"。处置方式随之确定：
 *   **不自动重发请求；在用户切换会话时提示，得到许可后才发。**
 * 前提：插件**监督了工作区里哪些文件变了、变了多大**。
 *
 * 下面这张表保留为"还可能出现哪些坏法"的清单——但**只有第 4 条属于"自愈"的正式范围**，
 * 其余是相邻问题，按需另议。
 */
function selfHealingSurface() {
  return [
    { state: '工作区变化过大 → 之前的理解失效', detectable: true, by: '清单差量 ≥ 阈值', inScope: true, handling: '切换会话时提示 → 许可 → 带变更索引发请求' },
    { state: '记录不存在（还没读过）', detectable: true, by: '记录表里没有这个工作区的条目', inScope: false, handling: '建库门槛满足时建立' },
    { state: '记录在，但会话已不在活集合里', detectable: true, by: 'liveSessionIds 里没有它', inScope: false, handling: '待议（相邻问题）' },
    { state: '记录在、会话活着，但已被归档', detectable: '需查归档集合', by: 'workspaces.archivedSessionIds', inScope: false, handling: '待议——很可能是主人自己的动作' },
    { state: '记录被外部改坏（JSON 坏了）', detectable: true, by: '解析失败', inScope: false, handling: '待议（相邻问题）' },
    { state: '记录在、会话活着，但已不是"空白会话"（用户拿它当正式对话了）', detectable: '需查 blank 状态', by: 'sessions.list 里的 blank 字段', inScope: false, handling: '待议——很可能是主人自己的动作' },
    { state: '两个工作区指向同一条会话（记录被拷错）', detectable: true, by: '记录表里同一 sessionId 出现两次', inScope: false, handling: '待议（相邻问题）' },
    { state: '插件被卸载后重装：记录丢了但会话还在磁盘上', detectable: false, by: '——**当前无法检测**（没有反向索引：会话 → 工作区）', inScope: false, handling: '当前无解' },
  ];
}


// ===== core/views.js =====
// dsh-milieu —— **变更视图**（纯函数：事件流 → 一段给人/给 AI 看的文字）
//
// 它回答一个具体问题：**这条会话该看到的"变了什么"，详细到什么程度？**
// 规则照 [dsh-milieu/CHANGE-STATE-MACHINE.md](../../../dsh-milieu/CHANGE-STATE-MACHINE.md) §六：
//
//   · 会话**30 天以内**用过 → **视图 A**：文件名 + 大小变化（旧→新 + 净变化）
//   · 会话**超过 30 天**没用 → **视图 B**：认知库**只给文件名**（最多 20 条，超过整段不列，写"改动过大"）；
//                                其它库**只给两个索引文件**的名字与大小变化
//
// 口径（主人 2026-10-16 定的，别改）：**过滤基准是这条会话自己的活动时间**——
//   在用会话时不打扰（用户看得见的变化，AI 自然也接受）；搁置久了才给全貌。
//
// 它**不判断该不该重读**（那是 `core/criteria.js` 的判据），只负责"该看什么就摆成什么样"。



/** 超过这么久没用 → 只给文件名（默认值在 config/criteria.js）。 */
const STALE_DAYS = DEFAULT_CRITERIA.staleDays;
/** 视图 B 里认知库最多列几条；超过就整段不列（默认值在 config/criteria.js）。 */
const STALE_MAX_REVIEW = DEFAULT_CRITERIA.staleMaxReview;

const MS_PER_DAY = 86400000;

/** 字节数 → 人话（B / KB / MB，一位小数；0 显示 0B）。 */
function formatSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '0B';
  const abs = Math.abs(v);
  if (abs < 1024) return v + 'B';
  if (abs < 1024 * 1024) return (v / 1024).toFixed(1) + 'kb';
  return (v / (1024 * 1024)).toFixed(1) + 'mb';
}

/** 净变化 → 带符号的人话（`+23.1kb` / `-13.0mb` / `+0B`）。 */
function formatDelta(n) {
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '') + formatSize(v);
}

/** 路径属于哪个库（认知库 / 其它）。 */
function bucketOf(path, libs) {
  const p = String(path || '').replace(/\\/g, '/');
  const review = (libs && libs.review) || 'review';
  return p === review || p.startsWith(review + '/') ? 'review' : 'other';
}

/**
 * 同一路径的多条事件合并成一行（净变化 + 最早 before / 最晚 after + 标记）。
 * **聚合规则只有这一处**。
 */
function aggregateEvents(events) {
  const sorted = [...(events || [])].filter((e) => e && e.path).sort((a, b) => (a.time || 0) - (b.time || 0));
  const map = new Map();
  for (const e of sorted) {
    const path = String(e.path).replace(/\\/g, '/');
    let row = map.get(path);
    if (!row) {
      row = { path, before: e.before, after: e.after, delta: 0, created: false, gone: false };
      map.set(path, row);
    }
    row.delta += typeof e.delta === 'number' ? e.delta : 0;
    // 窗口内出现过的"创造/删除"要记住：**创造过的，起点就是"无"；删除过的，终点就是"无"**
    if (e.kind === 'created') row.created = true;
    if (e.kind === 'gone') row.gone = true;
    if (e.kind !== 'created' && e.before !== null && e.before !== undefined && row.before === undefined) row.before = e.before;
    if (e.after !== null && e.after !== undefined) row.after = e.after;    // 最晚的非空 after
  }
  for (const row of map.values()) {
    if (row.created) row.before = null;   // 创造过 → 起点是"无"
    if (row.gone) row.after = null;       // 删除过 → 终点是"无"
  }
  return [...map.values()];
}

/** 一行：`路径  旧 → 新  净变化  （创造/删除标记）`。 */
function lineOf(r) {
  const left = r.before === null || r.before === undefined ? '无' : formatSize(r.before);
  const right = r.after === null || r.after === undefined ? '无' : formatSize(r.after);
  const flags = (r.created ? '（创造）' : '') + (r.gone ? '（删除）' : '');
  return '- ' + r.path + '  ' + left + ' → ' + right + '  ' + formatDelta(r.delta) + (flags ? '  ' + flags : '');
}

/**
 * 渲染这条会话该看到的变更视图。
 *
 * @param {object} o
 *   · events       事件流（状态文件里的那份）
 *   · activityAt   这条会话的最后活动时间（毫秒）；拿不到 → 保守按"视图 A"
 *   · now
 *   · libs         { review, tools, external }
 *   · indexFiles   索引文件名单（默认取 CHANGE_DEFAULTS）
 * @returns {{mode:'recent'|'stale', text:string, review:number, other:number}}
 */
function renderChangeView(o = {}) {
  const {
    events = [], activityAt = null, now = Date.now(),
    libs = { review: 'review', tools: 'tools', external: 'external' },
    indexFiles = CHANGE_DEFAULTS.indexFiles,
    staleDays = STALE_DAYS,
    staleMaxReview = STALE_MAX_REVIEW,
  } = o;
  const rows = aggregateEvents(events);
  const review = rows.filter((r) => bucketOf(r.path, libs) === 'review');
  const other = rows.filter((r) => bucketOf(r.path, libs) !== 'review');
  const stale = typeof activityAt === 'number' && (now - activityAt) > staleDays * MS_PER_DAY;

  if (!rows.length) return { mode: stale ? 'stale' : 'recent', text: '（没有变化）', review: 0, other: 0 };

  const parts = [];
  if (!stale) {
    // 视图 A：文件名 + 大小变化
    if (review.length) {
      parts.push('## 认知库（' + libs.review + '/）—— 这些要仔细读');
      for (const r of review) parts.push(lineOf(r));
      parts.push('');
    }
    if (other.length) {
      parts.push('## 其余库 —— 只给索引，自行决定读不读');
      parts.push('（工具区 ' + libs.tools + '/、外部信息区 ' + libs.external + '/）');
      for (const r of other) parts.push(lineOf(r));
      parts.push('');
    }
    return { mode: 'recent', text: parts.join('\n').trim(), review: review.length, other: other.length };
  }

  // 视图 B（超过 30 天）：认知库只给文件名；其它库只给两个索引文件
  parts.push('# 上次读过之后过了很久（超过 ' + staleDays + ' 天）');
  parts.push('');
  if (review.length) {
    parts.push('## 认知库（' + libs.review + '/）');
    if (review.length > staleMaxReview) parts.push('- （改动过大：' + review.length + ' 个文件，不逐条列）');
    else for (const r of review) parts.push('- ' + r.path);
    parts.push('');
  }
  const idx = other.filter((r) => indexFiles.includes(r.path));
  if (idx.length) {
    parts.push('## 其它库 —— 只给索引文件');
    for (const r of idx) parts.push(lineOf(r));
    parts.push('');
  }
  return { mode: 'stale', text: parts.join('\n').trim(), review: review.length, other: idx.length };
}


// ===== core/state.js =====
// dsh-milieu —— 状态文件的**解析与选择器**（纯模块：不定义形状、不读写文件）
//
// 为什么要有这个文件：判据只能有一处。宿主算变更（要读文件系统），客户端只显示。
// 位置：`<认知库>/milieu-state.json`
// 作者：**宿主**（由 `milieu-state.js` 生成）。**客户端只读它，绝不写。**
// 依赖：形状在 `../model/state.js`；投影算法在 `./changes.js`（这里不重写）。





/**
 * 解析客户端读到的文本。**任何异常都返回 null，不抛**——
 * 客户端读到一个坏文件时，正确行为是"什么都别弹"，不是把页面搞崩。
 */
function parseState(text) {
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
function managedIds(state) {
  return (state && Array.isArray(state.managedSessions) ? state.managedSessions : []).map((e) => e.sessionId);
}

/** 这条会话归不归我们管。 */
function isManaged(state, sessionId) {
  return managedIds(state).includes(sessionId);
}

/** 这个变更索引里到底有没有东西（客户端判断"要不要弹"的第一道关）。 */
function hasChanges(changeIndex) {
  if (!changeIndex || typeof changeIndex !== 'object') return false;
  for (const v of Object.values(changeIndex)) if (Array.isArray(v) && v.length) return true;
  return false;
}

/**
 * **注意：变更索引的"归一"只有一个家在 `core/criteria.js`**（`normalizeChangeIndex`）。
 * 别处不许再写一份——"同一件事两个版本"曾经让"有变化"静默变成"没变化"。
 */

/** 汇总成给人看的计数（卡片标题用）。 */
function changeTotals(changeIndex) {
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  const ci = changeIndex || {};
  const review = n(ci.reviewAdded) + n(ci.reviewChanged) + n(ci.reviewGone);
  const other = n(ci.otherAdded) + n(ci.otherChanged) + n(ci.otherGone);
  return { review, other, total: review + other };
}


// ===== core/texts.js =====
// dsh-milieu —— 请求文本拼装（**纯模块** + **配置层默认值**：无宿主依赖、无副作用、双方都能引）
//
// 为什么单独一个文件：这段文本有两个作者——
//   · **客户端**点"重读"时，用 `session/prompt` Remote 把它发进会话；
//   · **宿主**将来若要自己发起（例如建完常驻会话先读一遍），也发同一段。
// 主人 2026-10-13 的澄清正是这个意思：**"重读"与"预加载"是同一件事**。
// 所以拼装只能有一份——放在这里，两个半边都引它。
//
// **它同时决定两件事**（2026-10-14 主人指出的）：
//   ① AI 读到什么任务；
//   ② **会话在列表里叫什么**——平台用"第一条人类消息的前几个词"当会话标题（fallback）。
//   所以：**第一行 = 时间**，用户一眼能看出这条会话是什么时候起的。
//
// 文本内容属**配置层**（主人 2026-10-14 定）：默认值在这里，可在插件的 `Config.texts` 里整体替换。




/** 来源标记：**只给日志与调试用**（进消息的来源字段，不再写进正文——正文会被拿去做标题）。 */
const PRELOAD_SOURCE = 'dsh-milieu:preload';
const REREAD_SOURCE = 'dsh-milieu:reread';

const DEFAULT_LIBS = { review: 'review', tools: 'tools', external: 'external' };

/** 时间：ISO 时刻（可回溯、可被日志重建）。 */
const iso = (now) => new Date(now).toISOString();

/**
 * **两段请求文本的默认模板 = 配置层的默认值。**
 *
 * 主人定的两条（2026-10-14）：
 *   · **时间在最前**——它是会话标题的来源，也是"这次阅读发生在什么时候"的凭据；
 *   · 任务要的是 **AI 自己说出来**（"简单说明自己读到的内容" / "简要说明认识前后的变化"），
 *     **不是写文档**——用户要在这儿直接看到 AI 的粗略认识，方便他后续处理。
 */
const DEFAULT_TEXTS = {
  preload: ({ libs, stateFile, time }) => [
    '时间：' + time,
    '',
    '读一遍这个工作区，认一下它现在是什么状态，然后**简单说明自己读到的内容**。',
    '',
    '这是插件（dsh-milieu）发起的一次真实阅读，**不是用户的话**；不必写任何文档。',
    '从这一页开始：`' + stateFile + '`。',
    '**认知库（' + libs.review + '/）里的东西要仔细读**；其余库（' + libs.tools + '/、' + libs.external + '/）只看索引，自己决定读不读。',
  ].join('\n'),

  reread: ({ libs, changeIndex, events, activityAt, now, time, criteria = DEFAULT_CRITERIA }) => [
    '时间：' + time,
    '',
    // **两种视图**（2026-10-18）：有事件流就按"这条会话的新旧"决定给什么——
    //   30 天内给"文件名 + 大小变化"；超过 30 天：认知库只给文件名、其它库只给索引文件。
    //   没有事件流（旧数据/离线）就退回原来的路径清单。
    events
      ? renderChangeView({
          events, activityAt, now, libs,
          staleDays: criteria.staleDays,
          staleMaxReview: criteria.staleMaxReview,
        }).text
      : buildChangeIndexPrompt(changeIndex, libs),
    '',
    '请**简要说明认识前后的变化改动**，不必写任何文档。',
  ].join('\n'),
};

const pick = (templates, kind) => (templates && typeof templates[kind] === 'function' ? templates[kind] : DEFAULT_TEXTS[kind]);

/** 渲染一段模板：模板出错**不许把发送整条路带崩**——退回默认模板，并如实说出来。 */
function render(kind, ctx, templates) {
  const fn = pick(templates, kind);
  try {
    return String(fn(ctx));
  } catch (err) {
    if (fn !== DEFAULT_TEXTS[kind]) {
      try { return String(DEFAULT_TEXTS[kind](ctx)); } catch { /* 默认模板也炸：交给下面那句 */ }
    }
    return '[' + kind + '] 文本模板出错：' + String((err && err.message) || err) + '\n时间：' + ctx.time;
  }
}

/** 拼"第一次读工作区"的请求文本（预加载用）。 */
function buildPreloadText({ libs = DEFAULT_LIBS, stateFileRelPath = 'review/milieu-state.json', now = Date.now(), templates } = {}) {
  return render('preload', { libs, stateFile: stateFileRelPath, time: iso(now) }, templates);
}

/** 拼"再读一遍"的请求文本（重读用）。带上变更视图（按会话新旧）：认知库细读、其余库给索引。 */
function buildRereadText({ changeIndex, events, activityAt, libs = DEFAULT_LIBS, now = Date.now(), templates, criteria = DEFAULT_CRITERIA } = {}) {
  return render('reread', { libs, changeIndex, events, activityAt, now, time: iso(now), criteria }, templates);
}

/** 按用途选文本（两个半边共用这一个入口）。 */
function buildReadText(kind, o = {}) {
  return kind === 'reread' ? buildRereadText(o) : buildPreloadText(o);
}


// ===== exception/codes.js =====
// dsh-milieu —— 稳定错误码（纯常量层：不 import 任何层、不放业务判断）
//
// 为什么要有它（task-5）：失败路径如果只带一句人话 `reason`，调用方就没法稳定地区分
//   "是宿主服务没了"还是"写文件被拒"。错误码是**机器可判**的那一半，`reason` 是**人可读**的那一半。
//
// 纪律：**码值一旦发布就不改，只增**（日志/诊断/测试可能拿它做判据）。
//   码值用小写短横线；`unknown` 是兜底，不许拿它当"分类"用。

/** 全部稳定错误码。 */
const CODES = Object.freeze({
  // ---- 宿主 / 平台服务（adapter/dsh.js 的翻译结果） ----
  HOST_UNAVAILABLE: 'host-unavailable',        // 宿主没有这个服务/接口
  HOST_CALL_FAILED: 'host-call-failed',        // 宿主接口调用了，但抛错/拒绝
  WORKSPACE_NOT_FOUND: 'workspace-not-found',  // 平台里找不到对应工作区 id

  // ---- 文件系统（adapter/fs.js / 核心层写入边界） ----
  FS_UNAVAILABLE: 'fs-unavailable',            // 没有文件系统能力对象
  FS_READ_FAILED: 'fs-read-failed',            // 读文件失败（含源文件缺失）
  FS_WRITE_FAILED: 'fs-write-failed',          // 写文件 / 建目录失败

  // ---- 配置 ----
  CONFIG_INVALID: 'config-invalid',            // 配置缺失或形状不可用

  // ---- 协议 ----
  PROTOCOL_SOURCE_MISSING: 'protocol-source-missing', // 插件包里的协议源文件读不到
  PROTOCOL_WRITE_FAILED: 'protocol-write-failed',     // 写工作区协议失败

  // ---- 会话 ----
  SESSION_CREATE_FAILED: 'session-create-failed', // 建会话 / 建 agent 失败
  SESSION_INSPECT_FAILED: 'session-inspect-failed', // 查会话状态失败
  SESSION_PROMPT_FAILED: 'session-prompt-failed', // 发请求失败

  // ---- 状态账 / 注入页 ----
  STATE_PARSE_FAILED: 'state-parse-failed',   // 状态文件解析失败（客户端读坏文件）
  STATE_SCAN_FAILED: 'state-scan-failed',     // 扫描工作区失败
  STATE_WRITE_FAILED: 'state-write-failed',   // 写状态文件 / 基准失败
  STATE_INJECT_FAILED: 'state-inject-failed', // 刷新/拼装注入页失败（装饰，fail-open）

  // ---- 界面 ----
  UI_INIT_FAILED: 'ui-init-failed',     // 客户端启动/接线失败
  UI_READ_FAILED: 'ui-read-failed',     // 读状态文件失败
  UI_SEND_FAILED: 'ui-send-failed',     // 发重读请求失败
  UI_RENDER_FAILED: 'ui-render-failed', // 卡片渲染失败

  // ---- 兜底 ----
  UNKNOWN: 'unknown',
});

/**
 * 每一层（ARCHITECTURE.md 的层名）的**默认错误码**：`normalize` 没拿到更具体的码时用它。
 * 只覆盖本插件实际会出现的层；`unknown` 是兜底。
 */
const LAYER_CODES = Object.freeze({
  host: CODES.HOST_CALL_FAILED,
  fs: CODES.FS_WRITE_FAILED,        // 默认按写入（读失败由调用方显式给 FS_READ_FAILED）
  config: CODES.CONFIG_INVALID,
  protocol: CODES.PROTOCOL_WRITE_FAILED,
  session: CODES.SESSION_CREATE_FAILED,
  state: CODES.STATE_SCAN_FAILED,
  ui: CODES.UI_READ_FAILED,
  unknown: CODES.UNKNOWN,
});

/** 已知层名（供测试与 normalize 校验；顺序即上表顺序）。 */
const LAYERS = Object.freeze(Object.keys(LAYER_CODES));

/** 这一层的默认错误码；不认识的层 → `unknown`。 */
function codeForLayer(layer) {
  if (typeof layer !== 'string') return CODES.UNKNOWN;
  return LAYER_CODES[layer] || CODES.UNKNOWN;
}

/** 是不是一个稳定错误码（防止把平台自己的 `ENOENT` / `EACCES` 混进来当分类）。 */
function isKnownCode(code) {
  if (typeof code !== 'string') return false;
  for (const value of Object.values(CODES)) if (value === code) return true;
  return false;
}


// ===== exception/normalize.js =====
// dsh-milieu —— 失败归一（纯模块：把任意 thrown 值 / 半成品结果变成统一失败结果）
//
// 统一形状（task-5）：
//   { ok:false, code, reason, blockedBy, cause? }
//     · `code`     —— 稳定错误码（见 `exception/codes.js`）；机器可判
//     · `reason`   —— 人话；**保留原 message**，不在这里改文案
//     · `blockedBy`—— 被工具/环境挡住的是什么（`host` / `fs` / 层名或服务能力名）
//     · `cause`    —— 原始 thrown 值（便于排查；序列化时通常为空，故可选）
//
// 三条规则：
//   ① **成功结果不动**（原对象返回，连身份都不变）；
//   ② **已经是失败结果** → 保留原字段、缺的补齐（不重写 reason）；
//   ③ 其余任何值（Error / 字符串 / 数字 / 对象 / undefined）→ 都归一成失败结果，**不抛**。


/** 是不是"统一结果"里的失败形状。 */
function isFail(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && value.ok === false;
}

/** 是不是"统一结果"里的成功形状。 */
function isOk(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && value.ok === true;
}

/**
 * 取任意输入里的"人话原因"；取不到返回 ''（由调用方兜底成"未知原因"）。
 * 与旧代码里的 `String((err && err.message) || err)` 等价——**文案来源不变**。
 * @param {unknown} input
 * @returns {string}
 */
function reasonOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message || String(input);
  if (input && typeof input === 'object') {
    if (typeof input.reason === 'string' && input.reason) return input.reason;
    if (typeof input.message === 'string' && input.message) return input.message;
    return '';
  }
  if (input === undefined || input === null) return '';
  try {
    const text = String(input);
    return text === '[object Object]' ? '' : text;
  } catch {
    return '';
  }
}

/** 从错误对象上读"适配层附加的分类提示"（fs 适配层会挂 milieuCode / milieuBlockedBy）。 */
function hintOf(input) {
  if (!input || typeof input !== 'object') return {};
  return {
    code: input.milieuCode,
    blockedBy: input.milieuBlockedBy,
  };
}

/**
 * 归一任意失败输入。
 * @param {unknown} input thrown 值 / 失败结果 / 任意值
 * @param {{code?:string, blockedBy?:string, layer?:string, keepCause?:boolean}} [opts]
 *   · `code`      未指定具体码时的候选码（优先于层默认码）
 *   · `blockedBy` 未指定时补的"被谁挡住"
 *   · `layer`     层名（host / fs / config / protocol / session / state / ui / unknown），用其默认码
 *   · `keepCause` 是否保留 `cause`（默认 true；已是失败结果时不加）
 * @returns {{ok:false, code:string, reason:string, blockedBy:string|null, cause?:unknown}}
 */
function normalizeError(input, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};

  // ① 成功结果不动
  if (isOk(input)) return input;

  // ② 已是失败结果：保留原字段，只补缺
  if (isFail(input)) {
    const out = { ...input };
    if (!out.reason) out.reason = '未知原因';
    else out.reason = String(out.reason);
    if (!out.code) out.code = options.code || codeForLayer(options.layer);
    if (out.blockedBy === undefined) out.blockedBy = options.blockedBy || null;
    return out;
  }

  // ③ thrown Error / 字符串 / 未知值
  const hint = hintOf(input);
  const hintCode = isKnownCode(hint.code) ? hint.code : null;
  const optionCode = isKnownCode(options.code) ? options.code : null;
  const reason = reasonOf(input) || '未知原因';
  const result = {
    ok: false,
    code: hintCode || optionCode || codeForLayer(options.layer),
    reason,
    blockedBy: (typeof hint.blockedBy === 'string' && hint.blockedBy) || options.blockedBy || null,
  };
  if (options.keepCause !== false) result.cause = input;
  return result;
}

/** 别名：`normalize` 与 `normalizeError` 是同一件事（按文件名更顺口）。 */
const normalize = normalizeError;


// ===== exception/guard.js =====
// dsh-milieu —— 异常边界（纯模块：包住一次同步/异步调用，绝不把异常抛给宿主/界面）
//
// 为什么要有它（task-5）：每个文件各写一个 try/catch，等于每个文件各自决定
//   "报不报、报成什么级、返回什么形状"。这里把边界收成两个函数：
//     · `guardSync(label, fn, opts)`  —— 同步边界
//     · `guardAsync(label, fn, opts)` —— 异步边界（Promise 拒绝也接住）
//
// 契约：
//   · 成功：**返回 fn 的原值**（不包 `{ok:true}`——调用方拿到的还是原来那个东西）；
//   · 失败：`normalize` 成统一失败结果返回，**同时报告一次**，**不 rethrow**；
//   · **不装 process 级处理器**（uncaughtException / unhandledRejection）：插件不能替宿主
//     决定进程策略；只包自己的 timer / Promise / effect / slot 渲染这些边界。
//
// opts：
//   · `optional`  —— 可选装饰（状态页注入、诊断、卡片）：失败只记 info（有 debug 记 debug），
//                    不当作错误；默认 false（主流程，失败记 warn）。
//   · `log`       —— 报告口。可以是 `{info,warn,debug}` 对象，也可以是 `(level, message) => void`
//                    函数（界面层的 logger 是后者）。
//   · `code` / `blockedBy` / `layer` —— 交给 `normalize` 的默认分类。



/** 归一 opts（坏输入当没有）。 */
function optionsOf(opts) {
  const raw = opts && typeof opts === 'object' ? opts : {};
  return {
    optional: raw.optional === true,
    log: raw.log || null,
    code: raw.code || null,
    blockedBy: raw.blockedBy || null,
    layer: raw.layer || null,
  };
}

/**
 * 把一条报告写到日志口。**日志自己坏了也不能反过来抛**（那是边界里的边界）。
 * @returns {boolean} 有没有真的写出去
 */
function emit(log, level, message) {
  if (!log) return false;
  try {
    if (typeof log === 'function') {
      log(level, message);
      return true;
    }
    const fn = typeof log[level] === 'function'
      ? log[level]
      : (level === 'info' && typeof log.debug === 'function' ? log.debug : null);
    if (typeof fn === 'function') {
      fn.call(log, message);
      return true;
    }
  } catch {
    /* 日志口自己坏了：边界不能再抛第二次 */
  }
  return false;
}

/** 失败报告文案（一次，含 label 与分类；不含层前缀，由 log 口自己带）。 */
function reportFailure(result, label, options) {
  const level = options.optional ? 'info' : 'warn';
  const head = options.optional ? '可选步骤失败（已跳过）' : '失败';
  const where = label ? '：' + label : '';
  const blocked = result.blockedBy ? '（被 ' + result.blockedBy + ' 挡住）' : '';
  emit(options.log, level, head + where + ' —— ' + result.reason + blocked);
}

/**
 * 同步边界：执行 `fn`，捕获任何 thrown 值。
 * @template T
 * @param {string} label 这次边界叫什么（进报告；便于定位）
 * @param {() => T} fn 被包住的调用
 * @param {object} [opts] 见文件头
 * @returns {T | {ok:false, code:string, reason:string, blockedBy:string|null, cause?:unknown}}
 */
function guardSync(label, fn, opts = {}) {
  const options = optionsOf(opts);
  try {
    return fn();
  } catch (err) {
    const failure = normalizeError(err, {
      code: options.code,
      blockedBy: options.blockedBy,
      layer: options.layer,
    });
    reportFailure(failure, label, options);
    return failure;
  }
}

/**
 * 异步边界：执行 `fn` 并等它；同步 throw 与 Promise 拒绝都接住。
 * 返回的 Promise **永远 resolve**（失败时 resolve 成失败结果），不会 reject 到宿主/界面。
 * @template T
 * @param {string} label
 * @param {() => T | Promise<T>} fn
 * @param {object} [opts]
 * @returns {Promise<T | {ok:false, code:string, reason:string, blockedBy:string|null, cause?:unknown}>}
 */
async function guardAsync(label, fn, opts = {}) {
  const options = optionsOf(opts);
  try {
    return await fn();
  } catch (err) {
    const failure = normalizeError(err, {
      code: options.code,
      blockedBy: options.blockedBy,
      layer: options.layer,
    });
    reportFailure(failure, label, options);
    return failure;
  }
}

/** 兜底结果：给"边界连失败结果都构造不出来"的极端情况用（目前只在测试里用到）。 */
function guardFallback(reason = '未知原因') {
  return { ok: false, code: CODES.UNKNOWN, reason: String(reason || '未知原因'), blockedBy: null };
}


// ===== log/schema.js =====
// dsh-milieu —— 日志数据结构（schema 层：纯模块，无副作用、不读写文件、不访问宿主）
//
// 依据：`plugin/dsh-milieu/LOG-SCHEMA.md` v2。这里的东西是**契约**：
//   · 事件表、级别集合、截断数字以本文件为准（文档同步维护）；
//   · 一行 = 一个 JSON 对象（JSONL）；序列化**只用 `JSON.stringify`**，禁止手拼字符串；
//   · **日志系统自身出错不能抛**：校验失败丢条目（可记一条 `log.invalid`），序列化失败返回最小行。
//
// 本文件不 import 'node:fs'、不写日志、不读配置——它只回答"这一条记录长什么样、合不合法"。

/** 日志结构版本。结构（删/改名/改类型）变了才升；新增字段不升。 */
const LOG_VERSION = 1;

/** 全部级别（从低到高）。 */
const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

/** 失败被谁挡住（与 `exception/codes.js` 的层名一致）。 */
const BLOCKED_BY = Object.freeze(['host', 'fs', 'config', 'protocol', 'session', 'state', 'ui', 'unknown']);

/**
 * 大小上限（LOG-SCHEMA §5）。数字是契约：改动要同步文档与测试。
 *   · lineBytes        —— 一整行（UTF-8，含 JSON 骨架）
 *   · dataBytes        —— `data` 序列化后的字节数
 *   · errorMessageChars—— `error.message` 字符数
 *   · errorStackChars  —— `error.stack` 字符数（只在 error 级别出现）
 *   · messageChars     —— `message` 字符数
 */
const LIMITS = Object.freeze({
  lineBytes: 2048,
  dataBytes: 512,
  errorMessageChars: 200,
  errorStackChars: 1024,
  messageChars: 500,
});

/** bootId 的形状：8 位小写字母/数字（宿主每次启动一个）。 */
const BOOT_ID_RE = /^[a-z0-9]{8}$/;

/** ISO 8601 UTC 带毫秒与 Z（只允许 `toISOString()` 产物）。 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * **事件表**（LOG-SCHEMA §4）：每事件一个 `defaultLevel` + `allowedLevels`。
 * 事件名是稳定接口；新增事件必须先登记到这里（validateRecord 会拒未登记事件）。
 */
const EVENTS = Object.freeze({
  'boot.start': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'boot.ready': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'protocol.sync': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'protocol.sync.failed': Object.freeze({ defaultLevel: 'error', allowedLevels: Object.freeze(['error']) }),
  'state.generate': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'state.generate.failed': Object.freeze({ defaultLevel: 'error', allowedLevels: Object.freeze(['error']) }),
  'state.page.refresh': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'state.page.skip': Object.freeze({ defaultLevel: 'debug', allowedLevels: Object.freeze(['debug']) }),
  'preload.create': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'preload.skip': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'preload.skip.unexpected': Object.freeze({ defaultLevel: 'warn', allowedLevels: Object.freeze(['warn']) }),
  'preload.failed': Object.freeze({ defaultLevel: 'error', allowedLevels: Object.freeze(['error']) }),
  'card.show': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'card.review': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'card.skip': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'ui.read.failed': Object.freeze({ defaultLevel: 'warn', allowedLevels: Object.freeze(['warn']) }),
  'log.message': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['debug', 'info', 'warn', 'error']) }),
  'error.caught': Object.freeze({ defaultLevel: 'warn', allowedLevels: Object.freeze(['warn', 'error']) }),
  'log.invalid': Object.freeze({ defaultLevel: 'warn', allowedLevels: Object.freeze(['warn']) }),
});

/** 事件名列表（调试/测试/统计用）。 */
const EVENT_NAMES = Object.freeze(Object.keys(EVENTS));

/** 是不是登记过的日志级别。 */
function isKnownLevel(level) {
  return typeof level === 'string' && LEVELS.includes(level);
}

/** 是不是登记过的事件。 */
function isKnownEvent(event) {
  return typeof event === 'string' && Object.prototype.hasOwnProperty.call(EVENTS, event);
}

/** UTF-8 字节数（浏览器/Node 都有的 TextEncoder；取不到就退化成字符数估计）。 */
function byteLengthOf(text) {
  const value = String(text ?? '');
  try {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  } catch {
    /* 没有 TextEncoder：走下面的估计 */
  }
  // 估计：非 ASCII 按 2 字节计（只用于大小上限，不用于精确断言之外的判断）
  let bytes = value.length;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 0x7f) bytes += 1;
  return bytes;
}

/** 截断字符串：超长时保留前缀并加 `…`（总长不超过 limit）。 */
function clipChars(text, limit) {
  const value = String(text ?? '');
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (value.length <= max) return value;
  if (max <= 1) return '…'.slice(0, max);
  return value.slice(0, max - 1) + '…';
}

/** 完整记录的 UTF-8 行字节数；序列化失败返回 Infinity（由调用方降级）。 */
function lineBytesOf(record) {
  try {
    return byteLengthOf(JSON.stringify(record));
  } catch {
    return Infinity;
  }
}

/** 生成 8 位小写字母/数字 bootId（宿主每次启动一个；不用宿主服务，纯随机）。 */
function makeBootId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return id;
}

/** 安全的时间串：正常用 `toISOString()`；坏输入退回当前时间（makeRecord 不应因此抛）。 */
function tsOf(now) {
  try {
    const date = now === undefined || now === null ? new Date() : new Date(now);
    const iso = date.toISOString();
    if (ISO_RE.test(iso)) return iso;
  } catch {
    /* 坏 now：退回当前时间 */
  }
  return new Date().toISOString();
}

/** 把输入的 error 归一成 `{name, message, stack?}`，并按上限截断。 */
function errorOf(raw, level) {
  if (raw === undefined || raw === null) return null;
  let name = 'Error';
  let message = '';
  let stack;
  if (raw instanceof Error) {
    name = typeof raw.name === 'string' && raw.name ? raw.name : 'Error';
    message = typeof raw.message === 'string' ? raw.message : String(raw.message ?? '');
    stack = typeof raw.stack === 'string' ? raw.stack : undefined;
  } else if (typeof raw === 'object') {
    if (typeof raw.name === 'string' && raw.name) name = raw.name;
    if (typeof raw.message === 'string') message = raw.message;
    else if (raw.message !== undefined) message = String(raw.message);
    if (typeof raw.stack === 'string') stack = raw.stack;
  } else {
    message = String(raw);
  }
  const out = { name, message };
  let truncated = false;
  const clippedMessage = clipChars(message, LIMITS.errorMessageChars);
  if (clippedMessage !== message) truncated = true;
  out.message = clippedMessage;
  // `stack` 只在 error 级别出现（LOG-SCHEMA §2.2）
  if (level === 'error' && stack) {
    const clippedStack = clipChars(stack, LIMITS.errorStackChars);
    if (clippedStack !== stack) truncated = true;
    out.stack = clippedStack;
  }
  return { value: out, truncated };
}

/** `data` 的大小检查：必须可序列化且 ≤ dataBytes；否则换成占位对象。 */
function dataOf(raw) {
  if (raw === undefined || raw === null) return { value: undefined, truncated: false };
  try {
    const json = JSON.stringify(raw);
    if (typeof json !== 'string') return { value: { _truncated: true }, truncated: true };
    if (byteLengthOf(json) > LIMITS.dataBytes) return { value: { _truncated: true }, truncated: true };
    return { value: raw, truncated: false };
  } catch {
    // 循环引用 / BigInt 等不可序列化：不悄悄丢字段，换成占位并标 truncated
    return { value: { _truncated: true }, truncated: true };
  }
}

/** 必填字段（"仍超只保留必填字段"时用）。 */
const REQUIRED_KEYS = Object.freeze(['v', 'ts', 'level', 'side', 'event', 'message', 'bootId']);

/** 把字符串压到"给定记录骨架 + 该字符串"不超过整行上限的最长前缀。 */
function fitTextIntoLine(skeleton, text) {
  const empty = { ...skeleton, message: '' };
  if (lineBytesOf({ ...empty, message: text }) <= LIMITS.lineBytes) return text;
  const base = lineBytesOf(empty);
  const budget = LIMITS.lineBytes - base;
  if (budget <= 0) return '';
  // 最多 500 字符：逐字符减，遇多字节字符按字节预算收
  let candidate = text;
  while (candidate.length > 0 && byteLengthOf(JSON.stringify(candidate)) > budget) {
    candidate = candidate.slice(0, candidate.length - 1);
  }
  if (candidate.length === text.length) return text;
  return candidate.length > 0 ? candidate.slice(0, Math.max(1, candidate.length - 1)) + '…' : '…'.slice(0, Math.max(0, budget > 1 ? 1 : 0));
}

/**
 * 整行超限时的降级顺序（LOG-SCHEMA §5 步骤 3–5）：
 *   压缩 data → 去掉 error.stack → 压 message → 只留必填字段 → 再压 message 到能容下。
 * @param {object} record 已按字段上限截断过的记录
 * @returns {object} 不超过整行上限的记录（`truncated:true`）
 */
function degradeToFit(record) {
  const next = { ...record, truncated: true };
  if (lineBytesOf(next) <= LIMITS.lineBytes) return next;

  // ① 压缩 data：先换成占位；再不行整个去掉
  if (next.data !== undefined) {
    next.data = { _truncated: true };
    if (lineBytesOf(next) <= LIMITS.lineBytes) return next;
    delete next.data;
    if (lineBytesOf(next) <= LIMITS.lineBytes) return next;
  }

  // ② 去掉 error.stack
  if (next.error && next.error.stack !== undefined) {
    next.error = { name: next.error.name, message: next.error.message };
    if (lineBytesOf(next) <= LIMITS.lineBytes) return next;
  }

  // ③ 压 message（先压到 120 字符，再不行只留必填字段）
  if (typeof next.message === 'string') {
    next.message = clipChars(next.message, 120);
    if (lineBytesOf(next) <= LIMITS.lineBytes) return next;
  }

  // ④ 只保留必填字段
  const minimal = { truncated: true };
  for (const key of REQUIRED_KEYS) {
    if (next[key] !== undefined) minimal[key] = next[key];
  }
  if (lineBytesOf(minimal) <= LIMITS.lineBytes) return minimal;

  // ⑤ 最后把 message 压到能容下的长度
  minimal.message = fitTextIntoLine(minimal, typeof minimal.message === 'string' ? minimal.message : '');
  return minimal;
}

/**
 * 造一条日志记录：填默认级别、按字段上限截断、必要时按整行上限降级。
 *
 * 规则（LOG-SCHEMA §3 / §5）：
 *   · 没给 level → 事件的 defaultLevel；
 *   · 给了但不在 allowedLevels → defaultLevel，并置 `levelAdjusted:true`；
 *   · 字段超限 → 截断并置 `truncated:true`（**不静默丢字段**）；
 *   · 整行超 2 KB → 按降级顺序压缩，仍置 `truncated:true`。
 *
 * **不抛**：内部异常时返回一条最小 `log.invalid` 记录（由调用方决定是否写出去）。
 * @param {object} input 至少给 `event` / `message`；`level` 可选
 * @returns {object} 记录对象（还没序列化）
 */
function makeRecord(input = {}) {
  try {
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const event = typeof src.event === 'string' ? src.event : '';
    const spec = Object.prototype.hasOwnProperty.call(EVENTS, event) ? EVENTS[event] : null;

    let truncated = false;
    let levelAdjusted = false;
    let level;
    if (src.level === undefined || src.level === null || src.level === '') {
      level = spec ? spec.defaultLevel : 'info';
    } else if (typeof src.level === 'string' && spec && spec.allowedLevels.includes(src.level)) {
      level = src.level;
    } else {
      level = spec ? spec.defaultLevel : 'info';
      levelAdjusted = true;
    }

    let message = typeof src.message === 'string' ? src.message : (src.message === undefined || src.message === null ? '' : String(src.message));
    const clippedMessage = clipChars(message, LIMITS.messageChars);
    if (clippedMessage !== message) { message = clippedMessage; truncated = true; }

    const record = { v: LOG_VERSION, ts: tsOf(src.now), level };
    if (src.side !== undefined) record.side = src.side;
    if (src.bootId !== undefined) record.bootId = src.bootId;
    if (typeof src.module === 'string' && src.module) record.module = src.module;
    record.event = event;
    record.message = message;

    // 可选字段：类型原样带上，交给 validateRecord 判断（makeRecord 只负责归一/截断）
    if (src.ok !== undefined) record.ok = src.ok;
    if (src.code !== undefined) record.code = src.code;
    if (src.blockedBy !== undefined) record.blockedBy = src.blockedBy;
    if (src.workspaceKey !== undefined) record.workspaceKey = src.workspaceKey;
    if (src.sessionId !== undefined) record.sessionId = src.sessionId;
    if (src.requestId !== undefined) record.requestId = src.requestId;
    if (src.durationMs !== undefined) record.durationMs = src.durationMs;

    const error = errorOf(src.error, level);
    if (error) { record.error = error.value; if (error.truncated) truncated = true; }

    const data = dataOf(src.data);
    if (data.value !== undefined) record.data = data.value;
    if (data.truncated) truncated = true;

    let out = record;
    if (lineBytesOf(out) > LIMITS.lineBytes) {
      out = degradeToFit(out);
      truncated = true;
    }
    if (truncated) out.truncated = true;
    if (levelAdjusted) out.levelAdjusted = true;
    return out;
  } catch (err) {
    // 构造阶段自己出错：给一条最小 log.invalid（仍是记录对象，不抛）
    return {
      v: LOG_VERSION,
      ts: tsOf(),
      level: 'warn',
      side: 'host',
      bootId: makeBootId(),
      event: 'log.invalid',
      message: clipChars('日志记录构造失败：' + String((err && err.message) || err), LIMITS.messageChars),
      truncated: true,
    };
  }
}

/** 失败结果（校验内部用；与 exception/result.js 同形状但不依赖它）。 */
const invalid = (reason) => ({ ok: false, reason: String(reason || '未知原因') });

/** 是否普通对象（数据字段用）。 */
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * 校验一条记录（LOG-SCHEMA §2/§3）。
 * **不抛异常**：返回 `{ok:true, value:record}` 或 `{ok:false, reason}`。
 * 检查：必填字段与类型、v/ts、事件已登记、level ∈ 该事件 allowedLevels、host 必有 bootId、
 * 可选字段类型、`error`/`data` 大小上限（超长的记录应在 makeRecord 里截断，这里直接拒）。
 * 未知字段**允许**（新增字段不升版本，读的人忽略）。
 * @param {unknown} record
 */
function validateRecord(record) {
  try {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return invalid('记录必须是普通对象');
    if (record.v !== LOG_VERSION) return invalid('v 必须是 ' + LOG_VERSION);
    if (typeof record.ts !== 'string' || !ISO_RE.test(record.ts) || Number.isNaN(Date.parse(record.ts))) {
      return invalid('ts 必须是 ISO 8601 UTC（带毫秒与 Z）');
    }
    if (!isKnownLevel(record.level)) return invalid('level 必须是 ' + LEVELS.join('/'));
    if (!isKnownEvent(record.event)) return invalid('事件未登记（新增事件必须先写进 EVENTS）');
    const spec = EVENTS[record.event];
    if (!spec.allowedLevels.includes(record.level)) {
      return invalid('事件 ' + record.event + ' 只允许级别 ' + spec.allowedLevels.join('/') + '，得到 ' + record.level);
    }
    if (record.side !== 'host' && record.side !== 'client') return invalid('side 必须是 host 或 client');
    if (record.side === 'host' && record.bootId === undefined) return invalid('side=host 必须带 bootId');
    if (record.bootId !== undefined && (typeof record.bootId !== 'string' || !BOOT_ID_RE.test(record.bootId))) {
      return invalid('bootId 必须是 8 位小写字母/数字');
    }
    if (typeof record.message !== 'string') return invalid('message 必须是字符串');
    if (record.message.length > LIMITS.messageChars) return invalid('message 超过 ' + LIMITS.messageChars + ' 字符');
    if (record.module !== undefined && typeof record.module !== 'string') return invalid('module 必须是字符串');
    if (record.ok !== undefined && typeof record.ok !== 'boolean') return invalid('ok 必须是布尔值');
    if (record.code !== undefined && typeof record.code !== 'string') return invalid('code 必须是字符串');
    if (record.blockedBy !== undefined && !BLOCKED_BY.includes(record.blockedBy)) {
      return invalid('blockedBy 必须是 ' + BLOCKED_BY.join('/'));
    }
    for (const key of ['workspaceKey', 'sessionId', 'requestId']) {
      if (record[key] !== undefined && typeof record[key] !== 'string') return invalid(key + ' 必须是字符串');
    }
    if (record.durationMs !== undefined && (typeof record.durationMs !== 'number' || !Number.isFinite(record.durationMs) || record.durationMs < 0)) {
      return invalid('durationMs 必须是非负有限数字');
    }
    if (record.error !== undefined) {
      const error = record.error;
      if (!isPlainObject(error)) return invalid('error 必须是对象');
      if (typeof error.name !== 'string' || typeof error.message !== 'string') return invalid('error.name / error.message 必须是字符串');
      if (error.message.length > LIMITS.errorMessageChars) return invalid('error.message 超过 ' + LIMITS.errorMessageChars + ' 字符');
      if (error.stack !== undefined) {
        if (record.level !== 'error') return invalid('error.stack 只允许出现在 error 级别');
        if (typeof error.stack !== 'string' || error.stack.length > LIMITS.errorStackChars) {
          return invalid('error.stack 必须是 ≤ ' + LIMITS.errorStackChars + ' 字符的字符串');
        }
      }
    }
    if (record.data !== undefined) {
      if (!isPlainObject(record.data)) return invalid('data 必须是对象');
      let json;
      try {
        json = JSON.stringify(record.data);
      } catch {
        return invalid('data 不可 JSON 序列化');
      }
      if (typeof json !== 'string' || byteLengthOf(json) > LIMITS.dataBytes) return invalid('data 超过 ' + LIMITS.dataBytes + ' 字节');
    }
    if (record.truncated !== undefined && typeof record.truncated !== 'boolean') return invalid('truncated 必须是布尔值');
    if (record.levelAdjusted !== undefined && typeof record.levelAdjusted !== 'boolean') return invalid('levelAdjusted 必须是布尔值');
    return { ok: true, value: record };
  } catch (err) {
    return invalid('校验时抛错：' + String((err && err.message) || err));
  }
}

/** 最小 `log.invalid` 记录（序列化失败时用）。 */
function minimalInvalidRecord(record, reason) {
  const side = record && record.side === 'client' ? 'client' : 'host';
  const validBootId = record && typeof record.bootId === 'string' && BOOT_ID_RE.test(record.bootId) ? record.bootId : makeBootId();
  const out = {
    v: LOG_VERSION,
    ts: tsOf(),
    level: 'warn',
    side,
    event: 'log.invalid',
    message: clipChars('日志序列化失败：' + String(reason || '未知原因'), LIMITS.messageChars),
    truncated: true,
  };
  if (side === 'host') out.bootId = validBootId;
  return out;
}

/** 模块加载时先造一个"兜底到极致"的固定行：连构造对象都失败时用。 */
const LAST_RESORT_LINE = JSON.stringify({
  v: LOG_VERSION,
  ts: '1970-01-01T00:00:00.000Z',
  level: 'warn',
  side: 'host',
  bootId: '00000000',
  event: 'log.invalid',
  message: '日志序列化失败',
});

/**
 * 记录 → 一行 JSON（JSONL）。**只用 `JSON.stringify`**，不手拼字符串；**永远不抛**。
 * 序列化失败（循环引用 / BigInt / 奇怪对象）→ 返回一条最小 `log.invalid` 行。
 * @param {unknown} record
 * @returns {string}
 */
function toLine(record) {
  try {
    const line = JSON.stringify(record);
    if (typeof line === 'string' && line) return line;
    return JSON.stringify(minimalInvalidRecord(record, 'JSON.stringify 没有返回字符串'));
  } catch (err) {
    try {
      return JSON.stringify(minimalInvalidRecord(record, (err && err.message) || err));
    } catch {
      return LAST_RESORT_LINE;
    }
  }
}


// ===== log/memory-sink.js =====
// dsh-milieu —— 客户端内存日志 sink（纯内存：不写文件、不访问宿主、无副作用）
//
// 依据 `plugin/dsh-milieu/LOG-SCHEMA.md` §6.2：
//   · 客户端**不直接写文件**；用内存环形缓冲（初始 200 条）；
//   · 保留现有 `criteria.debug` 调试行（那是界面用的，不是日志文件）；
//   · 需要排查时通过调试行或测试口子读取内存日志；**不把客户端日志写进工作区**。
//
// sink 的调用约定与 `log/logger.js` 一致：`write(line, record)`（函数或 `{ write }` 对象都行）。
// 这里额外接受**单参** `write(record)`，便于测试/调试直接塞一条记录。
// **不抛**：日志通道自身出错不能反噬主流程（LOG-SCHEMA §3/§7）。

/** 内存缓冲的默认上限（LOG-SCHEMA §6.2 的"初始 200 条"）。 */
const DEFAULT_MEMORY_LIMIT = 200;

/** 归一上限：正有限数取整；坏输入退回默认值。 */
function normalizeLimit(limit) {
  const n = Number(limit);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MEMORY_LIMIT;
}

/**
 * 造一个内存 sink（每个页面/插件实例一份；生命周期跟实例走，不落盘）。
 *
 * @param {{limit?: number}} [options] `limit` 默认 200 条
 * @returns {{
 *   limit: number,
 *   write: (lineOrRecord: unknown, record?: unknown) => void,
 *   list: () => object[],
 *   snapshot: () => {limit: number, size: number, records: object[]},
 *   size: () => number,
 *   clear: () => void,
 * }}
 *   · `list()`     —— 记录数组（旧→新，返回副本，改它不影响缓冲）；
 *   · `snapshot()` —— `{ limit, size, records }`（调试/测试一眼看全）；
 *   · 到上限**丢最旧**（环形缓冲语义）。
 */
function createMemorySink(options = {}) {
  const limit = normalizeLimit(options && options.limit);
  /** @type {object[]} 记录对象（不存 JSONL 行：记录本身就是源头，行只是序列化结果） */
  let records = [];

  /**
   * 收一条记录：
   *   · `write(line, record)` —— logger 的 sink 约定（第二个参数才是记录对象）；
   *   · `write(record)`       —— 单参用法（测试/调试直接塞记录）。
   * 永远不抛。
   */
  function write(lineOrRecord, record) {
    try {
      const item = (record !== null && record !== undefined && typeof record === 'object' && !Array.isArray(record))
        ? record
        : lineOrRecord;
      records.push(item);
      // 到上限丢最旧（一次写入保证不超上限，不会反复 splice）
      if (records.length > limit) records.splice(0, records.length - limit);
    } catch {
      /* 日志通道自身出错不反噬主流程（内存 sink 实现固定，理论上到不了这里） */
    }
  }

  return {
    limit,
    write,
    /** 记录数组（旧→新）的副本。 */
    list: () => records.slice(),
    /** `{ limit, size, records }`：调试/测试用的一眼快照。 */
    snapshot: () => ({ limit, size: records.length, records: records.slice() }),
    /** 当前条数。 */
    size: () => records.length,
    /** 清空（测试/调试用）。 */
    clear: () => { records = []; },
  };
}


// ===== log/logger.js =====
// dsh-milieu —— 日志器（log 层：构建记录、校验、写 sink；**不读写文件、不 import 'node:fs'**）
//
// 依据 `plugin/dsh-milieu/LOG-SCHEMA.md` v2。本文件只做四件事：
//   ① 用 `log/schema.js` 的 `makeRecord` / `validateRecord` / `toLine` 构建一行 JSONL；
//   ② 把这一行交给配置的 `sinks`（宿主文件 sink、客户端内存 sink 后续任务再接）；
//   ③ **日志自身失败不抛**：非法记录丢弃（每个 logger 最多记一条 `log.invalid`，不递归）；
//      某个 sink 抛错 → 该 sink 禁用，**最多一次**回退提示（不刷屏）；
//   ④ 兼容旧调用 `info/warn/error(message)` → `log.message` 事件。
//
// 两种用法（同一入口，靠形状区分）：
//   · 旧形态：`createLogger(hostLogger)` —— 保持重构前行为：把**原文**交给宿主 logger，
//     不加前缀、不改文案（boot/index 现在还是这么用的；后续任务再换 record/event）。
//   · 新形态：`createLogger({ side, bootId, module, sinks, hostLogger })` —— 构建/校验/写 sinks。
//     `hostLogger` 只作为最后的回退提示通道（不接收每一条日志）。
//
// 纪律：不新增日志文件、不做轮转（那是 `log/file-sink.js` 的事）。



/** 配置形态的键（出现任意一个、且不是宿主 logger 时，按新形态解释）。 */
const CONFIG_KEYS = ['side', 'bootId', 'module', 'sinks', 'hostLogger'];

/**
 * 这个值像不像"新形态配置"（而不是旧形态的宿主 logger 对象）。
 * 先认"像 logger"的形状（有 info/warn/error 函数）：宿主 logger 即使碰巧有 `module` 字段也不误判。
 */
function isConfigShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.info === 'function' || typeof value.warn === 'function' || typeof value.error === 'function') return false;
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  }
  return false;
}

/** sink 归一：函数或 `{ write(line, record) }`；其他形状忽略。 */
function normalizeSink(sink) {
  if (typeof sink === 'function') return { sink, disabled: false };
  if (sink && typeof sink === 'object' && typeof sink.write === 'function') return { sink, disabled: false };
  return null;
}

/**
 * 造一个日志器。
 * @param {object|Function|null} [options] 旧形态给宿主 logger；新形态给配置
 * @returns {{record:Function, event:Function, info:Function, warn:Function, error:Function}}
 */
function createLogger(options) {
  const legacy = !isConfigShape(options);
  const config = legacy ? { legacy: true, hostLogger: options || null } : options;
  const side = config.side === 'client' ? 'client' : 'host';
  const bootId = typeof config.bootId === 'string' && config.bootId ? config.bootId : (side === 'host' ? makeBootId() : null);
  const moduleName = typeof config.module === 'string' && config.module ? config.module : null;
  const hostLogger = config.hostLogger && typeof config.hostLogger === 'object' ? config.hostLogger : null;
  const sinkStates = (Array.isArray(config.sinks) ? config.sinks : []).map(normalizeSink).filter(Boolean);

  // 日志器自身的状态（只增不减，防刷屏/防递归）
  const state = {
    invalidLogged: false,   // 每个 logger 最多一条 log.invalid
    fallbackNotified: false, // 回退提示最多一次
    legacyDisabled: false,  // 旧形态的宿主 logger 失败后禁用
  };

  /** 回退提示：控制台优先（日志通道坏了时它是最后一根可用的通道），最多一次。 */
  function notifyFallback(err) {
    if (state.fallbackNotified) return;
    state.fallbackNotified = true;
    const reason = String((err && err.message) || err);
    const text = '[milieu] 日志写不进去（该通道已禁用）：' + reason;
    try {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(text);
        return;
      }
    } catch {
      /* 控制台也没有：继续找宿主 logger */
    }
    try {
      if (hostLogger && typeof hostLogger.warn === 'function') hostLogger.warn(text);
    } catch {
      /* 回退提示也写不进去：只能放弃（不能抛） */
    }
  }

  /** 把一行交给所有可用 sink；某个 sink 抛错就禁用它（不抛、不刷屏）。 */
  function writeLine(line, record) {
    let written = 0;
    for (const target of sinkStates) {
      if (target.disabled) continue;
      try {
        if (typeof target.sink === 'function') target.sink(line, record);
        else target.sink.write(line, record);
        written += 1;
      } catch (err) {
        target.disabled = true;
        notifyFallback(err);
      }
    }
    return written;
  }

  /**
   * 非法记录：丢弃，并**最多**写一条 `log.invalid`（不递归、不再校验失败时静默）。
   * @param {string} reason
   */
  function dropInvalid(reason) {
    if (state.invalidLogged) return;
    state.invalidLogged = true;
    try {
      const invalidRecord = makeRecord({
        event: 'log.invalid',
        message: '一条日志结构非法，已丢弃：' + clipChars(reason, 200),
        side,
        bootId: bootId === null ? undefined : bootId,
        module: moduleName || undefined,
      });
      const checked = validateRecord(invalidRecord);
      const record = checked.ok ? checked.value : invalidRecord;
      writeLine(toLine(record), record);
    } catch {
      /* 连 log.invalid 都造不出来：只能丢弃（日志不能反噬主流程） */
    }
  }

  /**
   * 写一条记录（新形态）。
   * @param {object} input 事件与字段；logger 绑定的 side/bootId/module 作为默认（显式字段可覆盖）
   * @returns {{ok:true, record:object, line:string, written:number}|{ok:false, reason:string}}
   */
  function record(input) {
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const merged = { side };
    if (bootId !== null) merged.bootId = bootId;
    if (moduleName) merged.module = moduleName;
    for (const key of Object.keys(src)) {
      if (src[key] !== undefined) merged[key] = src[key];
    }
    let built;
    try {
      built = makeRecord(merged);
    } catch (err) {
      // makeRecord 设计上不抛；万一抛了也不向上抛
      const reason = '构建日志记录失败：' + String((err && err.message) || err);
      dropInvalid(reason);
      return { ok: false, reason };
    }
    const checked = validateRecord(built);
    if (!checked.ok) {
      dropInvalid(checked.reason);
      return { ok: false, reason: checked.reason };
    }
    const line = toLine(checked.value);
    const written = writeLine(line, checked.value);
    return { ok: true, record: checked.value, line, written };
  }

  /**
   * 写一条事件日志（新形态的常用入口）。
   * @param {string} event 已登记的事件名
   * @param {string} message 人话
   * @param {object} [fields] 其余字段（level / ok / code / data …）
   */
  function event(name, message, fields) {
    const extra = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
    return record({ ...extra, event: name, message });
  }

  /** 旧形态：把原文交给宿主 logger（行为与重构前一致；失败一次后禁用，不刷屏）。 */
  function writeLegacy(level, message) {
    if (state.legacyDisabled) return false;
    try {
      const logger = hostLogger && typeof hostLogger === 'object' ? hostLogger : null;
      const fn = logger && logger[level];
      if (typeof fn === 'function') {
        fn.call(logger, message);
        return true;
      }
    } catch (err) {
      state.legacyDisabled = true;
      notifyFallback(err);
    }
    return false;
  }

  /** `info/warn/error`：旧形态走原文；新形态走 `log.message` 事件。 */
  const levelMethod = (level) => (message) => {
    if (legacy) return writeLegacy(level, message);
    return record({ event: 'log.message', level, message: typeof message === 'string' ? message : String(message) });
  };

  return {
    record,
    event,
    info: levelMethod('info'),
    warn: levelMethod('warn'),
    error: levelMethod('error'),
  };
}


// ===== ui/card.js =====
// dsh-milieu —— 客户端卡片（纯 React，无副作用）
//
// 它是什么：切进会话时那条"要不要重读"的提示卡。
//   样子参照提权卡：一句话说清 + 两个按钮。
//
// 纪律（官方 UI 规矩 + 我们自己的）：
//   · **只 import react**（来自浏览器模块表）；**绝不 import 任何 Harness 客户端包**；
//   · 样式**只用 `--dsw-alias-*` 主题 token**，不写死颜色（写死的颜色在深色主题下会瞎）；
//   · **工厂无副作用**；资源注册在 apply 里，返回清理；
//   · 文案走字典（先内置中英，后续接 Client locale 服务）。
//
// 它**不做判断**：该不该弹由 `core/criteria.js` 的纯判据决定，能不能读由宿主/接口决定。
// 组件只负责"显示 + 把用户的选择报上去"。

const h = (React) => React.createElement;

const CARD_TEXT = {
  zh: {
    title: '这个工作区变了',
    body: '你上次用这条会话之后，工作区有改动。要不要我先重读一遍，再接着干？',
    review: '重读',
    skip: '不用，直接继续',
    more: '等 {n} 项',
    reviewHint: '（读完我会把新认识写回认知库）',
  },
  en: {
    title: 'This workspace changed',
    body: 'The workspace changed since you last used this session. Should I re-read it before we continue?',
    review: 'Re-read',
    skip: 'No, continue',
    more: 'and {n} more',
    reviewHint: '(I will write what I learn back into the review library)',
  },
};

/** 把变更索引压成几行人话（最多列 3 条，其余给数量）。 */
function summarizeChangeIndex(changeIndex, locale = 'zh') {
  const t = CARD_TEXT[locale] || CARD_TEXT.zh;
  const pick = (list, label) => (Array.isArray(list) && list.length ? { label, items: list } : null);
  const groups = [
    pick(changeIndex && changeIndex.reviewAdded, '认知库新增'),
    pick(changeIndex && changeIndex.reviewChanged, '认知库改动'),
    pick(changeIndex && changeIndex.reviewGone, '认知库消失'),
    pick(changeIndex && changeIndex.otherChanged, '其余库改动'),
    pick(changeIndex && changeIndex.otherAdded, '其余库新增'),
    pick(changeIndex && changeIndex.otherGone, '其余库消失'),
  ].filter(Boolean);
  const lines = [];
  for (const g of groups) {
    const shown = g.items.slice(0, 3);
    const rest = g.items.length - shown.length;
    lines.push(g.label + '：' + shown.join('、') + (rest > 0 ? '　' + t.more.replace('{n}', String(rest)) : ''));
  }
  return lines;
}

/**
 * 卡片组件。
 * @param props.changeIndex 变更索引（形状见 summary.js 的产物）
 * @param props.locale 'zh' | 'en'
 * @param props.onReview 点"重读"
 * @param props.onSkip 点"不用"
 * @param props.onDismiss 用户直接发请求 → 自动关闭
 */
function MilieuReturnCard(React, props) {
  const e = h(React);
  const { changeIndex, locale = 'zh', onReview, onSkip, onDismiss } = props || {};
  const t = CARD_TEXT[locale] || CARD_TEXT.zh;
  const lines = summarizeChangeIndex(changeIndex, locale);

  // 用户直接开始打字 → 卡片自己关掉（"用户直接发请求，就关闭本提示"）
  const onKeyDown = (ev) => {
    if (ev && (ev.key === 'Enter' || ev.key === 'Escape')) onDismiss && onDismiss();
  };

  return e('div', {
    role: 'group',
    'aria-label': t.title,
    onKeyDown,
    style: {
      // 只用主题 token：写死颜色在深色主题下会瞎
      border: '1px solid var(--dsw-alias-border-secondary, #d9d9d9)',
      background: 'var(--dsw-alias-bg-elevated, #fff)',
      color: 'var(--dsw-alias-label-primary, #111)',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      padding: '10px 12px',
      margin: '8px 0',
      font: 'inherit',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    },
  },
    e('div', { style: { fontWeight: 600 } }, t.title),
    e('div', { style: { color: 'var(--dsw-alias-label-secondary, #555)' } }, t.body),
    lines.length
      ? e('ul', { style: { margin: '2px 0 0 18px', color: 'var(--dsw-alias-label-tertiary, #666)', fontSize: 'var(--dsh-content-font-size-secondary, 13px)' } },
          lines.map((l, i) => e('li', { key: i }, l)))
      : null,
    e('div', { style: { display: 'flex', gap: '8px', marginTop: '2px' } },
      e('button', {
        type: 'button',
        onClick: () => onReview && onReview(),
        style: { cursor: 'pointer', padding: '4px 10px', borderRadius: 'var(--dsw-radius-sm, 6px)',
                 border: '1px solid var(--dsw-alias-border-secondary, #d9d9d9)',
                 background: 'var(--dsw-alias-bg-accent, #eef4ff)', color: 'inherit', font: 'inherit' },
      }, t.review),
      e('button', {
        type: 'button',
        onClick: () => onSkip && onSkip(),
        style: { cursor: 'pointer', padding: '4px 10px', borderRadius: 'var(--dsw-radius-sm, 6px)',
                 border: '1px solid var(--dsw-alias-border-secondary, #d9d9d9)',
                 background: 'transparent', color: 'inherit', font: 'inherit' },
      }, t.skip)),
    e('div', { style: { color: 'var(--dsw-alias-label-tertiary, #666)', fontSize: '12px' } }, t.reviewHint));
}


// ===== ui/card-criteria.js =====
// dsh-milieu —— 客户端判据（纯函数，无副作用，可离线测）
//
// 它只回答一件事：**这张卡该不该弹。**
// 阈值判据**复用 `core/criteria.js` 的 `shouldPromptOnReturn`**——判断只能有一处，这里不另写一份。
//
// 不在这里做的事（各归各处）：
//   · 算变更 → 宿主（要读文件系统），结果落在 `model/state.js` 描述的状态文件里；
//   · 画界面 → `ui/card.js`；
//   · 读文件 → `client.js`（用现成的 workspaceFiles Remote）。




/** 客户端自己记的"这条会话弹过了"（**只活在页面里**，不进工作区）。 */
const CLIENT_MEMORY_LIMIT = DEFAULT_CRITERIA.clientMemoryLimit;

/** 记一次"弹过了"。返回新对象（不改原对象）。`limit` 可被状态文件里的 criteria 覆盖。 */
function markShown(memory, sessionId, at, limit = CLIENT_MEMORY_LIMIT) {
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
function alreadyShown(memory, sessionId) {
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
 *   ⑤ **距这条会话最后活动 ≥ `promptThresholdMs`**（core/criteria.js 的 `shouldPromptOnReturn`）。
 *
 * 第 ④ 关就是"重读阈值"的另一半：**不只是时间，还要变化数量够**。
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
function shouldShowCard(currentSessionId, stateText, memory, opts = {}) {
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

  // ⑤ 变化够不够大：先用 normalizeChangeIndex **归一**，再交给 core/criteria.js 的判据。
  //    这一步曾经漏掉过——两套字段名让"有变化"变成了"没变化"，自测当场抓住。
  const flat = normalizeChangeIndex(state.changeIndex);
  const inv = evaluateInvalidation(flat, null, criteria);
  if (!inv.prompt) return NO(inv.reason);

  // ⑥ 时间够不够久：距这条会话最后活动 ≥ 阈值。
  const gate = shouldPromptOnReturn(activityAt, flat, now, thresholdMs);
  if (!gate.prompt) return NO(gate.reason);

  return { show: true, reason: gate.reason, changeIndex: state.changeIndex, totals: changeTotals(state.changeIndex) };
}


// ===== ui/activity.js =====
// dsh-milieu —— 当前会话与最后活动时间（界面层工具：无副作用、不碰 ctx）
//
// 两件事：
//   ① 当前主视图在看哪条会话（平台用 `retainedBy.mainView > 0` 表示）；
//   ② 这条会话的**最后活动时间**——判据最后一关的基准。
//
// 为什么不自己记"上次读"（2026-10-16 主人定的口径）：
//   平台会话列表里本来就有 `updatedAt`；我们另记一份 = 同一件事两个版本，一旦不一致不报错。
//   **只在用会话，改动基本可以忽略**；会话搁置了才需要提醒"变了，要不要重读"。
//
// 责任边界（ARCHITECTURE.md 工作包 C）：这里只处理数据形状；`ctx` 的扩展点由
//   `ui/plugin.js` 取好再传进来（调用方传 `ctx.sessions`），本文件不直接碰 ctx。

/**
 * 取当前会话 id：平台用 `retainedBy.mainView > 0` 表示"主视图正在看它"。
 * 认不出来返回 null（**null 表示"这次没认出来"，不是"切到了空会话"**——调用方别拿它清空状态）。
 * @param {object} sessions `ctx.sessions`（可能没有）
 */
function currentMainSessionId(sessions) {
  const list = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot();
  if (!list || !list.byId) return null;
  // 优先用调用方给的首选 id（插槽 props 里通常有），其次按主视图计数找
  for (const id of list.ids || Object.keys(list.byId)) {
    const row = list.byId[id];
    if (row && (row.retainedBy && row.retainedBy.mainView ? row.retainedBy.mainView : 0) > 0) return id;
  }
  return null;
}

/**
 * 取这条会话的**最后活动时间**——判据第 ④ 关的基准。
 * 来源是平台会话列表里的 `updatedAt`（不另存一份"上次读"）。
 * 拿不到就返回 null → 判据走"保守提示"。
 * @param {object} sessions `ctx.sessions`（可能没有）
 * @param {string} sessionId
 */
function sessionActivityAt(sessions, sessionId) {
  const list = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot();
  const row = list && list.byId && list.byId[sessionId];
  const at = row && (typeof row.updatedAt === 'number' ? row.updatedAt : (typeof row.lastActivityAt === 'number' ? row.lastActivityAt : null));
  return typeof at === 'number' ? at : null;
}


// ===== ui/state-reader.js =====
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



/** 状态文件在**认知库**里的相对路径。宿主写、这里读。 */
const STATE_REL_PATH = 'review/milieu-state.json';

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
function createStateReader({ getRemote, getTimeoutMs, log = () => {}, event = () => {} }) {
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


// ===== ui/remote.js =====
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
async function promptReadViaRemote(o = {}) {
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


// ===== ui/error-boundary.js =====
// dsh-milieu —— 卡片渲染错误边界（界面层：卡片坏了只跳过，不把 slot 整块搞白）
//
// 为什么要有它（task-5）：卡片是**装饰**。装饰崩了正确行为是"这次不显示"，
//   而不是把异常抛进插槽、让整块聊天尾巴白掉（甚至影响宿主渲染）。
//   策略：**fail-open**——渲染 null，失败经 `onError` 报一次，不重新抛。
//
// 为什么是工厂而不是直接一个类：界面层只从浏览器模块表拿到 `React`（`require('react')`），
//   不能 `import react`；所以类必须在拿到 React 之后才造得出来。
//   离线假 React（测试里只有 `createElement`）没有 `Component` → 退化成**直通组件**，
//   让同一份边界代码在真浏览器与离线测试里都不炸（真 React 一定有 Component）。



/**
 * 造一个错误边界组件。
 * @param {object} React 浏览器模块表给的 React（或测试里的假 React）
 * @param {{onError?: (failure: object) => void}} [options]
 *   `onError` 收到的是归一后的失败结果（`{ok:false, code, reason, blockedBy, cause}`），
 *   由调用方决定怎么报（本文件不直接写日志：界面层没有 logger，也不该知道日志长什么样）。
 * @returns {Function|class} 可以直接给 `React.createElement` 用的组件
 */
function createErrorBoundary(React, options = {}) {
  const onError = options && typeof options.onError === 'function' ? options.onError : null;
  const Base = React && (typeof React.Component === 'function'
    ? React.Component
    : (typeof React.PureComponent === 'function' ? React.PureComponent : null));

  // 没有类组件（离线假 React）：退化成直通组件。真实浏览器里不会走到这条。
  if (!Base) {
    return function MilieuErrorBoundaryPassthrough(props) {
      return props && props.children !== undefined ? props.children : null;
    };
  }

  class MilieuErrorBoundary extends Base {
    constructor(props) {
      super(props);
      this.state = { crashed: false };
    }

    /** React 16+ 的"渲染出错"钩子：切到"已崩"状态，下一次 render 返回 null。 */
    static getDerivedStateFromError() {
      return { crashed: true };
    }

    /** 出错后的报告：只报一次；`onError` 自己坏了也不能再抛（边界不能二次崩溃）。 */
    componentDidCatch(error) {
      if (!onError) return;
      try {
        onError(normalizeError(error, { code: CODES.UI_RENDER_FAILED, blockedBy: 'ui' }));
      } catch {
        /* 报告口自己坏了：这里再抛就绕过边界了，只能吞掉 */
      }
    }

    render() {
      if (this.state && this.state.crashed) return null;
      return this.props ? this.props.children : null;
    }
  }

  return MilieuErrorBoundary;
}


// ===== ui/plugin.js =====
// dsh-milieu —— 客户端装配（界面层：注册插槽、盯当前会话、喂判据、处理收场）
//
// 它做三件事，而且**只做这三件**：
//   ① 看住"当前是哪条会话"（`retainedBy.mainView` 计数变了就是切换；插槽也会直接把 sessionId 交进来）；
//   ② 切到**我们管的**那条时，读状态文件、喂判据；
//   ③ 判据说该弹，就把卡片注册进插槽；你点"重读"/"不用"/直接打字，卡片收场。
//
// 分层的落点（ARCHITECTURE.md 工作包 C）——这里只负责"接线"，其余各归各处：
//   · 判据 → `ui/card-criteria.js`（纯函数）；卡片 → `ui/card.js`（只渲染、不读数据）；
//   · 读文件 → `ui/state-reader.js`；当前会话/活动时间 → `ui/activity.js`；发请求 → `ui/remote.js`；
//   · 日志 → `log/logger.js` + `log/memory-sink.js`（客户端只进内存环形缓冲，见 LOG-SCHEMA §6.2）；
//   · **本文件是 UI 层唯一直接接触 `ctx.slots` / `ctx.sessions` 的地方**（remote 也由这里取好传给别的文件）。
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不需要自己装一份。
//
// 官方 UI 硬规矩（照办）：只用主题 token 上色、不 import 任何 Harness 客户端包、
//   不写 DOM、不动 document.body、注册进插槽而不是自己找位置。
















/** 我们注册进插槽的卡片 id（同一次会话只应有一个）。 */
const CARD_SLOT_ID = 'dsh-milieu:return-card';

/**
 * **依赖声明**（客户端 Cordis 契约）：用到的服务/命名空间必须列全，访问未声明的会抛
 * `cannot get property … without inject`。`sessions` 我们一直在用，之前漏了——
 * 离线假 ctx 不检查这个，真机上才会炸（2026-10-18）。
 * 入口（`client.js`）与这里共用同一份，不各写一份。
 */
const CLIENT_INJECT = ['slots', 'sessions', 'remote', 'remote.workspaceFiles', 'remote.session'];

/**
 * 造客户端插件主体。**导出成函数是为了能离线测**：
 * 测试里传一个假的 ctx（假的 slots / remote / sessions），就能验"接线"对不对，
 * 不用真浏览器、不用真宿主。
 *
 * @param {object} deps { React, ctx, bootId? }
 *   · `bootId` 可选：客户端一般拿不到宿主 bootId；给了合法的（8 位小写字母/数字）就带进日志。
 */
function createClientPlugin({ React, ctx, bootId }) {
  // 客户端自己记的"这条会话弹过了"——只活在页面里，不进工作区。
  let shownMemory = {};
  // **生效判据**：先默认；每次读到状态文件后按文件里的 `criteria` 更新（宿主写的同一份）。
  let effectiveCriteria = mergeCriteria(DEFAULT_CRITERIA);
  // 每次判断的结果（同一次切换不重复算）
  let current = { sessionId: null, decision: { show: false }, state: null, pending: false };

  // ---- 客户端日志（LOG-SCHEMA §6.2）：只进**内存环形缓冲**（200 条），不写文件、不写工作区 ----
  //   · `side:"client"`；`bootId` 可选（非法形状当没给，免得整条记录校验失败）；
  //   · 旧 `log(level, msg)` 兼容 `info/warn/error`（→ `log.message` 事件），
  //     并**保持原有宿主 logger 输出**（既有可见行为不变）；
  //   · 关键事件（card.* / ui.read.failed / error.caught）走结构化 `clientLogger.event`。
  const memorySink = createMemorySink();
  const clientLogger = createLogger({
    side: 'client',
    bootId: typeof bootId === 'string' && BOOT_ID_RE.test(bootId) ? bootId : undefined,
    module: 'ui.plugin',
    sinks: [memorySink],
  });

  const log = (level, msg) => {
    try {
      const logger = ctx && ctx.logger;
      if (logger && typeof logger[level] === 'function') logger[level]('[milieu] ' + msg);
    } catch {
      /* 宿主 logger 自己坏了：界面不能因为写日志而崩 */
    }
    // 同一句也进客户端内存日志（结构化 `log.message`）；日志层自己保证不抛。
    try {
      if (typeof clientLogger[level] === 'function') clientLogger[level](msg);
    } catch {
      /* 日志不能反噬主流程 */
    }
  };

  /** 结构化事件：只进客户端内存日志（不写工作区、不额外刷宿主日志）。 */
  const logEvent = (name, message, fields) => {
    try { clientLogger.event(name, message, fields); } catch { /* 同上 */ }
  };

  /**
   * guard 用的日志口：guard 的文案不带前缀，由 `log` 补 `[milieu] `。
   * `log` 是 `(level, message)` 函数形状 → guard 支持函数形状的 log 口。
   */
  const guardLog = (level, message) => log(level, message);

  /**
   * 卡片错误边界（fail-open）：卡片渲染崩了只吞掉卡片本身，**不把异常抛进 slot**。
   * 假 React（离线测试）没有 `Component` 时，工厂会退化成直通组件（见 ui/error-boundary.js）。
   */
  const CardBoundary = createErrorBoundary(React, {
    onError: (failure) => log('warn', '卡片渲染失败（已跳过）：' + failure.reason),
  });

  /**
   * 取平台会话列表（当前会话 id 与最后活动时间都从它算）。
   * **真环境的 ctx 是代理：读未声明的属性会抛错**，所以包起来读——也不让坏 ctx 把界面搞崩。
   */
  const sessionsOf = () => {
    try { return ctx ? ctx.sessions : undefined; } catch { return undefined; }
  };

  /**
   * 读状态文件：两种签名、`{ok,value}` 拆包、超时都在 state-reader 里；
   * 这里只拿文本，并把"生效判据"交进去（读超时也走判据）。
   */
  const stateReader = createStateReader({
    getRemote: () => { try { return ctx ? ctx.remote : undefined; } catch { return undefined; } },
    getTimeoutMs: () => effectiveCriteria.readTimeoutMs,
    log,
    event: logEvent,
  });

  /**
   * 重新判断一次（切换会话或状态变化时调用）。
   *
   * 异常边界（task-5）：判据/读文件是**可选装饰**（fails-open）——意料之外的 throw 归一、
   *   记一条 info、把 `pending` 复位并保持"不弹"，**不让 Promise 拒绝泄漏成 unhandledRejection**。
   */
  async function reevaluate(sessionId) {
    const guarded = await guardAsync('判断是否弹卡', () => reevaluateOnce(sessionId), {
      optional: true,
      log: guardLog,
      code: CODES.UI_READ_FAILED,
      blockedBy: 'ui',
    });
    if (guarded && guarded.ok === false) {
      current = {
        sessionId: sessionId === undefined ? current.sessionId : sessionId,
        decision: { show: false, reason: '判断失败（已跳过）：' + guarded.reason },
        state: current.state,
        pending: false,
      };
      return current;
    }
    return current;
  }

  /** 判断的内部实现（失败分支都返回，不抛）。 */
  async function reevaluateOnce(sessionId) {
    if (!sessionId) { current = { sessionId: null, decision: { show: false }, state: null, pending: false }; return; }
    if (current.pending) return;                       // 不并发读同一件事
    current = { ...current, sessionId, pending: true };
    const text = await stateReader.read(sessionId);
    const parsed = parseState(text);
    const criteria = mergeCriteria(DEFAULT_CRITERIA, parsed && parsed.criteria);
    effectiveCriteria = criteria;
    const decision = shouldShowCard(sessionId, text, shownMemory, {
      now: Date.now(),
      activityAt: sessionActivityAt(sessionsOf(), sessionId),
      criteria,
      thresholdMs: criteria.promptThresholdMs,
    });
    current = { sessionId, decision, state: text, criteria, pending: false };
    log('info', '会话 ' + sessionId + ' → ' + (decision.show ? '该弹卡' : '不弹') + '（' + decision.reason + '）');
    // 结构化事件：卡片出现（LOG-SCHEMA `card.show`）。只进内存日志，不影响判据/渲染。
    if (decision.show) {
      logEvent('card.show', '重读卡片出现', {
        ok: true,
        sessionId,
        data: decision.totals ? { total: decision.totals.total } : undefined,
      });
    }
    bump();                                            // 通知插槽重画
  }

  // ---- 插槽重画：用一个极小的订阅点，避免自己造状态机 ----
  let listeners = new Set();
  /**
   * 插槽重画（异常边界：fail-open）。一个订阅者抛错只跳过它，绝不让异常漏进 React/slot；
   * 可选装饰的失败只记 info（guard 的 optional 模式）。
   */
  const bump = () => {
    for (const fn of [...listeners]) {
      guardSync('插槽重画订阅者', fn, {
        optional: true, log: guardLog, code: CODES.UI_RENDER_FAILED, blockedBy: 'ui',
      });
    }
  };

  /** 卡片组件：插槽渲染它；它**只读**当前判断结果（不写任何状态，保持纯净）。 */
  function ReturnCardView(props) {
    // **订阅 `bump`**：异步 `reevaluate` 完成后要能触发本组件重画；
    // 否则第一次渲染返回 null 之后就再也不会更新（卡片永远不出现）。
    const [, forceRender] = React.useState(0);
    React.useEffect(() => {
      const rerender = () => forceRender((v) => v + 1);
      listeners.add(rerender);
      return () => { listeners.delete(rerender); };
    }, []);

    // 渲染边界（task-5）：整个渲染体里的意外 throw 都**不能漏进 slot**——
    //   归一、记一条 info（可选装饰，fail-open）、这次渲染 null；卡片元素还会再套一层 class 边界。
    const rendered = guardSync('渲染卡片视图', () => renderCardBody(props), {
      optional: true, log: guardLog, code: CODES.UI_RENDER_FAILED, blockedBy: 'ui',
    });
    if (rendered && rendered.ok === false) return null;
    return rendered === undefined ? null : rendered;
  }

  /** ReturnCardView 的渲染体（拆出来是为了整体包边界；返回元素树或 null，不抛）。 */
  function renderCardBody(props) {
    // **插槽是 session 作用域**：它直接把当前会话 id 交给我们（`props.sessionId`），
    // 比 `ctx.sessions.list` 里的 `retainedBy.mainView` 可靠。
    // 没有这个 prop 时，才退回原来的“按主视图计数找当前会话”。
    const slotSessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null;

    // 排查用：`criteria.debug` 为真时，在聊天里渲染一行自报状态（平时关）。
    const debug = !!(effectiveCriteria && effectiveCriteria.debug);
    const debugLine = (d0) => {
      const lr = stateReader.last();
      return React.createElement('div', {
        style: { font: '12px monospace', color: '#c00', border: '1px dashed #c00', padding: '4px', margin: '4px 0' },
      }, '[milieu] client alive | slot=' + String(slotSessionId) + ' | current=' + String(current.sessionId) + ' | show=' + String(!!(d0 && d0.show)) + ' | reason=' + String((d0 && d0.reason) || '') + ' | state=' + (current.state ? 'yes' : 'no') + ' | read=' + (lr.ok ? 'ok via ' + lr.via : lr.reason));
    };

    if (slotSessionId && slotSessionId !== current.sessionId) {
      // 不在渲染里直接做异步副作用：推到微任务；pending 期间不会重复排队。
      // 这个微任务也要有边界：再抛出去就是 unhandledRejection（界面层没有进程级兜底）。
      Promise.resolve().then(() => {
        guardSync('插槽会话切换', () => {
          if (slotSessionId !== current.sessionId) void reevaluate(slotSessionId);
        }, { optional: true, log: guardLog, code: CODES.UI_READ_FAILED, blockedBy: 'ui' });
      });
      return debug ? debugLine(null) : null;
    }

    const d = current.decision;
    if (!d || !d.show) return debug ? debugLine(d) : null;
    /**
     * 卡片本体（task-5 边界）：
     *   ① 先在 `guardSync` 里**造**元素——卡片构造抛错时渲染 null，不把 slot 搞白；
     *   ② 再套一层 React 错误边界——真跑渲染时更深处的错也被接住（class 边界见 ui/error-boundary.js）。
     */
    const card = guardSync('渲染卡片', () => MilieuReturnCard(React, {
      changeIndex: d.changeIndex,
      locale: 'zh',
      onReview: () => guardSync('处理「重读」选择', () => {
        log('info', '你点了"重读"');
        // **点"重读" = 发一次请求**（与用户发请求等价，主人 2026-10-13 定的）。
        // 走**现成的 `session/prompt` Remote**——不用自建 Remote、不用代码生成。
        // 先把要带的东西取下来（收场之后 current 就变了），再异步发：
        //   · changeIndex —— 兜底用的路径清单；
        //   · events      —— **事件流**（两种视图由它算：大小变化 / 只给文件名）；
        //   · activityAt  —— 这条会话的最后活动时间（决定视图 A 还是 B）。
        const changeIndex = d.changeIndex;
        const targetId = current.sessionId;
        const parsed = parseState(current.state);
        const events = parsed ? parsed.events : null;
        const activityAt = sessionActivityAt(sessionsOf(), targetId);
        logEvent('card.review', '用户点了「重读」', { ok: true, sessionId: targetId });
        if (typeof onUserChoice === 'function') onUserChoice('review', targetId);
        dismiss('review');
        void sendRead(targetId, changeIndex, events, activityAt);
      }, { optional: true, log: guardLog, code: CODES.UI_SEND_FAILED, blockedBy: 'ui' }),
      onSkip: () => guardSync('处理「不用」选择', () => {
        log('info', '你点了"不用"');
        logEvent('card.skip', '用户点了「不用」', { ok: true, sessionId: current.sessionId });
        if (typeof onUserChoice === 'function') onUserChoice('skip', current.sessionId);
        dismiss('skip');
      }, { optional: true, log: guardLog, code: CODES.UI_INIT_FAILED, blockedBy: 'ui' }),
      onDismiss: () => guardSync('处理卡片自动关闭', () => {
        log('info', '你直接开始了（卡片自动关闭）');
        logEvent('card.skip', '用户直接开始（卡片自动关闭）', { ok: true, sessionId: current.sessionId });
        dismiss('typed');
      }, { optional: true, log: guardLog, code: CODES.UI_INIT_FAILED, blockedBy: 'ui' }),
    }), { optional: true, log: guardLog, code: CODES.UI_RENDER_FAILED, blockedBy: 'ui' });
    // 卡片构造失败：这次不显示（fail-open），异常已被报告过 → 渲染 null。
    if (card && card.ok === false) return null;
    const bounded = React.createElement(CardBoundary, null, card);
    return debug ? React.createElement('div', null, debugLine(d), bounded) : bounded;
  }

  /**
   * 卡片收场：三种收场（重读 / 不用 / 直接打字）**都要记进"弹过了"**。
   *
   * 两个踩过的坑，都记在这：
   *   ① 只在渲染时记 → "先弹、再收场、再轮询一次"时卡片又回来了；
   *   ② 记在 `current.sessionId` 名下 → 若用户在此期间切过会话，那个 id 已经过期，
   *      于是会记错人、卡片照样回来。**收场是对"用户此刻看的那条"表态**，
   *      所以要按**当下主视图**记（算不出就退回 current）。
   */
  function dismiss(how) {
    const liveId = currentMainSessionId(sessionsOf()) || current.sessionId;
    if (liveId) shownMemory = markShown(shownMemory, liveId, Date.now(), effectiveCriteria.clientMemoryLimit);
    current = { ...current, sessionId: liveId, decision: { show: false, reason: '已收场：' + how } };
    bump();
  }

  // 由 apply 注入的回调（放外面便于测试替换）
  let onUserChoice = null;

  /**
   * 真正发出去：走现成的 `session/prompt` Remote。
   * 这是**最后一段线**——在此之前只把决定报出去、没人发；现在接上了。
   * 失败不静默：写日志，并通过 `onSendResult` 让界面/测试能知道。
   *
   * 异常边界（task-5）：发送是**用户动作**（不是装饰）——意外 throw 归一后**必须**回报
   *   （日志 + onSendResult），不静默、也不抛到点击回调里。
   */
  async function sendRead(sessionId, changeIndex, events, activityAt) {
    const guarded = await guardAsync('发送重读请求', () => sendReadOnce(sessionId, changeIndex, events, activityAt), {
      optional: false,
      log: guardLog,
      code: CODES.UI_SEND_FAILED,
      blockedBy: 'ui',
    });
    if (guarded && guarded.ok === false && guarded.code) {
      // guard 捕获的意外异常：边界已经报过一次；这里只把结果回报给界面/测试，不重复写日志。
      if (typeof onSendResult === 'function') onSendResult(guarded);
    }
    return guarded;
  }

  /** 发送的内部实现（已知失败返回报告，由这里统一写日志 + 回调）。 */
  async function sendReadOnce(sessionId, changeIndex, events, activityAt) {
    const remote = ctx && ctx.remote && ctx.remote.session;
    // 文本是**配置层**的：客户端拿不到插件的 Config，所以用默认那份；
    // 宿主侧（建预加载会话）走平台自己的 prompt 通道，它那份 Config.texts 由 core/preload.js 传。
    // **两种视图**由 events + activityAt 决定（见 core/views.js）：30 天内给大小变化，超过只给文件名。
    const res = await promptReadViaRemote({
      remote, sessionId, kind: 'reread', changeIndex, events, activityAt,
      templates: DEFAULT_TEXTS, criteria: effectiveCriteria, log: guardLog, event: logEvent,
    });
    log(res.ok ? 'info' : 'warn', '重读请求：' + res.reason);
    if (typeof onSendResult === 'function') onSendResult(res);
    return res;
  }
  let onSendResult = null;

  /**
   * 客户端启动的内部实现（注册插槽、起轮询、先判一次；返回清理函数）。
   * `apply` 只做一层边界：启动抛错 → 归一、报一次、返回空清理函数（不把异常抛给界面加载器）。
   */
  function applyInner(pluginCtx) {
      const disposers = [];
      // 允许测试传入自己的动作回调。**真环境的 ctx 是代理：读未声明的属性会抛错**，所以包起来读。
      try { if (pluginCtx && typeof pluginCtx.__onUserChoice === 'function') onUserChoice = pluginCtx.__onUserChoice; } catch { /* 没有就没有 */ }
      try { if (pluginCtx && typeof pluginCtx.__onSendResult === 'function') onSendResult = pluginCtx.__onSendResult; } catch { /* 同上 */ }

      // ① 盯住"当前是哪条会话"。
      //
      //     踩过的坑：一开始只订阅了**当前那条**会话的保留计数——于是用户切到**别人那条**时，
      //     通知发在新会话上，**我们根本收不到**（接线测试当场抓出来）。
      //     可靠的做法是**定期问一次"现在主视图在看谁"**：简单、不漏，代价是一点点轮询。
      //     如果宿主提供了更精确的订阅点，也可以在这里接（`sessions.list.subscribe`）。
      // 轮询间隔也走 criteria；启动时先按默认/上次读到的值，之后改配置会在下次页面加载生效。
      const pollMs = effectiveCriteria.pollMs;
      const sessions = pluginCtx && pluginCtx.sessions;
      // **测试友好**：把定时器与清理交给注入的口子，测试就不必等真实 2 秒，
      //   也不会留下一个跑不停的定时器把断言搅乱（踩过一次）。
      //   ⚠ 真环境的 ctx 是**代理**：读未声明的属性会抛错 → 所有"测试口子"都要**包起来读**。
      const safeGet = (k) => { try { return pluginCtx ? pluginCtx[k] : undefined; } catch { return undefined; } };
      const setTimer = safeGet('__setTimer') || ((fn, ms) => setInterval(fn, ms));
      const clearTimer = safeGet('__clearTimer') || ((t) => clearInterval(t));
      const tick = () => guardSync('轮询当前会话', () => {
        const id = currentMainSessionId(sessionsOf());
        // **认不出来时不要清空**：`null` 表示“这次没认出来”，不是“切到了空会话”。
        // 当前会话可能是插槽告诉我们的一条，别被这个 null 覆盖掉。
        if (id !== null && id !== current.sessionId) void reevaluate(id);
      }, { optional: true, log: guardLog, code: CODES.UI_READ_FAILED, blockedBy: 'ui' });
      let timer = null;
      if (typeof setTimer === 'function') {
        timer = setTimer(tick, pollMs);
        disposers.push(() => { if (timer !== null && typeof clearTimer === 'function') clearTimer(timer); });
      }
      // 若宿主给了列表订阅，就顺手接上（有则更快，没有也不影响）
      const listSub = sessions && sessions.list && sessions.list.subscribe;
      if (typeof listSub === 'function') {
        try {
          const unsub = sessions.list.subscribe(tick);
          if (typeof unsub === 'function') disposers.push(unsub);
        } catch { /* 订阅不到就只靠轮询 */ }
      }

      // ② 挂卡片。用 `slots.inject` 等插槽声明，声明没了自动摘掉。
      const slots = pluginCtx && pluginCtx.slots;
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        try {
          // `inject: (sessionId) => …` 是 **session 作用域 list slot** 的官方用法：
          // 插槽把当前会话 id 交给每个条目，条目再把它作为 prop 交给组件。
          const d = slots.inject('conversation.chat.turnTail', () => slots.register(
            { name: 'conversation.chat.turnTail', id: CARD_SLOT_ID, order: 50, inject: (sessionId) => ({ sessionId }) },
            ReturnCardView,
          ));
          if (typeof d === 'function') disposers.push(d);
        } catch (err) {
          log('warn', '挂卡片失败：' + String((err && err.message) || err));
        }
      }

      // ③ 先算一次（页面打开时可能已经在某条会话里）
      void reevaluate(currentMainSessionId(sessionsOf()));
      // 轮询是主路径，所以让测试能立刻推进一次，不必等 2 秒
      const tickHook = safeGet('__tick');
      if (typeof tickHook === 'function') { try { tickHook(tick); } catch { /* 测试口子出错不影响运行 */ } }

      // ④ 启动时如实报告处境——**注册上了几个扩展点，绝不假装成功**
      log('info', '客户端已启动：' + disposers.length + ' 个扩展点注册成功');

      return () => {
        for (const d of disposers) {
          guardSync('清理客户端资源', d, {
            optional: true, log: guardLog, code: CODES.UI_INIT_FAILED, blockedBy: 'ui',
          });
        }
      };
  }

  return {
    inject: CLIENT_INJECT,
    apply(pluginCtx) {
      // 启动边界：接线期抛错不能变成"界面加载失败"（那会连累整块 slot 宿主页面）。
      const started = guardSync('客户端启动', () => applyInner(pluginCtx), {
        optional: false,
        log: guardLog,
        code: CODES.UI_INIT_FAILED,
        blockedBy: 'ui',
      });
      return typeof started === 'function' ? started : () => {};
    },
    // 测试口子：让离线测试能直接驱动判断与收场；`logs()` 读客户端内存日志（LOG-SCHEMA §6.2）
    __test: {
      reevaluate,
      current: () => current,
      dismiss,
      listeners,
      logs: () => memorySink.list(),
      logSnapshot: () => memorySink.snapshot(),
    },
  };
}


// ===== client.js =====
// dsh-milieu —— 界面半边入口：**只装配**（实现都在 `ui/`，本文件不做判断/渲染/请求）
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不需要自己装一份。
//
// **平台按 classic script 加载界面插件**（不是 ES 模块，2026-10-18 真机踩到
// `Cannot use import statement outside a module`）：发布的是 `lib/client.js` 构建产物，
// 由 `node tools/build-client.mjs` 从本文件 + `ui/*.js` + 它们依赖的纯模块拼接生成。
// 改界面源码后必须重新生成，否则跑的是旧代码。
//
// 责任边界（ARCHITECTURE.md 工作包 C）：入口只创建 `ui/plugin.js` 并交给模块加载器；
//   注册插槽、判据、渲染、读文件、发请求全在 `ui/`。


if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-milieu',
    factory(require) {
      const React = require('react');
      // 浏览器里 `ctx` 由加载器在 apply 时注入；这里先把工厂交出去。
      // 注意：`createClientPlugin` 需要 ctx，所以真正 apply 时再构造。
      return {
        inject: CLIENT_INJECT,
        apply(ctx) {
          // 工厂层只负责把 React 与 ctx 交给可测的那个构造器；
          // 注册、订阅、清理**全在构造器返回的 apply 里**（那份代码离线测过）。
          const plugin = createClientPlugin({ React, ctx });
          return plugin.apply(ctx);
        },
      };
    },
  });
}

})();