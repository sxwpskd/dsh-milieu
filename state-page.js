// dsh-milieu —— **注入页的材料段**（纯模块：读 → 只重写标记以下的材料，判断段一字不动）
//
// 为什么需要它（2026-10-18 主人反馈"感觉没发挥作用"）：
//   插件每轮注入的是工作区里那一页（`STATE.md`），但那一页的材料段只有**手动跑 summary.js** 才更新。
//   于是注入的永远是旧内容——看起来像没工作。这里让**启动时顺手刷新**材料段。
//
// 纪律（主人 2026-10-14 定）：**判断段是我的，材料段是机器的**。
//   只重写 `<!-- judgement -->` 标记**以下**；标记以上（以及没有标记的页面）**一个字都不碰**。
//   内容没变就不写（别制造无意义的"工作区又变了"）。
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 判断段与材料段的分界标记（summary.js 写的那一个）。 */
export const JUDGEMENT_MARK = '<!-- judgement -->';

/** 读清单里的文件数与生成时间（清单是给人看的；这里只取事实）。 */
function manifestFacts(root, libs) {
  const p = join(root, libs.tools, 'manifest.md');
  if (!existsSync(p)) return null;
  try {
    const t = readFileSync(p, 'utf8');
    const n = t.match(/- 文件数：\*\*(\d+)\*\*/);
    const g = t.match(/- 清单生成于：(?:\*\*)?([^\n*]+)/);
    return { count: n ? Number(n[1]) : null, generatedAt: g ? g[1].trim() : null };
  } catch { return null; }
}

/** 把一条事件写成一行（给人看）。 */
function eventLine(e) {
  const d = e.delta === null || e.delta === undefined ? '' : '（' + (e.delta >= 0 ? '+' : '') + e.delta + 'B）';
  const kind = e.kind === 'created' ? '新增' : e.kind === 'gone' ? '消失' : '改动';
  return '- `' + e.path + '`：' + kind + d;
}

/** 生成材料段（短、够用；不复制 summary.js 的整份报告）。 */
export function buildMaterial({ root, libs, state, now = Date.now() }) {
  const facts = manifestFacts(root, libs);
  const libOk = (rel) => (existsSync(join(root, rel)) ? '✅' : '❌ 缺');
  const events = Array.isArray(state && state.events) ? state.events : [];
  const counts = (state && state.counts) || {};
  const managed = Array.isArray(state && state.managedSessions) ? state.managedSessions.length : 0;
  const generated = state && state.generatedAt ? new Date(state.generatedAt).toLocaleString('zh-CN') : new Date(now).toLocaleString('zh-CN');

  const lines = [];
  lines.push('## 工作区状态（材料，机器生成）');
  lines.push('');
  lines.push('- 变更账生成于：' + generated + '　根目录：`' + root + '`'
    + (facts && facts.count !== null ? '，共 **' + facts.count + '** 个文件' : ''));
  lines.push('- 三库：认知库 `' + libs.review + '/` ' + libOk(libs.review)
    + '　工具区 `' + libs.tools + '/` ' + libOk(libs.tools)
    + '　外部信息区 `' + libs.external + '/` ' + libOk(libs.external));
  lines.push('- 变更账：事件 **' + events.length + '** 条（新增 ' + (counts.added || 0)
    + ' / 改动 ' + (counts.changed || 0) + ' / 消失 ' + (counts.gone || 0)
    + '）' + (state && state.archived ? '，更早归档 ' + state.archived + ' 条' : ''));
  if (events.length) {
    const recent = [...events].sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 5);
    lines.push('- 最近的改动：');
    for (const e of recent) lines.push('  ' + eventLine(e));
  }
  lines.push('- 受管会话：**' + managed + '** 条');
  return lines.join('\n');
}

/**
 * 首次安装时建一个**空状态页骨架**：只有判断段标记，材料段交给 `refreshStatePage`。
 *
 * 为什么需要：没有这一页，`composeSection` 找不到文件 → 状态页注入在**新工作区里永远不工作**
 *   （看起来像插件没装）。骨架只建一次，已有文件一个字都不碰。
 * @returns {{ok:boolean, created:boolean, reason:string}}
 */
export function ensureStatePage(o = {}) {
  const { root, statePath } = o;
  if (!root || !statePath) return { ok: false, created: false, reason: '缺参数' };
  const p = join(root, statePath);
  if (existsSync(p)) return { ok: true, created: false, reason: '已存在' };
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* 父目录建不了，下面写入会报 */ }
  const skeleton = [
    '# 我的判断',
    '',
    '（这一页的"判断"由 agent 写；下面的"材料"由 dsh-milieu 自动刷新。）',
    '',
    JUDGEMENT_MARK,
    '',
  ].join('\n');
  try {
    writeFileSync(p, skeleton, 'utf8');
    return { ok: true, created: true, reason: '已建骨架' };
  } catch (e) {
    return { ok: false, created: false, reason: '写不进去：' + e.message };
  }
}

/**
 * 刷新注入页的材料段。**只动标记以下**；没有标记就不写（那不是我们的页面）。
 * @returns {{ok:boolean, changed:boolean, reason:string}}
 */
export function refreshStatePage(o = {}) {
  const { root, libs, statePath, state, now = Date.now() } = o;
  if (!root || !libs || !statePath) return { ok: false, changed: false, reason: '缺参数' };
  const p = join(root, statePath);
  let text = '';
  if (existsSync(p)) {
    try { text = readFileSync(p, 'utf8'); } catch (e) { return { ok: false, changed: false, reason: '读不到：' + e.message }; }
  }
  const marker = text.indexOf(JUDGEMENT_MARK);
  if (marker < 0) {
    return { ok: false, changed: false, reason: '页面没有判断段标记（不碰）' };
  }
  const head = text.slice(0, marker + JUDGEMENT_MARK.length);
  const next = head + '\n\n' + buildMaterial({ root, libs, state, now }) + '\n';
  if (next === text) return { ok: true, changed: false, reason: '材料段已是最新' };
  try {
    writeFileSync(p, next, 'utf8');
    return { ok: true, changed: true, reason: '材料段已刷新' };
  } catch (e) {
    return { ok: false, changed: false, reason: '写不进去：' + e.message };
  }
}
