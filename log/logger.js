// dsh-milieu —— 日志器（log 层：构建记录、校验、写 sink；**不读写文件、不 import 'node:fs'**）
//
// 依据 `plugin/dsh-milieu/LOG-SCHEMA.md` v2。本文件只做四件事：
//   ① 用 `log/schema.js` 的 `makeRecord` / `validateRecord` / `toLine` 构建一行 JSONL；
//   ② 把这一行交给配置的 `sinks`（宿主文件 sink、客户端内存 sink 后续任务再接）；
//   ③ **日志自身失败不抛**：非法记录丢弃（每个 logger 最多记一条 `log.invalid`，不递归）；
//      某个 sink 抛错 → 该 sink 禁用，**最多一次**回退提示（不刷屏）；
//   ④ 兼容旧调用 `info/warn/error(message)` → `log.message` 事件。
//
// 两种用法（同一入口，靠形状区分）：
//   · 旧形态：`createLogger(hostLogger)` —— 保持重构前行为：把**原文**交给宿主 logger，
//     不加前缀、不改文案（boot/index 现在还是这么用的；后续任务再换 record/event）。
//   · 新形态：`createLogger({ side, bootId, module, sinks, hostLogger })` —— 构建/校验/写 sinks。
//     `hostLogger` 只作为最后的回退提示通道（不接收每一条日志）。
//
// 纪律：不新增日志文件、不做轮转（那是 `log/file-sink.js` 的事）。

import {
  makeBootId,
  makeRecord,
  validateRecord,
  toLine,
  clipChars,
} from './schema.js';

/** 配置形态的键（出现任意一个、且不是宿主 logger 时，按新形态解释）。 */
const CONFIG_KEYS = ['side', 'bootId', 'module', 'sinks', 'hostLogger'];

/**
 * 这个值像不像"新形态配置"（而不是旧形态的宿主 logger 对象）。
 * 先认"像 logger"的形状（有 info/warn/error 函数）：宿主 logger 即使碰巧有 `module` 字段也不误判。
 */
function isConfigShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.info === 'function' || typeof value.warn === 'function' || typeof value.error === 'function') return false;
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  }
  return false;
}

/** sink 归一：函数或 `{ write(line, record) }`；其他形状忽略。 */
function normalizeSink(sink) {
  if (typeof sink === 'function') return { sink, disabled: false };
  if (sink && typeof sink === 'object' && typeof sink.write === 'function') return { sink, disabled: false };
  return null;
}

/**
 * 造一个日志器。
 * @param {object|Function|null} [options] 旧形态给宿主 logger；新形态给配置
 * @returns {{record:Function, event:Function, info:Function, warn:Function, error:Function}}
 */
export function createLogger(options) {
  const legacy = !isConfigShape(options);
  const config = legacy ? { legacy: true, hostLogger: options || null } : options;
  const side = config.side === 'client' ? 'client' : 'host';
  const bootId = typeof config.bootId === 'string' && config.bootId ? config.bootId : (side === 'host' ? makeBootId() : null);
  const moduleName = typeof config.module === 'string' && config.module ? config.module : null;
  const hostLogger = config.hostLogger && typeof config.hostLogger === 'object' ? config.hostLogger : null;
  const sinkStates = (Array.isArray(config.sinks) ? config.sinks : []).map(normalizeSink).filter(Boolean);

  // 日志器自身的状态（只增不减，防刷屏/防递归）
  const state = {
    invalidLogged: false,   // 每个 logger 最多一条 log.invalid
    fallbackNotified: false, // 回退提示最多一次
    legacyDisabled: false,  // 旧形态的宿主 logger 失败后禁用
  };

  /** 回退提示：控制台优先（日志通道坏了时它是最后一根可用的通道），最多一次。 */
  function notifyFallback(err) {
    if (state.fallbackNotified) return;
    state.fallbackNotified = true;
    const reason = String((err && err.message) || err);
    const text = '[milieu] 日志写不进去（该通道已禁用）：' + reason;
    try {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(text);
        return;
      }
    } catch {
      /* 控制台也没有：继续找宿主 logger */
    }
    try {
      if (hostLogger && typeof hostLogger.warn === 'function') hostLogger.warn(text);
    } catch {
      /* 回退提示也写不进去：只能放弃（不能抛） */
    }
  }

  /** 把一行交给所有可用 sink；某个 sink 抛错就禁用它（不抛、不刷屏）。 */
  function writeLine(line, record) {
    let written = 0;
    for (const target of sinkStates) {
      if (target.disabled) continue;
      try {
        if (typeof target.sink === 'function') target.sink(line, record);
        else target.sink.write(line, record);
        written += 1;
      } catch (err) {
        target.disabled = true;
        notifyFallback(err);
      }
    }
    return written;
  }

  /**
   * 非法记录：丢弃，并**最多**写一条 `log.invalid`（不递归、不再校验失败时静默）。
   * @param {string} reason
   */
  function dropInvalid(reason) {
    if (state.invalidLogged) return;
    state.invalidLogged = true;
    try {
      const invalidRecord = makeRecord({
        event: 'log.invalid',
        message: '一条日志结构非法，已丢弃：' + clipChars(reason, 200),
        side,
        bootId: bootId === null ? undefined : bootId,
        module: moduleName || undefined,
      });
      const checked = validateRecord(invalidRecord);
      const record = checked.ok ? checked.value : invalidRecord;
      writeLine(toLine(record), record);
    } catch {
      /* 连 log.invalid 都造不出来：只能丢弃（日志不能反噬主流程） */
    }
  }

  /**
   * 写一条记录（新形态）。
   * @param {object} input 事件与字段；logger 绑定的 side/bootId/module 作为默认（显式字段可覆盖）
   * @returns {{ok:true, record:object, line:string, written:number}|{ok:false, reason:string}}
   */
  function record(input) {
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const merged = { side };
    if (bootId !== null) merged.bootId = bootId;
    if (moduleName) merged.module = moduleName;
    for (const key of Object.keys(src)) {
      if (src[key] !== undefined) merged[key] = src[key];
    }
    let built;
    try {
      built = makeRecord(merged);
    } catch (err) {
      // makeRecord 设计上不抛；万一抛了也不向上抛
      const reason = '构建日志记录失败：' + String((err && err.message) || err);
      dropInvalid(reason);
      return { ok: false, reason };
    }
    const checked = validateRecord(built);
    if (!checked.ok) {
      dropInvalid(checked.reason);
      return { ok: false, reason: checked.reason };
    }
    const line = toLine(checked.value);
    const written = writeLine(line, checked.value);
    return { ok: true, record: checked.value, line, written };
  }

  /**
   * 写一条事件日志（新形态的常用入口）。
   * @param {string} event 已登记的事件名
   * @param {string} message 人话
   * @param {object} [fields] 其余字段（level / ok / code / data …）
   */
  function event(name, message, fields) {
    const extra = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
    return record({ ...extra, event: name, message });
  }

  /** 旧形态：把原文交给宿主 logger（行为与重构前一致；失败一次后禁用，不刷屏）。 */
  function writeLegacy(level, message) {
    if (state.legacyDisabled) return false;
    try {
      const logger = hostLogger && typeof hostLogger === 'object' ? hostLogger : null;
      const fn = logger && logger[level];
      if (typeof fn === 'function') {
        fn.call(logger, message);
        return true;
      }
    } catch (err) {
      state.legacyDisabled = true;
      notifyFallback(err);
    }
    return false;
  }

  /** `info/warn/error`：旧形态走原文；新形态走 `log.message` 事件。 */
  const levelMethod = (level) => (message) => {
    if (legacy) return writeLegacy(level, message);
    return record({ event: 'log.message', level, message: typeof message === 'string' ? message : String(message) });
  };

  return {
    record,
    event,
    info: levelMethod('info'),
    warn: levelMethod('warn'),
    error: levelMethod('error'),
  };
}
