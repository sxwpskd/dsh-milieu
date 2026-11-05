// dsh-milieu —— **变更台账**（纯函数：扫描结果的组装、事件流的产出与投影）
//
// 它照 [dsh-milieu/CHANGE-STATE-MACHINE.md](../../../dsh-milieu/CHANGE-STATE-MACHINE.md) v2 写。一句话：
//   **把"工作区里哪些东西、什么时候、变了多少"记成一条有界的事件流；六个桶与计数是它的投影。**
//
// 分工（不要混）：
//   · 判"变没变" → 比 **字节 + 指纹**（上一次的表；所以文件条目必须带 `hash`，
//     否则同大小、内容不同的改动永远比不出来——2026-11-02 修的就是这个）；
//   · 事件的**时间** → 扫描时现读的**文件 mtime（毫秒原值）**；
//   · `manifest.md` 只给人看，**不参与判定**。
//
// 扫描范围（规范）：**认知库全递归**（每个文件一条）；**其它库只到一级**（文件夹按整棵求和、顶层文件按自身）；
// 索引文件单独成条；`aggregateOnly` 里的目录只记整棵合计。
//
// 自产物（`isSelfArtifact`）：状态文件 / 上一份基准 / 宿主日志 / **原始变更日志**
// （`core/change-log.js` 的 `RAW_LOG_REL`）都不算"工作区变了"——防"自己写 → 自己判变 → 自己写"的环。
//
// 注意：本文件会被**界面半边**打进 `lib/client.js`（`tools/build-client.mjs` 的 ORDER 里有它），
// 所以这里**不能 import `core/change-log.js`**（那边 import 'node:path'，浏览器包里没有）。
// 原始日志路径在这里只做**字面量比对**；路径契约的家在 `core/change-log.js`，
// 由测试拿 `RAW_LOG_REL` 与 `isSelfArtifact` 对一遍钉住两处一致（见其注释）。
import { DEFAULT_CRITERIA } from '../config/criteria.js';

/** 原始变更日志的相对路径（**同上**：字面量与 `core/change-log.js` 的 RAW_LOG_REL 必须一致；测试钉住）。 */
const RAW_LOG_ARTIFACT_REL = '.dsh-milieu/changes.jsonl';

/** 事件类型。 */
export const KINDS = ['created', 'changed', 'gone'];

/** 默认参数（都可被配置覆盖；数值的单一来源是 config/criteria.js）。 */
export const CHANGE_DEFAULTS = {
  keepDays: DEFAULT_CRITERIA.eventKeepDays,
  keepCount: DEFAULT_CRITERIA.eventKeepCount,
  recursiveLibs: ['review'],
  indexFiles: ['tools/manifest.md', 'external/retired/INDEX.md'],
  aggregateOnly: ['external/refs'],
};

/**
 * **机制自己的产物**：它们永远不算"工作区变了"。
 *
 * 为什么必须有这张表（2026-10-14 咬过一次，journal/016）：本机制每次运行都会写这些文件；
 * 不排除的话，下一轮算差量时第一个"新增"就是**它自己**，而且**每轮都在给自己供料**——环自己转起来。
 * 排除**只影响判据**：清单里照旧记着它们（存在是事实）。
 *
 * 写成"库名 + 文件名"两段，避免把别处同名文件误伤。
 *
 * 2026-11-02 补 `STATE.md`（状态页）：它的**材料段是插件每轮刷新写的**（内容含生成时间），
 * 不排除就会在"无变化不写状态文件"的策略下形成 60 秒一次的自喂环：
 *   扫描 → 有变化 → 写状态文件 → 刷状态页（材料段变）→ 下轮扫到 STATE.md changed → 又写……
 * 整页排除（判断段也不计入）是有意的：状态页是"状态的文件形态"，不是外部工作区事实；
 * 判断段由 agent 写，也不该反过来触发"工作区变了 → 重读"。口径与 `criteria.readiness.ignore`
 * 对同一文件的排除一致。
 */
export const SELF_ARTIFACTS = [
  { lib: 'review', name: 'milieu-state.json' },
  { lib: 'review', name: 'STATE.md' },          // 状态页（材料段插件写；防自喂环，见上）
  { lib: 'tools', name: '.milieu-state-prev.json' },
];

/**
 * **宿主日志文件**（LOG-SCHEMA §6.3）：`.dsh-milieu/milieu.log` 与轮转文件（`.1` / `.2`…）
 * 也是机制自己的产物，**必须排除出事件流**——否则每写一条日志都变成一次"工作区变了"，自己喂自己。
 *
 * 为什么这里写字面量而不 import `log/file-sink.js`：分层不允许 `core/` 依赖 `log/`；
 * 路径契约在 LOG-SCHEMA §6.1 里是同一份（写方 file-sink、排除方这里）。
 */
export const LOG_ARTIFACT_REL = '.dsh-milieu/milieu.log';

/** 这个路径是不是日志文件（本体或轮转备份）。 */
function isLogArtifact(rel) {
  if (!rel.startsWith(LOG_ARTIFACT_REL)) return false;
  const rest = rel.slice(LOG_ARTIFACT_REL.length);
  return rest === '' || /^\.\d+$/.test(rest); // milieu.log / milieu.log.1 / milieu.log.2 …
}

/** 这个相对路径是不是机制自己的产物？ */
export function isSelfArtifact(rel, libs = { review: 'review', tools: 'tools' }) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (isLogArtifact(p)) return true;
  // 原始变更日志（`core/change-log.js` 写、append-only）：同样是机制自己的产物。
  // 正常扫描范围里它在 `.dsh-milieu/` 下、本来就不进条目表；这里再认一次是防"库配到根"
  // 这类配置——一旦它进了事件流，就是每轮"新增"自己喂自己（2026-10-14 踩过同类环）。
  if (p === RAW_LOG_ARTIFACT_REL) return true;
  return SELF_ARTIFACTS.some((a) => p === (libs[a.lib] || a.lib) + '/' + a.name);
}

const isUnder = (rel, prefix) => rel === prefix || rel.startsWith(prefix + '/');
const topOf = (rel) => rel.split('/')[0];

/** 文件条目的内容指纹（没有就 null——"不知道"不许冒充"没变"）。 */
function hashOfFile(file) {
  return typeof file.hash === 'string' && file.hash ? file.hash : null;
}

/**
 * 由清单里的文件表 + 排除子树统计，算出"要跟踪的条目表"。
 *
 * ⚠ **文件条目必须带 `hash`**（2026-11-02 修）：`diffEntries` 一直按"字节 + 指纹"判变没变，
 *   但本函数以前组装条目时把指纹丢了，于是 `a.hash === b.hash === undefined` 恒成立，
 *   **同大小、内容不同的改动永远漏报**。现在文件条目带指纹、目录/整棵合计为 null。
 *
 * @param {object} o
 *   · files       [{ rel, size, mtime, hash }]（扫描出的文件；rel 用 `/` 分隔）
 *   · libs        { review, tools, external }
 *   · excluded    [{ rel, size, mtime }]（被清单排除、只记整棵合计的子树）
 *   · cfg         CHANGE_DEFAULTS 形状
 * @returns {Object<string, {size:number, mtime:number|null, kind:'file'|'dir', hash:string|null}>}
 */
export function buildEntries(o = {}) {
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
    const hash = hashOfFile(f);

    // ① 索引文件：单独成条（无论它在哪个库）
    if (c.indexFiles.includes(rel)) { out[rel] = { size, mtime, kind: 'file', hash }; continue; }

    // ② 递归库：每个文件一条
    if (recursive.some((lib) => isUnder(rel, lib))) { out[rel] = { size, mtime, kind: 'file', hash }; continue; }

    // ③ 只到一级的库：顶层文件按自身，更深的折进它的一级文件夹
    const lib = firstLevelLibs.find((k) => isUnder(rel, libs[k]));
    if (!lib) continue;
    const rest = rel.slice(libs[lib].length + 1);
    const parts = rest.split('/');
    const key = parts.length === 1 ? rel : libs[lib] + '/' + parts[0];
    const kind = parts.length === 1 ? 'file' : 'dir';
    // 文件夹是整棵合计，没有单文件指纹（null）；顶层文件保留自己的。
    const entryHash = kind === 'file' ? hash : null;
    const cur = out[key];
    if (!cur) out[key] = { size, mtime, kind, hash: entryHash };
    else {
      if (kind === 'dir') cur.size += size;                       // 文件夹：整棵求和
      if (mtime !== null) cur.mtime = cur.mtime === null ? mtime : Math.max(cur.mtime, mtime);
      if (entryHash && !cur.hash) cur.hash = entryHash;          // 防御：同 key 不同拼法
    }
  }

  // ④ 被清单排除的子树：只记整棵合计（**与别的文件夹同规则**，差别只在"不列子文件"）
  for (const ex of excluded) {
    const rel = String(ex.rel || '').replace(/\\/g, '/');
    if (!rel) continue;
    out[rel] = { size: Number(ex.size) || 0, mtime: typeof ex.mtime === 'number' ? ex.mtime : null, kind: 'dir', hash: null };
  }

  return out;
}

/** 一条事件。字段只有这五个——**不许偷偷加**（状态机说明 §四）。 */
export function makeEvent(entry, beforeEntry, at) {
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
export function diffEntries(prev, cur, isFirstRun) {
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
export function boundEvents(events, now, cfg = {}) {
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
export function project(events, libs = { review: 'review' }) {
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
