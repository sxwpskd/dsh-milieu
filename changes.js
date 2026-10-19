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
import { createHash } from 'node:crypto';
import { DEFAULT_CRITERIA } from './criteria.js';

/** 事件类型。 */
export const KINDS = ['created', 'changed', 'gone'];

/** 默认参数（都可被配置覆盖；数值的单一来源是 criteria.js）。 */
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
 * 为什么必须有这张表（2026-10-14 咬过一次，journal/016）：本机制每次运行都会写这两个文件；
 * 不排除的话，下一轮算差量时第一个"新增"就是**它自己**，而且**每轮都在给自己供料**——环自己转起来。
 * 排除**只影响判据**：清单里照旧记着它们（存在是事实）。
 *
 * 写成"库名 + 文件名"两段，避免把别处同名文件误伤。
 */
export const SELF_ARTIFACTS = [
  { lib: 'review', name: 'milieu-state.json' },
  { lib: 'tools', name: '.milieu-state-prev.json' },
];

/** 这个相对路径是不是机制自己的产物？ */
export function isSelfArtifact(rel, libs = { review: 'review', tools: 'tools' }) {
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

/** 指纹（与清单同一算法：sha256 前 12）。 */
export function fpOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
