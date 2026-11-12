// dsh-milieu —— 运行时**副作用记录**：在真正写盘前把“这条改动将来怎么撤”记进台账。
//
// 用法（core/boot.js 的工作区根确定后）：
//   const ledger = createLedger({ root, fs });
//   const trackedFs = createTrackedFs({ fs, ledger, root, libs, statePath });
//   // 之后所有会写工作区的动作都传 trackedFs；读操作原样透传。
//
// 只记录插件自己声明的路径；用户文件不记、不撤。分类规则见 `classify()`。
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PROTOCOL_FILES } from '../constant/protocol.js';
import { beginMark } from '../protocol/version.js';
import { PROTO_VERSION } from '../constant/protocol.js';
import { JUDGEMENT_MARK } from '../core/state-page.js';

const BEGIN_MARK = beginMark({ version: PROTO_VERSION });

/** 协议文件名（工作区 `.dsh-milieu/` 下）。 */
const PROTOCOL_NAMES = new Set(PROTOCOL_FILES.map(([, name]) => name));

function relOf(root, path) {
  if (typeof path !== 'string' || !path) return null;
  const base = resolve(root);
  const abs = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, abs);
  if (!rel || rel === '..' || rel.startsWith('..' + '\\') || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

/**
 * 路径 → 撤回策略。`null` = 不是我们的路径，不记也不撤。
 * @param {string} rel
 * @param {{libs:object, statePath:string}} ctx
 */
export function classify(rel, ctx = {}) {
  const libs = ctx.libs || { review: 'review', tools: 'tools', external: 'external' };
  const statePath = ctx.statePath || 'STATE.md';
  const definition = '.dsh-milieu/DEFINITION.md';
  if (rel === 'AGENTS.md') return { owner: 'plugin', strategy: 'managed-block' };
  if (rel === definition || rel === '.dsh-milieu/SUGGESTIONS.md' || rel === '.dsh-milieu/RATIONALE.md') {
    return { owner: 'protocol', strategy: 'full' };
  }
  if (rel === libs.review + '/' + statePath) return { owner: 'plugin', strategy: 'state-material' };
  if (rel === libs.review + '/milieu-state.json') return { owner: 'plugin', strategy: 'remove' };
  if (rel === libs.tools + '/.milieu-state-prev.json') return { owner: 'plugin', strategy: 'remove' };
  if (rel === '.dsh-milieu' || rel === libs.review || rel === libs.tools || rel === libs.external) {
    return { owner: 'plugin', strategy: 'dir' };
  }
  if (rel.startsWith('.dsh-milieu/')) return { owner: 'plugin', strategy: 'remove' };
  return null;
}

/**
 * 包一层文件系统：写/删/改名/建目录前记录策略，读原样透传。
 * 台账自身写盘走原始 fs，避免“记录记录”的递归。
 */
export function createTrackedFs({ fs, ledger, root, libs, statePath } = {}) {
  if (!fs || !ledger || !root) return fs;
  const ctx = { libs, statePath };

  /** 记录路径（只在第一次碰它时记）。 */
  function remember(path, kindHint) {
    const rel = relOf(root, path);
    if (!rel) return;
    const spec = classify(rel, ctx);
    if (!spec) return;
    if (ledger.has(rel)) return;
    const abs = resolve(root, rel);
    const exists = fs.exists(abs);
    const kind = kindHint === 'removed' ? 'removed' : (exists ? 'modified' : 'created');
    const entry = { path: rel, kind, owner: spec.owner, strategy: spec.strategy };
    if (spec.strategy === 'full' || spec.strategy === 'state-material') {
      if (exists) {
        try { entry.backup = fs.readText(abs); } catch { /* 读不到备份：撤回时会报告 */ }
      }
    }
    try { ledger.record(entry); } catch { /* 台账坏了不能反噬写操作 */ }
  }

  /** 建目录前把缺失的每一层都记成 created/dir。 */
  function rememberDirs(abs) {
    const rootAbs = resolve(root);
    let cur = resolve(abs);
    const missing = [];
    while (cur && cur.startsWith(rootAbs) && cur !== rootAbs) {
      if (fs.exists(cur)) break;
      missing.push(cur);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    // 外层先记，撤回倒序时先删内层。
    for (const dir of missing.reverse()) {
      const rel = relOf(root, dir);
      if (!rel || ledger.has(rel)) continue;
      const spec = classify(rel, ctx);
      if (!spec) continue;
      try { ledger.record({ path: rel, kind: 'created', owner: spec.owner, strategy: 'dir' }); } catch { /* 同上 */ }
    }
  }

  return {
    ...fs,
    writeText(path, text) {
      remember(path, 'modified');
      return fs.writeText(path, text);
    },
    appendText(path, text) {
      remember(path, 'modified');
      return fs.appendText(path, text);
    },
    mkdirp(path) {
      rememberDirs(path);
      return fs.mkdirp(path);
    },
    remove(path) {
      remember(path, 'removed');
      return fs.remove(path);
    },
    /** 空目录删除也记为删除；撤销时没有备份就跳过（不会误删用户目录）。 */
    removeDir(path) {
      remember(path, 'removed');
      return fs.removeDir(path);
    },
    rename(from, to) {
      remember(from, 'removed');
      remember(to, 'modified');
      return fs.rename(from, to);
    },
  };
}

/**
 * 已有工作区“认领”旧产物：第一次启用的新版本没有台账，但工作区里可能已经有
 * 上一版本写下的协议/状态/日志。只补**已知路径**，不递归猜。
 * 首次安装（文件都不存在）什么也不做。
 */
export function seedKnownArtifacts({ ledger, fs, root, libs, statePath } = {}) {
  if (!ledger || !fs || !root) return 0;
  if (ledger.list().length > 0) return 0;
  const base = resolve(root);
  const ctx = { libs: libs || { review: 'review', tools: 'tools', external: 'external' }, statePath: statePath || 'STATE.md' };
  let added = 0;
  const add = (rel, spec, kind = 'modified', backup) => {
    if (!rel || ledger.has(rel)) return;
    try {
      ledger.record({ path: rel, kind, owner: spec.owner, strategy: spec.strategy, backup, seeded: true });
      added += 1;
    } catch { /* 认领失败不影响运行 */ }
  };

  const agents = join(base, 'AGENTS.md');
  try {
    if (fs.exists(agents) && fs.readText(agents).includes(BEGIN_MARK)) {
      add('AGENTS.md', { owner: 'plugin', strategy: 'managed-block' });
    }
  } catch { /* 读不到就不认领 */ }

  const statePage = join(base, ctx.libs.review, ctx.statePath);
  try {
    if (fs.exists(statePage)) {
      const text = fs.readText(statePage);
      const at = text.indexOf(JUDGEMENT_MARK);
      if (at >= 0 && text.slice(at + JUDGEMENT_MARK.length).trim()) {
        add(ctx.libs.review + '/' + ctx.statePath, { owner: 'plugin', strategy: 'state-material' });
      }
    }
  } catch { /* 同上 */ }

  for (const name of PROTOCOL_NAMES) {
    const rel = '.dsh-milieu/' + name;
    const abs = resolve(base, rel);
    try {
      if (fs.exists(abs)) add(rel, { owner: 'protocol', strategy: 'full' }, 'created');
    } catch { /* 同上 */ }
  }

  for (const rel of [
    ctx.libs.review + '/milieu-state.json',
    ctx.libs.tools + '/.milieu-state-prev.json',
    '.dsh-milieu/milieu.log',
    '.dsh-milieu/milieu.log.1',
    '.dsh-milieu/milieu.log.2',
    '.dsh-milieu/changes.jsonl',
    '.dsh-milieu/preload.json',
  ]) {
    try {
      if (fs.exists(resolve(base, rel))) add(rel, { owner: 'plugin', strategy: 'remove' }, 'created');
    } catch { /* 同上 */ }
  }
  return added;
}
