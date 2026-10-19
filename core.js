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

import { DEFAULT_CRITERIA } from './criteria.js';

/** 判据版本：判据本身变了要能看出来（旧记录按旧判据写的）。 */
export const CRITERIA_VERSION = 2;   // v2：自愈改按"缓存失效"定义；新增认知库完备性门槛

/** 缺省阈值（**默认值在 criteria.js**；这里导出同一份，供判据函数直接引用）。 */
export const DEFAULT_SETTINGS = {
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
export const READINESS_SPEC = { ...DEFAULT_CRITERIA.readiness };

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
export function normalizeChangeIndex(changeIndex) {
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
export const PROMPT_THRESHOLD_MS = DEFAULT_CRITERIA.promptThresholdMs;

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
export function shouldPromptOnReturn(sessionActivityAt, changeIndex, now = Date.now(), thresholdMs = PROMPT_THRESHOLD_MS) {
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
export function evaluateReadiness(snap, spec = READINESS_SPEC) {
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
export function evaluateInvalidation(diff, record, settings = DEFAULT_SETTINGS) {
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
export function buildChangeIndexPrompt(diff, libs = { review: 'review', tools: 'tools', external: 'external' }) {
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
export const FINGERPRINT_POLICY = { ...DEFAULT_CRITERIA.fingerprint };

/**
 * 哪些会话的指纹该留？
 * @param entries [{ sessionId, at }]，at = 那条会话最后活动时间（毫秒）
 * @param policy
 * @param now
 * @returns { keep:Set<string>, dropped:string[] }
 */
export function planFingerprintRetention(entries, policy = FINGERPRINT_POLICY, now = Date.now()) {
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
export function pickDirection(sessionAt, checkpoints) {
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
export function evaluateReturn(diff, sessionRecord, settings = DEFAULT_SETTINGS) {
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
export function evaluateExpiredSession(sessionAt, checkpoints) {
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
export function markThresholdReached(checkpoints, reachedAt, sessionAt, fingerprint) {
  const cp = { ...(checkpoints || {}) };
  const fps = { ...(cp.fingerprints || {}) };
  if (typeof sessionAt === 'number' && fingerprint) fps[String(sessionAt)] = { at: sessionAt, fp: fingerprint };
  cp.lastThresholdAt = reachedAt;
  cp.fingerprints = fps;
  return cp;
}

/** 工作区身份：同一个 cwd 就是同一个工作区（插件拿不到 workspaceId，只拿得到 cwd）。 */export function workspaceKey(cwd) {
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
export function findResident(store, cwd) {
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
export function isValidResident(record, liveSessionIds) {
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
export function shouldRefresh(diff, record, settings = DEFAULT_SETTINGS) {
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
export function staleHint(record, settings = DEFAULT_SETTINGS, now = Date.now()) {
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
export function selfHealingSurface() {
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
