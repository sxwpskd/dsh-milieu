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
import { CHANGE_DEFAULTS } from './changes.js';
import { DEFAULT_CRITERIA } from './criteria.js';

/** 超过这么久没用 → 只给文件名（默认值在 criteria.js）。 */
export const STALE_DAYS = DEFAULT_CRITERIA.staleDays;
/** 视图 B 里认知库最多列几条；超过就整段不列（默认值在 criteria.js）。 */
export const STALE_MAX_REVIEW = DEFAULT_CRITERIA.staleMaxReview;

const MS_PER_DAY = 86400000;

/** 字节数 → 人话（B / KB / MB，一位小数；0 显示 0B）。 */
export function formatSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '0B';
  const abs = Math.abs(v);
  if (abs < 1024) return v + 'B';
  if (abs < 1024 * 1024) return (v / 1024).toFixed(1) + 'kb';
  return (v / (1024 * 1024)).toFixed(1) + 'mb';
}

/** 净变化 → 带符号的人话（`+23.1kb` / `-13.0mb` / `+0B`）。 */
export function formatDelta(n) {
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
export function aggregateEvents(events) {
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
export function renderChangeView(o = {}) {
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
