// 本文件由 tools/build-client.mjs 从 <包>/[criteria|changes|views|core|state|texts|actions|card|client-core|client].js 生成。
// **不要手改**：改源码后重跑 `node tools/build-client.mjs`。 src=3e5972bbcc61
(function () {
"use strict";

// ===== criteria.js =====
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
//   判据（core.js）       structuralThreshold / contentThreshold / staleHintDays / promptThresholdMs / readiness / fingerprint
//   台账（changes.js）    eventKeepDays / eventKeepCount
//   视图（views.js）      staleDays / staleMaxReview
//   客户端 / 宿主         clientMemoryLimit / pollMs / readTimeoutMs / agentLoopWaitMs
const DEFAULT_CRITERIA = {
  // ---- 判据：要不要"再读一遍"（core.js） ----
  structuralThreshold: 1,          // 新增/消失几个就重读
  contentThreshold: 5,             // 改动几个就重读
  staleHintDays: 30,               // 距上次阅读超过这么多天 → 只提示，不重读
  promptThresholdMs: 5 * 60 * 1000, // 距这条会话最后活动 ≥ 5 分钟才弹卡

  // ---- 判据：认知库"建立完成"的门槛（core.js 的 evaluateReadiness） ----
  readiness: {
    minFiles: 10,                  // 文件数 ≥ 10
    minBytes: 10 * 1024,           // 总大小 ≥ 10 KB
    windowMs: 5 * 60 * 1000,       // 观察窗：5 分钟
    maxGrowthRate: 0.30,           // 窗内新增速度 < 30%
    maxChangedRatio: 0.20,         // 窗内变动占比 < 20%
  },

  // ---- 判据：会话指纹保留策略（core.js 的 planFingerprintRetention） ----
  fingerprint: {
    keepDays: 1,                   // 最近 1 天
    keepRecent: 5,                 // ∪ 最近 5 条
  },

  // ---- 台账：事件流有界（changes.js 的 boundEvents） ----
  eventKeepDays: 30,               // 保留最近 30 天
  eventKeepCount: 500,             // ∪ 最近 500 条

  // ---- 视图：超过这么久没用 → 只给文件名（views.js） ----
  staleDays: 30,
  staleMaxReview: 20,              // 认知库最多列 20 条，超过写"改动过大"

  // ---- 客户端（client.js / client-core.js） ----
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


// ===== changes.js =====
// dsh-milieu —— **变更台账**（纯函数：扫描结果的组装、事件流的产出与投影）
//
// 它照 [dsh-milieu/CHANGE-STATE-MACHINE.md](../../dsh-milieu/CHANGE-STATE-MACHINE.md) v2 写。一句话：
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

/** 默认参数（都可被配置覆盖；数值的单一来源是 criteria.js）。 */
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

/** 这个相对路径是不是机制自己的产物？ */
function isSelfArtifact(rel, libs = { review: 'review', tools: 'tools' }) {
  const p = String(rel || '').replace(/\\/g, '/');
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

/** 指纹（与清单同一算法：sha256 前 12）。 */
function fpOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}


// ===== views.js =====
// dsh-milieu —— **变更视图**（纯函数：事件流 → 一段给人/给 AI 看的文字）
//
// 它回答一个具体问题：**这条会话该看到的"变了什么"，详细到什么程度？**
// 规则照 [dsh-milieu/CHANGE-STATE-MACHINE.md](../../dsh-milieu/CHANGE-STATE-MACHINE.md) §六：
//
//   · 会话**30 天以内**用过 → **视图 A**：文件名 + 大小变化（旧→新 + 净变化）
//   · 会话**超过 30 天**没用 → **视图 B**：认知库**只给文件名**（最多 20 条，超过整段不列，写"改动过大"）；
//                                其它库**只给两个索引文件**的名字与大小变化
//
// 口径（主人 2026-10-16 定的，别改）：**过滤基准是这条会话自己的活动时间**——
//   在用会话时不打扰（用户看得见的变化，AI 自然也接受）；搁置久了才给全貌。
//
// 它**不判断该不该重读**（那是 core.js 的判据），只负责"该看什么就摆成什么样"。

/** 超过这么久没用 → 只给文件名（默认值在 criteria.js）。 */
const STALE_DAYS = DEFAULT_CRITERIA.staleDays;
/** 视图 B 里认知库最多列几条；超过就整段不列（默认值在 criteria.js）。 */
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


// ===== core.js =====
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
// 设计依据（见 ../DEVELOPMENT.md 阶段 B）：
//   · 过期条件是"工作区状态变了"，**不是时间**（主人 2026-10-13 纠正）；
//   · 正常路径下状态不会背着会话偷偷变——因为按规范，改工作区就该走会话；
//   · 但仍然要检测，**为了在规范被绕过时有人叫**（274→382 行、三个孤儿文件都是那么来的）。


/** 判据版本：判据本身变了要能看出来（旧记录按旧判据写的）。 */
const CRITERIA_VERSION = 2;   // v2：自愈改按"缓存失效"定义；新增认知库完备性门槛

/** 缺省阈值（**默认值在 criteria.js**；这里导出同一份，供判据函数直接引用）。 */
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

/** 工作区身份：同一个 cwd 就是同一个工作区（插件拿不到 workspaceId，只拿得到 cwd）。 */function workspaceKey(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  // 统一分隔符与大小写：Windows 上 D:\DSH 与 d:/dsh 是同一个地方
  return cwd.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
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


// ===== state.js =====
// dsh-milieu —— 状态文件（宿主写、客户端读的**唯一一份材料**）
//
// 为什么要有这个文件：判据只能有一处。宿主算变更（要读文件系统），客户端只显示。
// 位置：`<认知库>/milieu-state.json`
// 作者：**宿主**（由 tools/milieu-state.mjs 生成）。**客户端只读它，绝不写。**
// 依赖：**只依赖 `changes.js`**（六个桶与计数由事件流派生）——判据与目录都不在这里重写。

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

const STATE_FILE = 'milieu-state.json';
const STATE_VERSION = 3;

/** 受管会话的角色（先留这两种；将来有别的再加）。 */
const ROLES = ['preload', 'active'];

/** 造一个空状态（宿主还没写过时用它）。 */
function emptyState(now = Date.now()) {
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
 * **注意：变更索引的"归一"只有一个家在 `core.js`**（`normalizeChangeIndex`）。
 * 这里原来也有一份，属于"同一件事两个版本"——已被删掉。
 * 需要归一的地方**从 core.js 引**，别在这儿重新发明。
 */

/** 汇总成给人看的计数（卡片标题用）。 */
function changeTotals(changeIndex) {
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  const ci = changeIndex || {};
  const review = n(ci.reviewAdded) + n(ci.reviewChanged) + n(ci.reviewGone);
  const other = n(ci.otherAdded) + n(ci.otherChanged) + n(ci.otherGone);
  return { review, other, total: review + other };
}


// ===== texts.js =====
// dsh-milieu —— 请求文本拼装（**纯模块** + **配置层**：无宿主依赖、无副作用、双方都能引）
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


// ===== actions.js =====
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


/**
 * 生成一个请求 id（`session/prompt` 需要）。
 * **不 import 宿主的 id 工具**（那会引入依赖）；用平台普遍可用的 `crypto.randomUUID`，
 * 没有就退到一个"时间 + 随机"的可用值。**id 的语义是"标识这次请求"，格式不重要。**
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
async function promptReadViaRemote(o = {}) {
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


// ===== card.js =====
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
// 它**不做判断**：该不该弹由 core.js 的纯判据决定，能不能读由宿主/接口决定。
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


// ===== client-core.js =====
// dsh-milieu —— 客户端判据（纯函数，无副作用，可离线测）
//
// 它只回答一件事：**这张卡该不该弹。**
// 阈值判据**复用 core.js 的 `shouldPromptOnReturn`**——判断只能有一处，这里不另写一份。
//
// 不在这里做的事（各归各处）：
//   · 算变更 → 宿主（要读文件系统），结果落在 state.js 描述的状态文件里；
//   · 画界面 → card.js；
//   · 读文件 → client.js（用现成的 workspaceFiles Remote）。

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


// ===== client.js =====
// dsh-milieu —— 客户端半边
//
// 它做三件事，而且**只做这三件**：
//   ① 看住"当前是哪条会话"（`retainedBy.mainView` 计数变了就是切换）；
//   ② 切到**我们管的**那条时，用现成的 Remote 读状态文件；
//   ③ 判据说该弹，就把卡片注册进插槽；你点"重读"/"不用"/直接打字，卡片收场。
//
// **判据不在这里**——在 `client-core.js`（纯函数、离线测过 34 项）。
// 这里只负责"接线"：拿数据、喂判据、渲染。
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不需要自己装一份。
//
// 官方 UI 硬规矩（照办）：只用主题 token 上色、不 import 任何 Harness 客户端包、
//   不写 DOM、不动 document.body、注册进插槽而不是自己找位置。


/** 状态文件在**认知库**里的相对路径。宿主写、这里读。 */
const STATE_REL_PATH = 'review/milieu-state.json';

/** 我们注册进插槽的卡片 id（同一次会话只应有一个）。 */
const CARD_SLOT_ID = 'dsh-milieu:return-card';

/**
 * 造客户端插件主体。**导出成函数是为了能离线测**：
 * 测试里传一个假的 ctx（假的 slots / remote / sessions），就能验"接线"对不对，
 * 不用真浏览器、不用真宿主。
 *
 * @param {object} deps { React, ctx }
 */
function createClientPlugin({ React, ctx }) {
  // 客户端自己记的"这条会话弹过了"——只活在页面里，不进工作区。
  let shownMemory = {};
  // **生效判据**：先默认；每次读到状态文件后按文件里的 `criteria` 更新（宿主写的同一份）。
  let effectiveCriteria = mergeCriteria(DEFAULT_CRITERIA);
  // 每次判断的结果（同一次切换不重复算）
  let current = { sessionId: null, decision: { show: false }, state: null, pending: false };
  // 最近一次读状态文件的结果（诊断行用；也帮我们确认签名/路径）
  let lastRead = { ok: false, reason: 'not tried' };

  const log = (level, msg) => {
    const logger = ctx && ctx.logger;
    if (logger && typeof logger[level] === 'function') logger[level]('[milieu] ' + msg);
  };

  /** 取当前会话 id：平台用 `retainedBy.mainView > 0` 表示"主视图正在看它"。 */
  function currentMainSessionId() {
    const sessions = ctx && ctx.sessions;
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
   * 来源是平台会话列表里的 `updatedAt`（**不另存一份"上次读"**，主人 2026-10-14 定的口径）。
   * 拿不到就返回 null → 判据走"保守提示"。
   */
  function sessionActivityAt(sessionId) {
    const sessions = ctx && ctx.sessions;
    const list = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot();
    const row = list && list.byId && list.byId[sessionId];
    const at = row && (typeof row.updatedAt === 'number' ? row.updatedAt : (typeof row.lastActivityAt === 'number' ? row.lastActivityAt : null));
    return typeof at === 'number' ? at : null;
  }

  /** 读状态文件。读不到 / 超时 / 报错，一律当"没有"——不弹、不崩。 */
  async function readState(sessionId) {
    const remote = ctx && ctx.remote && ctx.remote.workspaceFiles;
    if (!remote || typeof remote.read !== 'function') {
      lastRead = { ok: false, reason: 'no workspaceFiles remote' };
      log('info', '没有 workspaceFiles Remote —— 将不弹卡');
      return null;
    }
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(effectiveCriteria.readTimeoutMs)
      : undefined;
    // 官方文档形状是 `read(path, { offset?, limit? })`；旧代码写的是 `read(sessionId, path, …)`。
    // **两种都试**，谁先成功用谁；失败原因留给诊断行。
    const attempts = [
      ['read(path, opts)', () => remote.read(STATE_REL_PATH, {}, signal)],
      ['read(sessionId, path, opts, signal)', () => remote.read(sessionId, STATE_REL_PATH, {}, signal)],
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
    // 文件不存在是**正常情况**（还没生成），不是错误
    log('info', '读状态文件未成功（通常是没有这个文件）：' + lastRead.reason);
    return null;
  }

  /** 重新判断一次（切换会话或状态变化时调用）。 */
  async function reevaluate(sessionId) {
    if (!sessionId) { current = { sessionId: null, decision: { show: false }, state: null, pending: false }; return; }
    if (current.pending) return;                       // 不并发读同一件事
    current = { ...current, sessionId, pending: true };
    const text = await readState(sessionId);
    const parsed = parseState(text);
    const criteria = mergeCriteria(DEFAULT_CRITERIA, parsed && parsed.criteria);
    effectiveCriteria = criteria;
    const decision = shouldShowCard(sessionId, text, shownMemory, {
      now: Date.now(),
      activityAt: sessionActivityAt(sessionId),
      criteria,
      thresholdMs: criteria.promptThresholdMs,
    });
    current = { sessionId, decision, state: text, criteria, pending: false };
    log('info', '会话 ' + sessionId + ' → ' + (decision.show ? '该弹卡' : '不弹') + '（' + decision.reason + '）');
    bump();                                            // 通知插槽重画
  }

  // ---- 插槽重画：用一个极小的订阅点，避免自己造状态机 ----
  let listeners = new Set();
  const bump = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* 一个订阅者出错不影响别人 */ } } };

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

    // **插槽是 session 作用域**：它直接把当前会话 id 交给我们（`props.sessionId`），
    // 比 `ctx.sessions.list` 里的 `retainedBy.mainView` 可靠。
    // 没有这个 prop 时，才退回原来的“按主视图计数找当前会话”。
    const slotSessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null;

    // 排查用：`criteria.debug` 为真时，在聊天里渲染一行自报状态（平时关）。
    const debug = !!(effectiveCriteria && effectiveCriteria.debug);
    const debugLine = (d0) => React.createElement('div', {
      style: { font: '12px monospace', color: '#c00', border: '1px dashed #c00', padding: '4px', margin: '4px 0' },
    }, '[milieu] client alive | slot=' + String(slotSessionId) + ' | current=' + String(current.sessionId) + ' | show=' + String(!!(d0 && d0.show)) + ' | reason=' + String((d0 && d0.reason) || '') + ' | state=' + (current.state ? 'yes' : 'no') + ' | read=' + (lastRead.ok ? 'ok via ' + lastRead.via : lastRead.reason));

    if (slotSessionId && slotSessionId !== current.sessionId) {
      // 不在渲染里直接做异步副作用：推到微任务；pending 期间不会重复排队。
      Promise.resolve().then(() => {
        if (slotSessionId !== current.sessionId) void reevaluate(slotSessionId);
      });
      return debug ? debugLine(null) : null;
    }

    const d = current.decision;
    if (!d || !d.show) return debug ? debugLine(d) : null;
    const card = MilieuReturnCard(React, {
      changeIndex: d.changeIndex,
      locale: 'zh',
      onReview: () => {
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
        const activityAt = sessionActivityAt(targetId);
        if (typeof onUserChoice === 'function') onUserChoice('review', targetId);
        dismiss('review');
        void sendRead(targetId, changeIndex, events, activityAt);
      },
      onSkip: () => { log('info', '你点了"不用"'); if (typeof onUserChoice === 'function') onUserChoice('skip', current.sessionId); dismiss('skip'); },
      onDismiss: () => { log('info', '你直接开始了（卡片自动关闭）'); dismiss('typed'); },
    });
    return debug ? React.createElement('div', null, debugLine(d), card) : card;
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
    const liveId = currentMainSessionId() || current.sessionId;
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
   */
  async function sendRead(sessionId, changeIndex, events, activityAt) {
    const remote = ctx && ctx.remote && ctx.remote.session;
    // 文本是**配置层**的：客户端拿不到插件的 Config，所以用默认那份；
    // 宿主侧（建预加载会话）走 `sessionController.prompt`，它那份 Config.texts 由 preload-session.js 传。
    // **两种视图**由 events + activityAt 决定（见 views.js）：30 天内给大小变化，超过只给文件名。
    const res = await promptReadViaRemote({ remote, sessionId, kind: 'reread', changeIndex, events, activityAt, templates: DEFAULT_TEXTS, criteria: effectiveCriteria });
    log(res.ok ? 'info' : 'warn', '重读请求：' + res.reason);
    if (typeof onSendResult === 'function') onSendResult(res);
    return res;
  }
  let onSendResult = null;

  return {
    // **依赖声明**（客户端 Cordis 契约）：用到的服务/命名空间必须列全，访问未声明的会抛
    // `cannot get property … without inject`。`sessions` 我们一直在用，之前漏了——
    // 离线假 ctx 不检查这个，真机上才会炸（2026-10-18）。
    inject: ['slots', 'sessions', 'remote', 'remote.workspaceFiles', 'remote.session'],
    apply(pluginCtx) {
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
      const tick = () => {
        const id = currentMainSessionId();
        // **认不出来时不要清空**：`null` 表示“这次没认出来”，不是“切到了空会话”。
        // 当前会话可能是插槽告诉我们的一条，别被这个 null 覆盖掉。
        if (id !== null && id !== current.sessionId) void reevaluate(id);
      };
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
      void reevaluate(currentMainSessionId());
      // 轮询是主路径，所以让测试能立刻推进一次，不必等 2 秒
      const tickHook = safeGet('__tick');
      if (typeof tickHook === 'function') { try { tickHook(tick); } catch { /* 测试口子出错不影响运行 */ } }

      // ④ 启动时如实报告处境——**注册上了几个扩展点，绝不假装成功**
      log('info', '客户端已启动：' + disposers.length + ' 个扩展点注册成功');

      return () => { for (const d of disposers) { try { d(); } catch { /* 清理失败不吞噬宿主 */ } } };
    },
    // 测试口子：让离线测试能直接驱动判断与收场
    __test: { reevaluate, current: () => current, dismiss, listeners },
  };
}

// ---------------------------------------------------------------------------
// 浏览器模块入口（官方模板的形状）
//
// **守卫 `typeof window`**：Node 里没有 `window`，于是这个文件在离线测试里
// 只导出 `createClientPlugin`，不碰浏览器对象。这样同一份文件既能当浏览器模块，
// 又能被离线测——**不用为了可测而复制一份逻辑**。
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-milieu',
    factory(require) {
      const React = require('react');
      // 浏览器里 `ctx` 由加载器在 apply 时注入；这里先把工厂交出去。
      // 注意：`createClientPlugin` 需要 ctx，所以真正 apply 时再构造。
      return {
        inject: ['slots', 'sessions', 'remote', 'remote.workspaceFiles', 'remote.session'],
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