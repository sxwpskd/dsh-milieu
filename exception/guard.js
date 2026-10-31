// dsh-milieu —— 异常边界（纯模块：包住一次同步/异步调用，绝不把异常抛给宿主/界面）
//
// 为什么要有它（task-5）：每个文件各写一个 try/catch，等于每个文件各自决定
//   "报不报、报成什么级、返回什么形状"。这里把边界收成两个函数：
//     · `guardSync(label, fn, opts)`  —— 同步边界
//     · `guardAsync(label, fn, opts)` —— 异步边界（Promise 拒绝也接住）
//
// 契约：
//   · 成功：**返回 fn 的原值**（不包 `{ok:true}`——调用方拿到的还是原来那个东西）；
//   · 失败：`normalize` 成统一失败结果返回，**同时报告一次**，**不 rethrow**；
//   · **不装 process 级处理器**（uncaughtException / unhandledRejection）：插件不能替宿主
//     决定进程策略；只包自己的 timer / Promise / effect / slot 渲染这些边界。
//
// opts：
//   · `optional`  —— 可选装饰（状态页注入、诊断、卡片）：失败只记 info（有 debug 记 debug），
//                    不当作错误；默认 false（主流程，失败记 warn）。
//   · `log`       —— 报告口。可以是 `{info,warn,debug}` 对象，也可以是 `(level, message) => void`
//                    函数（界面层的 logger 是后者）。
//   · `code` / `blockedBy` / `layer` —— 交给 `normalize` 的默认分类。
import { normalizeError } from './normalize.js';
import { CODES } from './codes.js';

/** 归一 opts（坏输入当没有）。 */
function optionsOf(opts) {
  const raw = opts && typeof opts === 'object' ? opts : {};
  return {
    optional: raw.optional === true,
    log: raw.log || null,
    code: raw.code || null,
    blockedBy: raw.blockedBy || null,
    layer: raw.layer || null,
  };
}

/**
 * 把一条报告写到日志口。**日志自己坏了也不能反过来抛**（那是边界里的边界）。
 * @returns {boolean} 有没有真的写出去
 */
function emit(log, level, message) {
  if (!log) return false;
  try {
    if (typeof log === 'function') {
      log(level, message);
      return true;
    }
    const fn = typeof log[level] === 'function'
      ? log[level]
      : (level === 'info' && typeof log.debug === 'function' ? log.debug : null);
    if (typeof fn === 'function') {
      fn.call(log, message);
      return true;
    }
  } catch {
    /* 日志口自己坏了：边界不能再抛第二次 */
  }
  return false;
}

/** 失败报告文案（一次，含 label 与分类；不含层前缀，由 log 口自己带）。 */
function reportFailure(result, label, options) {
  const level = options.optional ? 'info' : 'warn';
  const head = options.optional ? '可选步骤失败（已跳过）' : '失败';
  const where = label ? '：' + label : '';
  const blocked = result.blockedBy ? '（被 ' + result.blockedBy + ' 挡住）' : '';
  emit(options.log, level, head + where + ' —— ' + result.reason + blocked);
}

/**
 * 同步边界：执行 `fn`，捕获任何 thrown 值。
 * @template T
 * @param {string} label 这次边界叫什么（进报告；便于定位）
 * @param {() => T} fn 被包住的调用
 * @param {object} [opts] 见文件头
 * @returns {T | {ok:false, code:string, reason:string, blockedBy:string|null, cause?:unknown}}
 */
export function guardSync(label, fn, opts = {}) {
  const options = optionsOf(opts);
  try {
    return fn();
  } catch (err) {
    const failure = normalizeError(err, {
      code: options.code,
      blockedBy: options.blockedBy,
      layer: options.layer,
    });
    reportFailure(failure, label, options);
    return failure;
  }
}

/**
 * 异步边界：执行 `fn` 并等它；同步 throw 与 Promise 拒绝都接住。
 * 返回的 Promise **永远 resolve**（失败时 resolve 成失败结果），不会 reject 到宿主/界面。
 * @template T
 * @param {string} label
 * @param {() => T | Promise<T>} fn
 * @param {object} [opts]
 * @returns {Promise<T | {ok:false, code:string, reason:string, blockedBy:string|null, cause?:unknown}>}
 */
export async function guardAsync(label, fn, opts = {}) {
  const options = optionsOf(opts);
  try {
    return await fn();
  } catch (err) {
    const failure = normalizeError(err, {
      code: options.code,
      blockedBy: options.blockedBy,
      layer: options.layer,
    });
    reportFailure(failure, label, options);
    return failure;
  }
}

/** 兜底结果：给"边界连失败结果都构造不出来"的极端情况用（目前只在测试里用到）。 */
export function guardFallback(reason = '未知原因') {
  return { ok: false, code: CODES.UNKNOWN, reason: String(reason || '未知原因'), blockedBy: null };
}
