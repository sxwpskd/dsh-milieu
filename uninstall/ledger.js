// dsh-milieu —— **卸载层：副作用台账与撤回**（插件特有；不是宿主回调）
//
// 为什么不能只写卸载回调（_scaffold/uninstall/README.md）：
//   宿主卸载时插件的代码已经没了，跑不了 dispose。卸载 = ① 运行时记台账；
//   ② 用户**先**跑 withdraw 再卸插件；宿主若有卸载钩子才在钩子里调。
//
// 台账：<root>/.dsh-milieu/side-effects.json
//   { version, plugin, items: [{ kind, path, owner, strategy, backup? }] }
//   · kind: created / modified / removed
//   · owner: plugin（默认撤）/ protocol（默认留，--all 才撤）/ user（永远不撤）
//   · strategy: full（按 backup 还原）/ remove（插件私有运行痕迹，直接删）/
//               managed-block（只撤 AGENTS.md 托管段）/ state-material（只撤 STATE.md 材料段）/
//               dir（空目录才删）
//   · path 一律相对工作区根，撤回时做根内校验，禁止目录穿越。
//
// 撤回：**默认 dryRun**；--all 才连协议文件一起撤。幂等：成功后删台账，再跑就是“没有台账”。
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { beginMark } from '../protocol/version.js';
import { END, PROTO_VERSION } from '../constant/protocol.js';
import { JUDGEMENT_MARK } from '../core/state-page.js';

export const LEDGER_VERSION = 1;
export const LEDGER_REL = '.dsh-milieu/side-effects.json';
export const OWNERS = ['plugin', 'protocol', 'user'];
export const KINDS = ['created', 'modified', 'removed'];
export const STRATEGIES = ['full', 'remove', 'managed-block', 'state-material', 'dir'];

const BEGIN_MARK = beginMark({ version: PROTO_VERSION });

/** 把绝对路径归一成相对工作区根的 `/` 路径；越界/根自身返回 null。 */
export function toRel(root, path) {
  if (typeof root !== 'string' || !root || typeof path !== 'string' || !path) return null;
  const base = resolve(root);
  const abs = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, abs);
  if (!rel || rel.startsWith('..' + '\\') || rel.startsWith('../') || isAbsolute(rel)) return null;
  if (rel === '..') return null;
  return rel.split('\\').join('/');
}

/** 相对路径解析回绝对路径，并保证仍在根内。 */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel)) return null;
  const base = resolve(root);
  const abs = resolve(base, rel);
  const back = relative(base, abs);
  if (!back || back === '..' || back.startsWith('..' + '\\') || back.startsWith('../') || isAbsolute(back)) return null;
  return abs;
}

/** 删掉文本里的托管段（只认完整标记；段外保留）。 */
export function withoutManagedBlock(text) {
  const source = String(text ?? '');
  const begin = source.indexOf(BEGIN_MARK);
  if (begin < 0) return { text: source, changed: false };
  const endAt = source.indexOf(END, begin);
  const after = endAt < 0 ? begin : endAt + END.length;
  let next = source.slice(0, begin) + source.slice(after);
  next = next.replace(/\s*$/, '');
  if (next) next += '\n';
  return { text: next, changed: true };
}

/** 删掉 STATE.md 材料段（判断段及其标记保留）。 */
export function withoutStateMaterial(text) {
  const source = String(text ?? '');
  const at = source.indexOf(JUDGEMENT_MARK);
  if (at < 0) return { text: source, changed: false };
  const head = source.slice(0, at + JUDGEMENT_MARK.length);
  const next = head.replace(/\s*$/, '') + '\n';
  return { text: next, changed: next !== source };
}

/** 从旧文中取材料段，拼到当前判断段后面（保留当前判断段）。 */
export function restoreStateMaterial(current, backup) {
  const cur = String(current ?? '');
  const at = cur.indexOf(JUDGEMENT_MARK);
  if (at < 0) return { text: cur, changed: false };
  const head = cur.slice(0, at + JUDGEMENT_MARK.length);
  const old = String(backup ?? '');
  const oldAt = old.indexOf(JUDGEMENT_MARK);
  const material = oldAt >= 0 ? old.slice(oldAt + JUDGEMENT_MARK.length) : '';
  const next = material.trim()
    ? head.replace(/\s*$/, '') + '\n\n' + material.replace(/^\s*\n+/, '').replace(/\s*$/, '') + '\n'
    : head.replace(/\s*$/, '') + '\n';
  return { text: next, changed: next !== cur };
}

/** 读台账文件；坏文件返回空，不抛。 */
function loadItems(fs, path) {
  if (typeof fs.exists !== 'function' || !fs.exists(path)) return { exists: false, items: [] };
  try {
    const raw = JSON.parse(fs.readText(path));
    if (!raw || raw.version !== LEDGER_VERSION || !Array.isArray(raw.items)) return { exists: true, items: [] };
    const items = raw.items.filter((item) => item && typeof item.path === 'string'
      && KINDS.includes(item.kind) && OWNERS.includes(item.owner));
    return { exists: true, items };
  } catch {
    return { exists: true, items: [] };
  }
}

/**
 * 造/加载一个副作用台账。**永不抛**：坏台账按空处理，记不进去只返回 false。
 * @param {{root:string, fs:object, plugin?:string}} o
 */
export function createLedger({ root, fs, plugin = 'dsh-milieu' } = {}) {
  const base = root ? resolve(root) : '';
  const ledgerPath = base ? join(base, '.dsh-milieu', 'side-effects.json') : '';
  const loaded = base && fs ? loadItems(fs, ledgerPath) : { exists: false, items: [] };
  const items = loaded.items.map((item) => ({ ...item }));
  let existed = loaded.exists;

  function ensureDir() {
    const dir = base ? join(base, '.dsh-milieu') : '';
    if (!base || !dir) return false;
    if (fs.exists(dir)) return false;
    try { fs.mkdirp(dir); } catch { return false; }
    return true;
  }

  function save() {
    if (!base || !fs) return false;
    ensureDir();
    try {
      fs.writeText(ledgerPath, JSON.stringify({ version: LEDGER_VERSION, plugin, items }, null, 2) + '\n');
      existed = true;
      return true;
    } catch {
      return false;
    }
  }

  function has(path) {
    const rel = base ? toRel(base, path) : null;
    if (!rel) return false;
    return items.some((item) => item.path === rel);
  }

  function record(item) {
    if (!item || typeof item.path !== 'string' || !item.path) return false;
    if (!KINDS.includes(item.kind)) return false;
    const rel = toRel(base, item.path);
    if (!rel) return false;
    if (items.some((entry) => entry.path === rel)) return false;
    const owner = OWNERS.includes(item.owner) ? item.owner : 'plugin';
    const strategy = STRATEGIES.includes(item.strategy) ? item.strategy : 'full';
    const createdDir = ensureDir();
    if (createdDir && !items.some((entry) => entry.path === '.dsh-milieu')) {
      // 目录记录放在最前；撤回时倒序处理，目录会在文件之后删。
      items.unshift({ kind: 'created', path: '.dsh-milieu', owner: 'plugin', strategy: 'dir' });
    }
    if (items.some((entry) => entry.path === rel)) return false;
    const entry = { kind: item.kind, path: rel, owner, strategy };
    if (typeof item.backup === 'string') entry.backup = item.backup;
    if (item.seeded === true) entry.seeded = true;
    items.push(entry);
    save();
    return true;
  }

  function list() {
    return items.map((item) => ({ ...item }));
  }

  function withdraw({ dryRun = true, all = false } = {}) {
    if (!base || !fs) {
      return { ok: false, dryRun, all, reason: '缺工作区根或文件系统能力', actions: [] };
    }
    if (!existed) {
      return { ok: true, dryRun, all, reason: '没有副作用台账（无需撤回）', actions: [] };
    }
    const result = withdrawItems({ root: base, fs, items, dryRun, all });
    // 协议默认保留时**不能删台账**：否则下次 --all 想撤协议已经找不到依据。
    if (!dryRun && result.ok && !result.retained) {
      existed = false;
      items.length = 0;
      try { if (fs.exists(ledgerPath)) fs.remove(ledgerPath); } catch { /* 台账删不掉就留着，下次可重试 */ }
      // 台账删掉后再尝试删空目录（协议保留时目录非空，会自然跳过）。
      try {
        const dir = join(base, '.dsh-milieu');
        if (fs.exists(dir) && fs.readDir(dir).length === 0) fs.removeDir(dir);
      } catch { /* 目录非空/删不掉都正常 */ }
      for (const action of result.actions) {
        if (action.action !== 'remove-dir' || action.ok === false) continue;
        const abs = resolveInside(base, action.path);
        try {
          if (abs && fs.exists(abs) && fs.readDir(abs).length === 0) fs.removeDir(abs);
          else if (abs && fs.exists(abs)) action.reason = '目录非空，保留';
        } catch { /* 目录删不掉就保留 */ }
      }
    }
    return result;
  }

  return {
    root: base,
    path: ledgerPath,
    existed,
    record,
    has,
    list,
    save,
    withdraw,
    toJSON: () => ({ version: LEDGER_VERSION, plugin, items: list() }),
  };
}

/** 撤回条目（纯编排；真正动盘只在这里，方便单测）。 */
export function withdrawItems({ root, fs, items, dryRun = true, all = false } = {}) {
  const actions = [];
  const queue = [];
  const seen = new Set();
  for (const item of [...(items || [])].reverse()) {
    const rel = toRel(root, item.path);
    if (!rel) {
      actions.push({ action: 'skip', path: String(item.path), ok: false, reason: '路径越界，不撤' });
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (item.owner === 'user') {
      actions.push({ action: 'skip', path: rel, ok: false, reason: '用户文件，永远不撤' });
      continue;
    }
    if (item.owner === 'protocol' && !all) {
      actions.push({ action: 'skip', path: rel, ok: true, retained: true, reason: '协议默认保留（--all 才撤）' });
      continue;
    }
    queue.push({ item, rel });
  }

  for (const { item, rel } of queue) {
    const abs = resolveInside(root, rel);
    if (!abs) {
      actions.push({ action: 'skip', path: rel, ok: false, reason: '路径越界，不撤' });
      continue;
    }
    if (item.kind === 'created') {
      if (item.strategy === 'dir') {
        actions.push({ action: 'remove-dir', path: rel, ok: true });
      } else if (item.strategy === 'managed-block') {
        // 文件是插件建的，但 AGENTS.md 里可能有用户后来写的内容：只撤托管段。
        actions.push({ action: 'managed-block', path: rel, ok: true });
      } else if (item.strategy === 'state-material') {
        actions.push({ action: 'state-material', path: rel, ok: true });
      } else {
        actions.push({ action: 'remove', path: rel, ok: true });
      }
    } else if (item.kind === 'removed') {
      if (typeof item.backup === 'string') actions.push({ action: 'restore', path: rel, ok: true, backup: item.backup });
      else actions.push({ action: 'skip', path: rel, ok: true, reason: '没有备份，无法还原' });
    } else if (item.strategy === 'remove') {
      actions.push({ action: 'remove', path: rel, ok: true });
    } else if (item.strategy === 'managed-block') {
      actions.push({ action: 'managed-block', path: rel, ok: true });
    } else if (item.strategy === 'state-material') {
      actions.push({ action: 'state-material', path: rel, ok: true, backup: item.backup });
    } else if (typeof item.backup === 'string') {
      actions.push({ action: 'restore', path: rel, ok: true, backup: item.backup });
    } else {
      actions.push({ action: 'skip', path: rel, ok: false, reason: '没有备份，不能撤回' });
    }
  }

  if (!dryRun) {
    for (const action of actions) {
      if (action.ok === false) continue;
      const abs = resolveInside(root, action.path);
      if (!abs) { action.ok = false; action.reason = '路径越界，不撤'; continue; }
      try {
        if (action.action === 'remove') {
          if (fs.exists(abs)) fs.remove(abs);
        } else if (action.action === 'remove-dir') {
          if (fs.exists(abs) && fs.readDir(abs).length === 0) fs.removeDir(abs);
          else action.reason = '目录非空，保留';
        } else if (action.action === 'restore') {
          fs.mkdirp(dirname(abs));
          fs.writeText(abs, action.backup);
        } else if (action.action === 'managed-block') {
          if (!fs.exists(abs)) { action.reason = '文件不在，跳过'; continue; }
          const out = withoutManagedBlock(fs.readText(abs));
          if (!out.changed) { action.reason = '没有托管段，跳过'; continue; }
          if (!out.text.trim()) {
            // AGENTS.md 只剩托管段（通常不可能）→ 删文件；否则保留用户内容。
            fs.remove(abs);
          } else {
            fs.writeText(abs, out.text);
          }
        } else if (action.action === 'state-material') {
          if (!fs.exists(abs)) { action.reason = '文件不在，跳过'; continue; }
          const current = fs.readText(abs);
          const out = typeof action.backup === 'string'
            ? restoreStateMaterial(current, action.backup)
            : withoutStateMaterial(current);
          if (!out.changed) { action.reason = '没有材料段，跳过'; continue; }
          fs.writeText(abs, out.text);
        }
      } catch (err) {
        action.ok = false;
        action.reason = String((err && err.message) || err || '未知原因');
      }
    }
  }

  return {
    ok: actions.every((a) => a.ok !== false),
    dryRun,
    all,
    retained: actions.some((a) => a.retained === true),
    actions,
    reason: dryRun ? 'dry-run：没有改动磁盘' : '撤回完成',
  };
}
