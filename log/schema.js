// dsh-milieu —— 日志数据结构（schema 层：纯模块，无副作用、不读写文件、不访问宿主）
//
// 依据：`plugin/dsh-milieu/LOG-SCHEMA.md` v2。这里的东西是**契约**：
//   · 事件表、级别集合、截断数字以本文件为准（文档同步维护）；
//   · 一行 = 一个 JSON 对象（JSONL）；序列化**只用 `JSON.stringify`**，禁止手拼字符串；
//   · **日志系统自身出错不能抛**：校验失败丢条目（可记一条 `log.invalid`），序列化失败返回最小行。
//
// 本文件不 import 'node:fs'、不写日志、不读配置——它只回答"这一条记录长什么样、合不合法"。

/** 日志结构版本。结构（删/改名/改类型）变了才升；新增字段不升。 */
export const LOG_VERSION = 1;

/** 全部级别（从低到高）。 */
export const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

/** 失败被谁挡住（与 `exception/codes.js` 的层名一致）。 */
export const BLOCKED_BY = Object.freeze(['host', 'fs', 'config', 'protocol', 'session', 'state', 'ui', 'unknown']);

/**
 * 大小上限（LOG-SCHEMA §5）。数字是契约：改动要同步文档与测试。
 *   · lineBytes        —— 一整行（UTF-8，含 JSON 骨架）
 *   · dataBytes        —— `data` 序列化后的字节数
 *   · errorMessageChars—— `error.message` 字符数
 *   · errorStackChars  —— `error.stack` 字符数（只在 error 级别出现）
 *   · messageChars     —— `message` 字符数
 */
export const LIMITS = Object.freeze({
  lineBytes: 2048,
  dataBytes: 512,
  errorMessageChars: 200,
  errorStackChars: 1024,
  messageChars: 500,
});

/** bootId 的形状：8 位小写字母/数字（宿主每次启动一个）。 */
export const BOOT_ID_RE = /^[a-z0-9]{8}$/;

/** ISO 8601 UTC 带毫秒与 Z（只允许 `toISOString()` 产物）。 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * **事件表**（LOG-SCHEMA §4）：每事件一个 `defaultLevel` + `allowedLevels`。
 * 事件名是稳定接口；新增事件必须先登记到这里（validateRecord 会拒未登记事件）。
 */
export const EVENTS = Object.freeze({
  'boot.start': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'boot.ready': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'protocol.sync': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'protocol.sync.failed': Object.freeze({ defaultLevel: 'error', allowedLevels: Object.freeze(['error']) }),
  'state.generate': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'state.generate.failed': Object.freeze({ defaultLevel: 'error', allowedLevels: Object.freeze(['error']) }),
  'state.page.refresh': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'state.page.skip': Object.freeze({ defaultLevel: 'debug', allowedLevels: Object.freeze(['debug']) }),
  'preload.create': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'preload.skip': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'preload.skip.unexpected': Object.freeze({ defaultLevel: 'warn', allowedLevels: Object.freeze(['warn']) }),
  'preload.failed': Object.freeze({ defaultLevel: 'error', allowedLevels: Object.freeze(['error']) }),
  'card.show': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'card.review': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'card.skip': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['info']) }),
  'ui.read.failed': Object.freeze({ defaultLevel: 'warn', allowedLevels: Object.freeze(['warn']) }),
  'log.message': Object.freeze({ defaultLevel: 'info', allowedLevels: Object.freeze(['debug', 'info', 'warn', 'error']) }),
  'error.caught': Object.freeze({ defaultLevel: 'warn', allowedLevels: Object.freeze(['warn', 'error']) }),
  'log.invalid': Object.freeze({ defaultLevel: 'warn', allowedLevels: Object.freeze(['warn']) }),
});

/** 事件名列表（调试/测试/统计用）。 */
export const EVENT_NAMES = Object.freeze(Object.keys(EVENTS));

/** 是不是登记过的日志级别。 */
export function isKnownLevel(level) {
  return typeof level === 'string' && LEVELS.includes(level);
}

/** 是不是登记过的事件。 */
export function isKnownEvent(event) {
  return typeof event === 'string' && Object.prototype.hasOwnProperty.call(EVENTS, event);
}

/** UTF-8 字节数（浏览器/Node 都有的 TextEncoder；取不到就退化成字符数估计）。 */
export function byteLengthOf(text) {
  const value = String(text ?? '');
  try {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  } catch {
    /* 没有 TextEncoder：走下面的估计 */
  }
  // 估计：非 ASCII 按 2 字节计（只用于大小上限，不用于精确断言之外的判断）
  let bytes = value.length;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 0x7f) bytes += 1;
  return bytes;
}

/** 截断字符串：超长时保留前缀并加 `…`（总长不超过 limit）。 */
export function clipChars(text, limit) {
  const value = String(text ?? '');
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (value.length <= max) return value;
  if (max <= 1) return '…'.slice(0, max);
  return value.slice(0, max - 1) + '…';
}

/** 完整记录的 UTF-8 行字节数；序列化失败返回 Infinity（由调用方降级）。 */
function lineBytesOf(record) {
  try {
    return byteLengthOf(JSON.stringify(record));
  } catch {
    return Infinity;
  }
}

/** 生成 8 位小写字母/数字 bootId（宿主每次启动一个；不用宿主服务，纯随机）。 */
export function makeBootId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return id;
}

/** 安全的时间串：正常用 `toISOString()`；坏输入退回当前时间（makeRecord 不应因此抛）。 */
function tsOf(now) {
  try {
    const date = now === undefined || now === null ? new Date() : new Date(now);
    const iso = date.toISOString();
    if (ISO_RE.test(iso)) return iso;
  } catch {
    /* 坏 now：退回当前时间 */
  }
  return new Date().toISOString();
}

/** 把输入的 error 归一成 `{name, message, stack?}`，并按上限截断。 */
function errorOf(raw, level) {
  if (raw === undefined || raw === null) return null;
  let name = 'Error';
  let message = '';
  let stack;
  if (raw instanceof Error) {
    name = typeof raw.name === 'string' && raw.name ? raw.name : 'Error';
    message = typeof raw.message === 'string' ? raw.message : String(raw.message ?? '');
    stack = typeof raw.stack === 'string' ? raw.stack : undefined;
  } else if (typeof raw === 'object') {
    if (typeof raw.name === 'string' && raw.name) name = raw.name;
    if (typeof raw.message === 'string') message = raw.message;
    else if (raw.message !== undefined) message = String(raw.message);
    if (typeof raw.stack === 'string') stack = raw.stack;
  } else {
    message = String(raw);
  }
  const out = { name, message };
  let truncated = false;
  const clippedMessage = clipChars(message, LIMITS.errorMessageChars);
  if (clippedMessage !== message) truncated = true;
  out.message = clippedMessage;
  // `stack` 只在 error 级别出现（LOG-SCHEMA §2.2）
  if (level === 'error' && stack) {
    const clippedStack = clipChars(stack, LIMITS.errorStackChars);
    if (clippedStack !== stack) truncated = true;
    out.stack = clippedStack;
  }
  return { value: out, truncated };
}

/** `data` 的大小检查：必须可序列化且 ≤ dataBytes；否则换成占位对象。 */
function dataOf(raw) {
  if (raw === undefined || raw === null) return { value: undefined, truncated: false };
  try {
    const json = JSON.stringify(raw);
    if (typeof json !== 'string') return { value: { _truncated: true }, truncated: true };
    if (byteLengthOf(json) > LIMITS.dataBytes) return { value: { _truncated: true }, truncated: true };
    return { value: raw, truncated: false };
  } catch {
    // 循环引用 / BigInt 等不可序列化：不悄悄丢字段，换成占位并标 truncated
    return { value: { _truncated: true }, truncated: true };
  }
}

/** 必填字段（"仍超只保留必填字段"时用）。 */
const REQUIRED_KEYS = Object.freeze(['v', 'ts', 'level', 'side', 'event', 'message', 'bootId']);

/** 把字符串压到"给定记录骨架 + 该字符串"不超过整行上限的最长前缀。 */
function fitTextIntoLine(skeleton, text) {
  const empty = { ...skeleton, message: '' };
  if (lineBytesOf({ ...empty, message: text }) <= LIMITS.lineBytes) return text;
  const base = lineBytesOf(empty);
  const budget = LIMITS.lineBytes - base;
  if (budget <= 0) return '';
  // 最多 500 字符：逐字符减，遇多字节字符按字节预算收
  let candidate = text;
  while (candidate.length > 0 && byteLengthOf(JSON.stringify(candidate)) > budget) {
    candidate = candidate.slice(0, candidate.length - 1);
  }
  if (candidate.length === text.length) return text;
  return candidate.length > 0 ? candidate.slice(0, Math.max(1, candidate.length - 1)) + '…' : '…'.slice(0, Math.max(0, budget > 1 ? 1 : 0));
}

/**
 * 整行超限时的降级顺序（LOG-SCHEMA §5 步骤 3–5）：
 *   压缩 data → 去掉 error.stack → 压 message → 只留必填字段 → 再压 message 到能容下。
 * @param {object} record 已按字段上限截断过的记录
 * @returns {object} 不超过整行上限的记录（`truncated:true`）
 */
function degradeToFit(record) {
  const next = { ...record, truncated: true };
  if (lineBytesOf(next) <= LIMITS.lineBytes) return next;

  // ① 压缩 data：先换成占位；再不行整个去掉
  if (next.data !== undefined) {
    next.data = { _truncated: true };
    if (lineBytesOf(next) <= LIMITS.lineBytes) return next;
    delete next.data;
    if (lineBytesOf(next) <= LIMITS.lineBytes) return next;
  }

  // ② 去掉 error.stack
  if (next.error && next.error.stack !== undefined) {
    next.error = { name: next.error.name, message: next.error.message };
    if (lineBytesOf(next) <= LIMITS.lineBytes) return next;
  }

  // ③ 压 message（先压到 120 字符，再不行只留必填字段）
  if (typeof next.message === 'string') {
    next.message = clipChars(next.message, 120);
    if (lineBytesOf(next) <= LIMITS.lineBytes) return next;
  }

  // ④ 只保留必填字段
  const minimal = { truncated: true };
  for (const key of REQUIRED_KEYS) {
    if (next[key] !== undefined) minimal[key] = next[key];
  }
  if (lineBytesOf(minimal) <= LIMITS.lineBytes) return minimal;

  // ⑤ 最后把 message 压到能容下的长度
  minimal.message = fitTextIntoLine(minimal, typeof minimal.message === 'string' ? minimal.message : '');
  return minimal;
}

/**
 * 造一条日志记录：填默认级别、按字段上限截断、必要时按整行上限降级。
 *
 * 规则（LOG-SCHEMA §3 / §5）：
 *   · 没给 level → 事件的 defaultLevel；
 *   · 给了但不在 allowedLevels → defaultLevel，并置 `levelAdjusted:true`；
 *   · 字段超限 → 截断并置 `truncated:true`（**不静默丢字段**）；
 *   · 整行超 2 KB → 按降级顺序压缩，仍置 `truncated:true`。
 *
 * **不抛**：内部异常时返回一条最小 `log.invalid` 记录（由调用方决定是否写出去）。
 * @param {object} input 至少给 `event` / `message`；`level` 可选
 * @returns {object} 记录对象（还没序列化）
 */
export function makeRecord(input = {}) {
  try {
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const event = typeof src.event === 'string' ? src.event : '';
    const spec = Object.prototype.hasOwnProperty.call(EVENTS, event) ? EVENTS[event] : null;

    let truncated = false;
    let levelAdjusted = false;
    let level;
    if (src.level === undefined || src.level === null || src.level === '') {
      level = spec ? spec.defaultLevel : 'info';
    } else if (typeof src.level === 'string' && spec && spec.allowedLevels.includes(src.level)) {
      level = src.level;
    } else {
      level = spec ? spec.defaultLevel : 'info';
      levelAdjusted = true;
    }

    let message = typeof src.message === 'string' ? src.message : (src.message === undefined || src.message === null ? '' : String(src.message));
    const clippedMessage = clipChars(message, LIMITS.messageChars);
    if (clippedMessage !== message) { message = clippedMessage; truncated = true; }

    const record = { v: LOG_VERSION, ts: tsOf(src.now), level };
    if (src.side !== undefined) record.side = src.side;
    if (src.bootId !== undefined) record.bootId = src.bootId;
    if (typeof src.module === 'string' && src.module) record.module = src.module;
    record.event = event;
    record.message = message;

    // 可选字段：类型原样带上，交给 validateRecord 判断（makeRecord 只负责归一/截断）
    if (src.ok !== undefined) record.ok = src.ok;
    if (src.code !== undefined) record.code = src.code;
    if (src.blockedBy !== undefined) record.blockedBy = src.blockedBy;
    if (src.workspaceKey !== undefined) record.workspaceKey = src.workspaceKey;
    if (src.sessionId !== undefined) record.sessionId = src.sessionId;
    if (src.requestId !== undefined) record.requestId = src.requestId;
    if (src.durationMs !== undefined) record.durationMs = src.durationMs;

    const error = errorOf(src.error, level);
    if (error) { record.error = error.value; if (error.truncated) truncated = true; }

    const data = dataOf(src.data);
    if (data.value !== undefined) record.data = data.value;
    if (data.truncated) truncated = true;

    let out = record;
    if (lineBytesOf(out) > LIMITS.lineBytes) {
      out = degradeToFit(out);
      truncated = true;
    }
    if (truncated) out.truncated = true;
    if (levelAdjusted) out.levelAdjusted = true;
    return out;
  } catch (err) {
    // 构造阶段自己出错：给一条最小 log.invalid（仍是记录对象，不抛）
    return {
      v: LOG_VERSION,
      ts: tsOf(),
      level: 'warn',
      side: 'host',
      bootId: makeBootId(),
      event: 'log.invalid',
      message: clipChars('日志记录构造失败：' + String((err && err.message) || err), LIMITS.messageChars),
      truncated: true,
    };
  }
}

/** 失败结果（校验内部用；与 exception/result.js 同形状但不依赖它）。 */
const invalid = (reason) => ({ ok: false, reason: String(reason || '未知原因') });

/** 是否普通对象（数据字段用）。 */
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * 校验一条记录（LOG-SCHEMA §2/§3）。
 * **不抛异常**：返回 `{ok:true, value:record}` 或 `{ok:false, reason}`。
 * 检查：必填字段与类型、v/ts、事件已登记、level ∈ 该事件 allowedLevels、host 必有 bootId、
 * 可选字段类型、`error`/`data` 大小上限（超长的记录应在 makeRecord 里截断，这里直接拒）。
 * 未知字段**允许**（新增字段不升版本，读的人忽略）。
 * @param {unknown} record
 */
export function validateRecord(record) {
  try {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return invalid('记录必须是普通对象');
    if (record.v !== LOG_VERSION) return invalid('v 必须是 ' + LOG_VERSION);
    if (typeof record.ts !== 'string' || !ISO_RE.test(record.ts) || Number.isNaN(Date.parse(record.ts))) {
      return invalid('ts 必须是 ISO 8601 UTC（带毫秒与 Z）');
    }
    if (!isKnownLevel(record.level)) return invalid('level 必须是 ' + LEVELS.join('/'));
    if (!isKnownEvent(record.event)) return invalid('事件未登记（新增事件必须先写进 EVENTS）');
    const spec = EVENTS[record.event];
    if (!spec.allowedLevels.includes(record.level)) {
      return invalid('事件 ' + record.event + ' 只允许级别 ' + spec.allowedLevels.join('/') + '，得到 ' + record.level);
    }
    if (record.side !== 'host' && record.side !== 'client') return invalid('side 必须是 host 或 client');
    if (record.side === 'host' && record.bootId === undefined) return invalid('side=host 必须带 bootId');
    if (record.bootId !== undefined && (typeof record.bootId !== 'string' || !BOOT_ID_RE.test(record.bootId))) {
      return invalid('bootId 必须是 8 位小写字母/数字');
    }
    if (typeof record.message !== 'string') return invalid('message 必须是字符串');
    if (record.message.length > LIMITS.messageChars) return invalid('message 超过 ' + LIMITS.messageChars + ' 字符');
    if (record.module !== undefined && typeof record.module !== 'string') return invalid('module 必须是字符串');
    if (record.ok !== undefined && typeof record.ok !== 'boolean') return invalid('ok 必须是布尔值');
    if (record.code !== undefined && typeof record.code !== 'string') return invalid('code 必须是字符串');
    if (record.blockedBy !== undefined && !BLOCKED_BY.includes(record.blockedBy)) {
      return invalid('blockedBy 必须是 ' + BLOCKED_BY.join('/'));
    }
    for (const key of ['workspaceKey', 'sessionId', 'requestId']) {
      if (record[key] !== undefined && typeof record[key] !== 'string') return invalid(key + ' 必须是字符串');
    }
    if (record.durationMs !== undefined && (typeof record.durationMs !== 'number' || !Number.isFinite(record.durationMs) || record.durationMs < 0)) {
      return invalid('durationMs 必须是非负有限数字');
    }
    if (record.error !== undefined) {
      const error = record.error;
      if (!isPlainObject(error)) return invalid('error 必须是对象');
      if (typeof error.name !== 'string' || typeof error.message !== 'string') return invalid('error.name / error.message 必须是字符串');
      if (error.message.length > LIMITS.errorMessageChars) return invalid('error.message 超过 ' + LIMITS.errorMessageChars + ' 字符');
      if (error.stack !== undefined) {
        if (record.level !== 'error') return invalid('error.stack 只允许出现在 error 级别');
        if (typeof error.stack !== 'string' || error.stack.length > LIMITS.errorStackChars) {
          return invalid('error.stack 必须是 ≤ ' + LIMITS.errorStackChars + ' 字符的字符串');
        }
      }
    }
    if (record.data !== undefined) {
      if (!isPlainObject(record.data)) return invalid('data 必须是对象');
      let json;
      try {
        json = JSON.stringify(record.data);
      } catch {
        return invalid('data 不可 JSON 序列化');
      }
      if (typeof json !== 'string' || byteLengthOf(json) > LIMITS.dataBytes) return invalid('data 超过 ' + LIMITS.dataBytes + ' 字节');
    }
    if (record.truncated !== undefined && typeof record.truncated !== 'boolean') return invalid('truncated 必须是布尔值');
    if (record.levelAdjusted !== undefined && typeof record.levelAdjusted !== 'boolean') return invalid('levelAdjusted 必须是布尔值');
    return { ok: true, value: record };
  } catch (err) {
    return invalid('校验时抛错：' + String((err && err.message) || err));
  }
}

/** 最小 `log.invalid` 记录（序列化失败时用）。 */
function minimalInvalidRecord(record, reason) {
  const side = record && record.side === 'client' ? 'client' : 'host';
  const validBootId = record && typeof record.bootId === 'string' && BOOT_ID_RE.test(record.bootId) ? record.bootId : makeBootId();
  const out = {
    v: LOG_VERSION,
    ts: tsOf(),
    level: 'warn',
    side,
    event: 'log.invalid',
    message: clipChars('日志序列化失败：' + String(reason || '未知原因'), LIMITS.messageChars),
    truncated: true,
  };
  if (side === 'host') out.bootId = validBootId;
  return out;
}

/** 模块加载时先造一个"兜底到极致"的固定行：连构造对象都失败时用。 */
const LAST_RESORT_LINE = JSON.stringify({
  v: LOG_VERSION,
  ts: '1970-01-01T00:00:00.000Z',
  level: 'warn',
  side: 'host',
  bootId: '00000000',
  event: 'log.invalid',
  message: '日志序列化失败',
});

/**
 * 记录 → 一行 JSON（JSONL）。**只用 `JSON.stringify`**，不手拼字符串；**永远不抛**。
 * 序列化失败（循环引用 / BigInt / 奇怪对象）→ 返回一条最小 `log.invalid` 行。
 * @param {unknown} record
 * @returns {string}
 */
export function toLine(record) {
  try {
    const line = JSON.stringify(record);
    if (typeof line === 'string' && line) return line;
    return JSON.stringify(minimalInvalidRecord(record, 'JSON.stringify 没有返回字符串'));
  } catch (err) {
    try {
      return JSON.stringify(minimalInvalidRecord(record, (err && err.message) || err));
    } catch {
      return LAST_RESORT_LINE;
    }
  }
}
