// dsh-milieu —— **状态文件生成器**（纯模块：算完返回，不自己退出进程）
//
// 它是 [dsh-milieu/CHANGE-STATE-MACHINE.md](../../dsh-milieu/CHANGE-STATE-MACHINE.md) v2 的实现：
//   扫一遍工作区 → 与上一次基准比（**只比字节 + 指纹**）→ 产出**事件流** → 有界 → 投影出六个桶与计数。
//
// **为什么住在包里**（2026-10-16 决定）：宿主不能假设用户工作区里有 `tools/`
//   （用户可能只装插件、不建工具区）。生成器要能在**只有这个包的工作区**里跑起来。
//   工具区那份 `milieu-state.mjs` 是**转调它**的开发工作台入口——一份实现，两个入口，不靠复制。
//
// 纪律：**只读扫描 + 只写状态文件与我们自己的基准**；没有任何删除动作。
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { emptyState, STATE_FILE, STATE_VERSION, normalizeManagedSessions } from './state.js';
import { buildEntries, diffEntries, boundEvents, project, CHANGE_DEFAULTS, isSelfArtifact } from './changes.js';
import { workspaceKey } from './core.js';
import { DEFAULT_CRITERIA, mergeCriteria } from './criteria.js';

const CFG_NAME = '.dsh-milieu.json';
const DEFAULT_LIBS = { review: 'review', tools: 'tools', external: 'external' };
const PREV_VERSION = 2;
export const PREV_FILE = '.milieu-state-prev.json';

/** 扫描时跳过的目录：与工作区工具 `inventory` 的 `SKIP_DIRS` 保持一致。 */
const SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh']);

/** 读工作区配置（坏文件用默认值，不抛）。 */
export function loadWorkspaceConfig(root) {
  const p = join(root, CFG_NAME);
  const def = { libs: DEFAULT_LIBS, changes: {}, criteria: {} };
  if (!existsSync(p)) return { ...def, source: '默认（没有配置文件）' };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return {
      libs: { ...DEFAULT_LIBS, ...(raw.libs || {}) },
      changes: { ...(raw.changes || {}) },
      criteria: { ...(raw.criteria || {}) },
      source: CFG_NAME,
    };
  } catch (e) {
    return { ...def, source: CFG_NAME + '（解析失败，用默认：' + e.message + '）' };
  }
}

/** 指纹：**为"变没变"服务**，md5 够（清单那份 sha256 是给它自己用的）。 */
export function fileFingerprint(file) {
  try { return createHash('md5').update(readFileSync(file)).digest('hex').slice(0, 12); }
  catch { return null; }                       // 读不到：当作"指纹未知"，下轮再判
}

/** 从清单里读"现在有什么"（**只供人工/迁移**；生成状态已改为 `listWorkspaceFiles` 直接扫）。 */
export function readManifestFiles(toolsDir) {
  const p = join(toolsDir, 'manifest.md');
  if (!existsSync(p)) return null;
  const txt = readFileSync(p, 'utf8');
  const out = [];
  const re = /^\| `([^`]+)` \| (\d+) \| ([^|]+) \| `([^`]+)` \|$/gm;
  let m;
  while ((m = re.exec(txt))) out.push({ rel: m[1], size: Number(m[2]) });
  return out;
}

/**
 * **直接扫工作区**（不依赖 `tools/manifest.md`）。
 *
 * 2026-10-19 修：状态生成曾经读清单当文件表，清单不在就直接放弃——于是**全新工作区没有清单，
 * 状态文件永远生不出来**（客户端也就永远不弹"重读"）。可清单只是给人看的报告（`changes.js` 第 9 行
 * 早就写着"不参与判定"），这里按同一套扫描规则自己走一遍：
 *   · 认知库全递归、其它库只到一级（由 `buildEntries` 折）；
 *   · `aggregateOnly` 子树**不进去**，只在下游记整棵合计；
 *   · 跳过版本库/依赖/平台目录（与工作区工具 `inventory` 的 `SKIP_DIRS` 一致）。
 *
 * @param {string} root 工作区根
 * @param {object} cfg  含 `aggregateOnly`
 * @returns {Array<{rel:string}>} 相对路径（`/` 分隔，不含被排除子树里的文件）
 */
export function listWorkspaceFiles(root, cfg = {}) {
  const aggregateOnly = (cfg.aggregateOnly || [])
    .map((s) => String(s).replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
  const isAggregated = (rel) => aggregateOnly.some((x) => rel === x || rel.startsWith(x + '/'));
  const out = [];
  const walk = (dir, relDir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(e.name)) continue;
        if (isAggregated(rel)) continue;   // 只记整棵合计，不列子文件
        walk(full, rel);
      } else {
        out.push({ rel });
      }
    }
  };
  walk(root, '');
  return out;
}

/** 目录：整棵合计字节 + 里面最新 mtime（**不列子文件**）。 */
export function subtreeAggregate(dir) {
  let size = 0, newest = null, files = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try {
        const st = statSync(full);
        size += st.size; files += 1;
        if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* 读不到的跳过 */ }
    }
  };
  walk(dir);
  return { size, mtime: newest, files };
}

/**
 * 扫一遍、算一遍。**不写文件**——写不写由调用方决定（工具/宿主各自负责）。
 *
 * @param {object} o
 *   · root     工作区根
 *   · readFile/writeFile 注入点（离线测用；默认 node:fs）
 *   · now
 * @returns {object} 报告（含 `state` / `prev` 两份**准备写出去的内容**）
 */
export function generateState(o = {}) {
  const {
    root,
    readFile = (p) => readFileSync(p, 'utf8'),
    now = Date.now(),
    criteria: overrideCriteria,
  } = o;
  const empty = { ok: false, reason: '', fresh: 0, bounded: null, derived: null, firstRun: false };
  if (!root) return { ...empty, reason: '没有工作区根' };

  const { libs, changes, criteria: workspaceCriteria, source } = loadWorkspaceConfig(root);
  // **生效判据**：默认 < `.dsh-milieu.json` 的 criteria < 宿主编译层传进来的 criteria。
  const criteria = mergeCriteria(mergeCriteria(DEFAULT_CRITERIA, workspaceCriteria), overrideCriteria);
  const cfg = {
    ...CHANGE_DEFAULTS,
    ...changes,
    keepDays: criteria.eventKeepDays,
    keepCount: criteria.eventKeepCount,
    recursiveLibs: (changes.recursiveLibs || [libs.review]).map(String),
  };
  const libPaths = { review: libs.review, tools: libs.tools, external: libs.external };
  const statePath = join(root, libs.review, STATE_FILE);
  const prevPath = join(root, libs.tools, PREV_FILE);

  // ① 文件表**直接扫**（不再依赖 `tools/manifest.md`——它只是给人看的报告）。
  //    旧实现在没有清单时直接放弃，导致全新工作区永远不生状态文件、客户端永远不提示重读。
  const fileList = listWorkspaceFiles(root, cfg);

  // 每个文件的 mtime（毫秒，取整）与指纹：**现读文件系统**，不经过任何缓存文本
  const files = [];
  for (const f of fileList) {
    const full = join(root, f.rel);
    let st = null;
    try { st = statSync(full); } catch { continue; }   // 清单有、盘上没了：跳过（下轮会算成 gone）
    files.push({ rel: f.rel, size: st.size, mtime: Math.round(st.mtimeMs), hash: fileFingerprint(full) });
  }

  // ② 被清单排除、只记整棵合计的子树（如 external/refs）
  const excluded = [];
  for (const rel of cfg.aggregateOnly || []) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    excluded.push({ rel: String(rel).replace(/\\/g, '/'), ...subtreeAggregate(abs) });
  }

  // ③ 要跟踪的条目表；**机制自己的产物先摘出去**（否则下一个"新增"就是它自己）
  const entries = buildEntries({ files, libs: libPaths, excluded, cfg });
  const cur = {};
  for (const [path, e] of Object.entries(entries)) {
    if (isSelfArtifact(path, libPaths)) continue;
    cur[path] = { size: e.size, hash: e.hash || null, mtime: e.mtime === null || e.mtime === undefined ? null : Math.round(e.mtime), kind: e.kind };
  }

  // ④ 上一次基准 —— **判"变没变"的唯一依据**
  let prev = null;
  if (existsSync(prevPath)) {
    try {
      const raw = JSON.parse(readFile(prevPath));
      prev = raw && raw.version === PREV_VERSION && raw.entries ? raw.entries : null;
    } catch { prev = null; }
  }
  const firstRun = prev === null;

  // ⑤ 老事件（窗口里留着的）+ 这一轮新产生的
  const oldState = (() => {
    if (!existsSync(statePath)) return emptyState();
    try {
      const raw = JSON.parse(readFile(statePath));
      return raw && raw.stateVersion === STATE_VERSION ? raw : emptyState();
    } catch { return emptyState(); }
  })();
  const prevEvents = Array.isArray(oldState.events) ? oldState.events : [];
  const fresh = diffEntries(prev, cur, firstRun);
  const merged = [...fresh, ...prevEvents.filter((e) => !fresh.some((f) => f.path === e.path))];
  const bounded = boundEvents(merged, now, cfg);
  const derived = project(bounded.events, libPaths);

  const state = {
    ...oldState,
    stateVersion: STATE_VERSION,
    generatedAt: now,
    workspaceKey: workspaceKey(root),
    libs: libPaths,
    criteria,
    managedSessions: normalizeManagedSessions(oldState.managedSessions),
    events: bounded.events,
    archived: (oldState.archived || 0) + bounded.archived,
    changeIndex: derived.changeIndex,      // **投影**（不是另算一份）
    counts: derived.counts,                // **投影**
    _firstRun: firstRun,
  };
  const prevNext = { version: PREV_VERSION, savedAt: now, entries: cur };

  return {
    ok: true,
    reason: firstRun ? '首轮：只建基准，不产事件' : '已生成',
    root, libs: libPaths, cfg, criteria, source,
    statePath, prevPath,
    entries: cur, state, prev: prevNext,
    fresh: fresh.length, bounded: bounded.events.length, archived: bounded.archived,
    derived, firstRun,
  };
}

/** 写出去（状态文件 + 基准）。**先写状态、再写基准**——基准只在状态写完之后才代表"上一轮"。 */
export function writeStateFile(report, o = {}) {
  const { writeFile = (p, t) => writeFileSync(p, t, 'utf8'), mkdir = (p) => mkdirSync(p, { recursive: true }) } = o;
  if (!report || !report.ok) return { ok: false, reason: (report && report.reason) || '没有可写的内容' };
  try {
    mkdir(join(report.root, report.libs.review));
    writeFile(report.statePath, JSON.stringify(report.state, null, 2) + '\n');
    writeFile(report.prevPath, JSON.stringify(report.prev, null, 1));
    return { ok: true, reason: '已写：' + report.statePath };
  } catch (err) {
    return { ok: false, reason: '写入失败：' + String((err && err.message) || err) };
  }
}

/** 一句话报告（给工具和宿主日志共用）。 */
export function summarize(report) {  if (!report || !report.ok) return '没能生成：' + ((report && report.reason) || '未知原因');
  const ci = report.derived.changeIndex;
  return '跟踪 ' + Object.keys(report.entries).length + ' 个条目；本轮新事件 ' + report.fresh
    + ' 条，窗口内 ' + report.bounded + ' 条'
    + (report.archived ? '（压掉 ' + report.archived + ' 条）' : '')
    + '；投影：认知库 ' + (ci.reviewAdded.length + ci.reviewChanged.length + ci.reviewGone.length)
    + ' 项、其余库 ' + (ci.otherAdded.length + ci.otherChanged.length + ci.otherGone.length) + ' 项'
    + (report.firstRun ? '【首轮】' : '');
}
