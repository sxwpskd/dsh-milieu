// dsh-milieu —— **状态文件生成器**（核心层：算完返回，不自己退出进程；不 import 'node:fs'）
//
// 它是 [dsh-milieu/CHANGE-STATE-MACHINE.md](../../../dsh-milieu/CHANGE-STATE-MACHINE.md) v2 的实现：
//   扫一遍工作区 → 与上一次基准比（**只比字节 + 指纹**）→ 产出**事件流** → 有界 → 投影出六个桶与计数。
//
// **为什么住在包里**（2026-10-16 决定）：宿主不能假设用户工作区里有 `tools/`
//   （用户可能只装插件、不建工具区）。生成器要能在**只有这个包的工作区**里跑起来。
//   工具区那份 `milieu-state.mjs` 是**转调它**的开发工作台入口——一份实现，两个入口，不靠复制。
//
// 重构后的边界（ARCHITECTURE.md §6.3）：**读写走参数传入的 `fs` 能力**（`adapter/fs.js`），
//   **扫描范围与过滤规则留在这里**——"扫哪些目录"是本层的判断，不是适配层的。
//
// 纪律：**只读扫描 + 只写状态文件与我们自己的基准**；没有任何删除动作。
import { join } from 'node:path';
import { emptyState, normalizeManagedSessions } from '../model/state.js';
import { STATE_FILE, STATE_VERSION } from '../constant/state.js';
import { buildEntries, diffEntries, boundEvents, project, CHANGE_DEFAULTS, isSelfArtifact } from './changes.js';
import { workspaceKey } from '../utils/path.js';
import { fpBytes } from '../utils/fingerprint.js';
import { DEFAULT_CRITERIA, mergeCriteria } from '../config/criteria.js';
import { normalizeError } from '../exception/normalize.js';
import { CODES } from '../exception/codes.js';

const CFG_NAME = '.dsh-milieu.json';
const DEFAULT_LIBS = { review: 'review', tools: 'tools', external: 'external' };
const PREV_VERSION = 2;

/** 上次比对基准的文件名（工具区里）。 */
export const PREV_FILE = '.milieu-state-prev.json';

/** 扫描时跳过的目录：与工作区工具 `inventory` 的 `SKIP_DIRS` 保持一致。 */
const SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh']);

/** 读工作区配置（坏文件用默认值，不抛）。 */
export function loadWorkspaceConfig(root, fs) {
  const path = join(root, CFG_NAME);
  const def = { libs: DEFAULT_LIBS, changes: {}, criteria: {} };
  if (!fs.exists(path)) return { ...def, source: '默认（没有配置文件）' };
  try {
    const raw = JSON.parse(fs.readText(path));
    return {
      libs: { ...DEFAULT_LIBS, ...(raw.libs || {}) },
      changes: { ...(raw.changes || {}) },
      criteria: { ...(raw.criteria || {}) },
      source: CFG_NAME,
    };
  } catch (err) {
    return { ...def, source: CFG_NAME + '（解析失败，用默认：' + err.message + '）' };
  }
}

/** 文件指纹：**为"变没变"服务**（md5 12 位；清单那份 sha256 是给它自己用的）。 */
export function fileFingerprint(file, fs) {
  try {
    return fpBytes(fs.readBytes(file));
  } catch {
    return null; // 读不到：当作"指纹未知"，下轮再判
  }
}

/**
 * 上一份基准是不是**旧格式**（文件条目都没有内容指纹）？
 *
 * 2026-11-02 修：`buildEntries` 以前组装条目时把 `hash` 丢了，旧基准里文件条目全是 null。
 * 拿它跟新表比 → 要么把**全部文件误报成 changed**（null ≠ md5），要么按旧逻辑同大小变化漏报。
 * 旧基准不能判"变没变"，所以**整份当首轮基线重建一次**：这一轮不产事件，下一轮开始正常比。
 *
 * 判据："**有**文件条目、且这些文件条目**全部**缺指纹"才算旧格式。
 * 为什么不是"任一为 null"：只有个别文件指纹为 null，是那个文件当时读不到（权限等），
 * 按"任一"会让一个不可读文件导致**每轮都重建基准**，变更账就永远不工作了。
 * 目录/整棵合计本来就没有指纹，不参与判断。
 */
function isLegacyPrev(entries) {
  const fileEntries = Object.values(entries || {}).filter((e) => e && e.kind !== 'dir');
  if (fileEntries.length === 0) return false;
  return fileEntries.every((e) => typeof e.hash !== 'string' || !e.hash);
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
 * @param {object} fs   文件系统能力
 * @returns {Array<{rel:string}>} 相对路径（`/` 分隔，不含被排除子树里的文件）
 */
export function listWorkspaceFiles(root, cfg = {}, fs) {
  const aggregateOnly = (cfg.aggregateOnly || [])
    .map((s) => String(s).replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
  const isAggregated = (rel) => aggregateOnly.some((x) => rel === x || rel.startsWith(x + '/'));
  const out = [];
  const walk = (dir, relDir) => {
    let entries;
    try { entries = fs.readDir(dir); } catch { return; }
    for (const entry of entries) {
      const rel = relDir ? relDir + '/' + entry.name : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name)) continue;
        if (isAggregated(rel)) continue; // 只记整棵合计，不列子文件
        walk(full, rel);
      } else {
        out.push({ rel });
      }
    }
  };
  walk(root, '');
  return out;
}

/** 归一忽略表：`/` 分隔、去首尾斜杠；相对被扫的那个目录。坏输入当没有。 */
function normalizeIgnorePaths(ignore) {
  return (Array.isArray(ignore) ? ignore : [])
    .map((s) => String(s || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * 目录：整棵合计字节 + 里面最新 mtime（**不列子文件**）。
 *
 * `options.ignore`（可选）：**相对被扫目录**的文件/子树路径，命中的**不 stat、不计数**。
 * 为什么加它（2026-11 readiness bug）：`evaluateReadiness` 拿这棵合计当"认知库长得怎么样"，
 * 而插件自己每轮都在写 `milieu-state.json` / `STATE.md`——不排掉的话，插件越勤快，
 * 认知库看起来就"越在长"，readiness 永远不达标，预加载永远不建。
 * **旧调用不带第三参时行为一字不变**（`ignore` 为空 = 不忽略）。
 *
 * @param {string} dir 目录绝对路径
 * @param {object} fs  文件系统能力（必需；本层不 import 'node:fs'）
 * @param {{ignore?: string[]}} [options] 见上
 */
export function subtreeAggregate(dir, fs, options = {}) {
  const ignore = normalizeIgnorePaths(options && options.ignore);
  const isIgnored = (rel) => ignore.some((p) => rel === p || rel.startsWith(p + '/'));
  let size = 0;
  let newest = null;
  let files = 0;
  const walk = (current, relDir) => {
    let entries;
    try { entries = fs.readDir(current); } catch { return; }
    for (const entry of entries) {
      const rel = relDir ? relDir + '/' + entry.name : entry.name;
      if (isIgnored(rel)) continue; // 插件自己的产物：不进 readiness 的口径
      const full = join(current, entry.name);
      if (entry.isDirectory()) { walk(full, rel); continue; }
      try {
        const st = fs.stat(full);
        size += st.size;
        files += 1;
        if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* 读不到的跳过 */ }
    }
  };
  walk(dir, '');
  return { size, mtime: newest, files };
}

/**
 * 扫一遍、算一遍。**不写文件**——写不写由调用方决定（工具/宿主各自负责）。
 *
 * @param {object} o
 *   · root     工作区根
 *   · fs       文件系统能力（必需；本层不 import 'node:fs'）
 *   · now      生成时间（毫秒）
 *   · criteria 宿主编译层传进来的判据覆盖
 * @returns {object} 报告：`state` / `prev` 是两份**准备写出去的内容**；`freshEvents` 是这一轮
 *   新产生的事件数组（`fresh` 是它的计数；监控拿它写 `.dsh-milieu/changes.jsonl` 原始日志）。
 */
export function generateState(o = {}) {
  const {
    root,
    fs = null,
    now = Date.now(),
    criteria: overrideCriteria,
    turnEnd = null,
  } = o;
  const empty = { ok: false, reason: '', fresh: 0, freshEvents: [], bounded: null, derived: null, firstRun: false };
  if (!root) return { ...empty, reason: '没有工作区根', code: CODES.CONFIG_INVALID, blockedBy: 'config' };
  if (!fs) return { ...empty, reason: '没有文件系统能力（fs），不能扫描工作区', code: CODES.FS_UNAVAILABLE, blockedBy: 'fs' };

  const { libs, changes, criteria: workspaceCriteria, source } = loadWorkspaceConfig(root, fs);
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
  const fileList = listWorkspaceFiles(root, cfg, fs);

  // 每个文件的 mtime（毫秒，取整）与指纹：**现读文件系统**，不经过任何缓存文本
  const files = [];
  for (const f of fileList) {
    const full = join(root, f.rel);
    let st = null;
    try { st = fs.stat(full); } catch { continue; } // 清单有、盘上没了：跳过（下轮会算成 gone）
    files.push({ rel: f.rel, size: st.size, mtime: Math.round(st.mtimeMs), hash: fileFingerprint(full, fs) });
  }

  // ② 被清单排除、只记整棵合计的子树（如 external/refs）
  const excluded = [];
  for (const rel of cfg.aggregateOnly || []) {
    const abs = join(root, rel);
    if (!fs.exists(abs)) continue;
    excluded.push({ rel: String(rel).replace(/\\/g, '/'), ...subtreeAggregate(abs, fs) });
  }

  // ③ 要跟踪的条目表；**机制自己的产物先摘出去**（否则下一个"新增"就是它自己）
  const entries = buildEntries({ files, libs: libPaths, excluded, cfg });
  const cur = {};
  for (const [path, entry] of Object.entries(entries)) {
    if (isSelfArtifact(path, libPaths)) continue;
    cur[path] = {
      size: entry.size,
      hash: entry.hash || null,
      mtime: entry.mtime === null || entry.mtime === undefined ? null : Math.round(entry.mtime),
      kind: entry.kind,
    };
  }

  // ④ 上一次基准 —— **判"变没变"的唯一依据**
  let prev = null;
  if (fs.exists(prevPath)) {
    try {
      const raw = JSON.parse(fs.readText(prevPath));
      prev = raw && raw.version === PREV_VERSION && raw.entries ? raw.entries : null;
    } catch { prev = null; }
  }
  // 旧格式基准（文件条目没有指纹）不能用来判"变没变"：当首轮重建一次基线。
  // 不这样处理，升级后第一次扫描会把全部文件报成 changed（或按旧逻辑漏报同大小改动）。
  if (prev && isLegacyPrev(prev)) prev = null;
  const firstRun = prev === null;

  // ⑤ 老事件（窗口里留着的）+ 这一轮新产生的
  const oldState = (() => {
    if (!fs.exists(statePath)) return emptyState(now, criteria);
    try {
      const raw = JSON.parse(fs.readText(statePath));
      return raw && raw.stateVersion === STATE_VERSION ? raw : emptyState(now, criteria);
    } catch { return emptyState(now, criteria); }
  })();
  // **会话自己的 turn 基线**：agent 在本轮里改的文件，对这条会话来说是“已经读过”的；
  // 只有 turn 结束之后工作区再变，才值得提醒重读（2026-11-09 真机）。
  let managedSessions = normalizeManagedSessions(oldState.managedSessions);
  let turnEndChanged = false;
  if (turnEnd && typeof turnEnd.sessionId === 'string' && typeof turnEnd.at === 'number' && turnEnd.at > 0) {
    const index = managedSessions.findIndex((entry) => entry.sessionId === turnEnd.sessionId);
    if (index >= 0) {
      const previous = managedSessions[index].lastTurnEnd || 0;
      if (turnEnd.at > previous) {
        managedSessions = managedSessions.slice();
        managedSessions[index] = { ...managedSessions[index], lastTurnEnd: turnEnd.at };
        turnEndChanged = true;
      }
    }
  }
  const prevEvents = Array.isArray(oldState.events) ? oldState.events : [];
  // 配置里的判据也可以变（配置页保存 / profile 重载）。状态文件里的 `criteria`
  // 是客户端的生效值：变了就要写一次，哪怕工作区文件一个都没变——否则悬浮球会一直
  // 显示上一轮启动时的旧值（2026-11-09 真机：配置页 6 分钟、悬浮球 1 天）。
  const previousCriteria = oldState && oldState.criteria && typeof oldState.criteria === 'object'
    ? oldState.criteria
    : null;
  const criteriaChanged = JSON.stringify(previousCriteria) !== JSON.stringify(criteria);
  // `freshEvents` 原样交给监控写原始日志（`.dsh-milieu/changes.jsonl`）；
  // 状态文件里的 `events` 仍是**有界投影**，两者不是一回事。
  const freshEvents = diffEntries(prev, cur, firstRun);
  const merged = [...freshEvents, ...prevEvents.filter((e) => !freshEvents.some((f) => f.path === e.path))];
  const bounded = boundEvents(merged, now, cfg);
  const derived = project(bounded.events, libPaths);

  const state = {
    ...oldState,
    stateVersion: STATE_VERSION,
    generatedAt: now,
    workspaceKey: workspaceKey(root),
    libs: libPaths,
    criteria,
    managedSessions,
    events: bounded.events,
    archived: (oldState.archived || 0) + bounded.archived,
    changeIndex: derived.changeIndex, // **投影**（不是另算一份）
    counts: derived.counts,           // **投影**
    _firstRun: firstRun,
  };
  const prevNext = { version: PREV_VERSION, savedAt: now, entries: cur };

  return {
    ok: true,
    reason: firstRun ? '首轮：只建基准，不产事件' : '已生成',
    root, libs: libPaths, cfg, criteria, source,
    statePath, prevPath,
    entries: cur, state, prev: prevNext,
    // `fresh` 是计数（旧的读法保留）；`freshEvents` 是这一轮的新事件数组（监控写原始日志用）。
    fresh: freshEvents.length,
    freshEvents,
    bounded: bounded.events.length, archived: bounded.archived,
    derived, firstRun, criteriaChanged, turnEndChanged,
  };
}

/**
 * 写出去（状态文件 + 基准）。**先写状态、再写基准**——基准只在状态写完之后才代表"上一轮"。
 *
 * @param {object} report `generateState` 的返回值
 * @param {{fs:object}} [o] 文件系统能力
 */
export function writeStateFile(report, o = {}) {
  const { fs = null } = o;
  if (!fs) return { ok: false, reason: '没有文件系统能力（fs），不能写状态文件', code: CODES.FS_UNAVAILABLE, blockedBy: 'fs' };
  if (!report || !report.ok) {
    return {
      ok: false,
      reason: (report && report.reason) || '没有可写的内容',
      code: (report && report.code) || CODES.STATE_WRITE_FAILED,
      blockedBy: (report && report.blockedBy) || null,
    };
  }
  try {
    fs.mkdirp(join(report.root, report.libs.review));
    fs.writeText(report.statePath, JSON.stringify(report.state, null, 2) + '\n');
    fs.writeText(report.prevPath, JSON.stringify(report.prev, null, 1));
    return { ok: true, reason: '已写：' + report.statePath };
  } catch (err) {
    // 写入边界（task-5）：异常归一成带稳定错误码的失败结果；**reason 文案不变**。
    const failure = normalizeError(err, { code: CODES.STATE_WRITE_FAILED, blockedBy: 'fs' });
    return { ok: false, reason: '写入失败：' + failure.reason, code: failure.code, blockedBy: failure.blockedBy };
  }
}

/** 一句话报告（给工具和宿主日志共用）。 */
export function summarize(report) {
  if (!report || !report.ok) return '没能生成：' + ((report && report.reason) || '未知原因');
  const ci = report.derived.changeIndex;
  return '跟踪 ' + Object.keys(report.entries).length + ' 个条目；本轮新事件 ' + report.fresh
    + ' 条，窗口内 ' + report.bounded + ' 条'
    + (report.archived ? '（压掉 ' + report.archived + ' 条）' : '')
    + '；投影：认知库 ' + (ci.reviewAdded.length + ci.reviewChanged.length + ci.reviewGone.length)
    + ' 项、其余库 ' + (ci.otherAdded.length + ci.otherChanged.length + ci.otherGone.length) + ' 项'
    + (report.firstRun ? '【首轮】' : '');
}
