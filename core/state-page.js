// dsh-milieu —— **注入页的材料段**（核心层：读 → 只重写标记以下的材料，判断段一字不动）
//
// 为什么需要它（2026-10-18 主人反馈"感觉没发挥作用"）：
//   插件每轮注入的是工作区里那一页（`STATE.md`），但那一页的材料段只有**手动跑 summary.js** 才更新。
//   于是注入的永远是旧内容——看起来像没工作。这里让**启动时顺手刷新**材料段。
//
// 纪律（主人 2026-10-14 定）：**判断段是我的，材料段是机器的**。
//   只重写 `<!-- judgement -->` 标记**以下**；标记以上（以及没有标记的页面）**一个字都不碰**。
//   内容没变就不写（别制造无意义的"工作区又变了"）。
//
// 重构后的边界（ARCHITECTURE.md §6.3）：读写走参数传入的 `fs` 能力（`adapter/fs.js`），
//   本层不 import 'node:fs'；"页面存不存在 / 什么时候建骨架"由 `core/boot.js` 决定。
import { join, dirname } from 'node:path';
import { normalizeError } from '../exception/normalize.js';
import { CODES } from '../exception/codes.js';

/** 判断段与材料段的分界标记（summary.js 写的那一个）。 */
export const JUDGEMENT_MARK = '<!-- judgement -->';

/** 读清单里的文件数与生成时间（清单是给人看的；这里只取事实）。 */
function manifestFacts(root, libs, fs) {
  const path = join(root, libs.tools, 'manifest.md');
  if (!fs.exists(path)) return null;
  try {
    const text = fs.readText(path);
    const count = text.match(/- 文件数：\*\*(\d+)\*\*/);
    const generated = text.match(/- 清单生成于：(?:\*\*)?([^\n*]+)/);
    return { count: count ? Number(count[1]) : null, generatedAt: generated ? generated[1].trim() : null };
  } catch {
    return null;
  }
}

/** 把一条事件写成一行（给人看）。 */
function eventLine(event) {
  const delta = event.delta === null || event.delta === undefined ? '' : '（' + (event.delta >= 0 ? '+' : '') + event.delta + 'B）';
  const kind = event.kind === 'created' ? '新增' : event.kind === 'gone' ? '消失' : '改动';
  return '- `' + event.path + '`：' + kind + delta;
}

/** 生成材料段（短、够用；不复制 summary.js 的整份报告）。 */
export function buildMaterial({ root, libs, state, now = Date.now(), fs }) {
  const facts = manifestFacts(root, libs, fs);
  const libOk = (rel) => (fs.exists(join(root, rel)) ? '✅' : '❌ 缺');
  const events = Array.isArray(state && state.events) ? state.events : [];
  const counts = (state && state.counts) || {};
  const managed = Array.isArray(state && state.managedSessions) ? state.managedSessions.length : 0;
  const generated = state && state.generatedAt
    ? new Date(state.generatedAt).toLocaleString('zh-CN')
    : new Date(now).toLocaleString('zh-CN');

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
    for (const event of recent) lines.push('  ' + eventLine(event));
  }
  lines.push('- 受管会话：**' + managed + '** 条');
  return lines.join('\n');
}

/**
 * 首次安装时建一个**空状态页骨架**：只有判断段标记，材料段交给 `refreshStatePage`。
 *
 * 为什么需要：没有这一页，注入就找不到文件 → 状态页在**新工作区里永远不工作**
 *   （看起来像插件没装）。骨架只建一次，已有文件一个字都不碰。
 * @returns {{ok:boolean, created:boolean, reason:string}}
 */
export function ensureStatePage(o = {}) {
  const { root, statePath, fs } = o;
  if (!root || !statePath) return { ok: false, created: false, reason: '缺参数', code: CODES.CONFIG_INVALID, blockedBy: 'config' };
  if (!fs) return { ok: false, created: false, reason: '没有文件系统能力（fs）', code: CODES.FS_UNAVAILABLE, blockedBy: 'fs' };
  const path = join(root, statePath);
  if (fs.exists(path)) return { ok: true, created: false, reason: '已存在' };
  try { fs.mkdirp(dirname(path)); } catch { /* 父目录建不了，下面写入会报 */ }
  const skeleton = [
    '# 我的判断',
    '',
    '（这一页的"判断"由 agent 写；下面的"材料"由 dsh-milieu 自动刷新。）',
    '',
    JUDGEMENT_MARK,
    '',
  ].join('\n');
  try {
    fs.writeText(path, skeleton);
    return { ok: true, created: true, reason: '已建骨架' };
  } catch (err) {
    // 注入页是**装饰**（fail-open）：失败返回报告、带错误码，不抛。
    const failure = normalizeError(err, { code: CODES.STATE_INJECT_FAILED, blockedBy: 'fs' });
    return { ok: false, created: false, reason: '写不进去：' + failure.reason, code: failure.code, blockedBy: failure.blockedBy };
  }
}

/**
 * 刷新注入页的材料段。**只动标记以下**；没有标记就不写（那不是我们的页面）。
 * @returns {{ok:boolean, changed:boolean, reason:string}}
 */
export function refreshStatePage(o = {}) {
  const { root, libs, statePath, state, now = Date.now(), fs } = o;
  if (!root || !libs || !statePath) return { ok: false, changed: false, reason: '缺参数', code: CODES.CONFIG_INVALID, blockedBy: 'config' };
  if (!fs) return { ok: false, changed: false, reason: '没有文件系统能力（fs）', code: CODES.FS_UNAVAILABLE, blockedBy: 'fs' };
  const path = join(root, statePath);
  let text = '';
  if (fs.exists(path)) {
    try {
      text = fs.readText(path);
    } catch (err) {
      const failure = normalizeError(err, { code: CODES.STATE_INJECT_FAILED, blockedBy: 'fs' });
      return { ok: false, changed: false, reason: '读不到：' + failure.reason, code: failure.code, blockedBy: failure.blockedBy };
    }
  }
  const marker = text.indexOf(JUDGEMENT_MARK);
  if (marker < 0) {
    return { ok: false, changed: false, reason: '页面没有判断段标记（不碰）' };
  }
  const head = text.slice(0, marker + JUDGEMENT_MARK.length);
  const next = head + '\n\n' + buildMaterial({ root, libs, state, now, fs }) + '\n';
  if (next === text) return { ok: true, changed: false, reason: '材料段已是最新' };
  try {
    fs.writeText(path, next);
    return { ok: true, changed: true, reason: '材料段已刷新' };
  } catch (err) {
    // 注入页是**装饰**（fail-open）：失败返回报告、带错误码，不抛。
    const failure = normalizeError(err, { code: CODES.STATE_INJECT_FAILED, blockedBy: 'fs' });
    return { ok: false, changed: false, reason: '写不进去：' + failure.reason, code: failure.code, blockedBy: failure.blockedBy };
  }
}
