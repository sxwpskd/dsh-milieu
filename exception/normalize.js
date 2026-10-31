// dsh-milieu —— 失败归一（纯模块：把任意 thrown 值 / 半成品结果变成统一失败结果）
//
// 统一形状（task-5）：
//   { ok:false, code, reason, blockedBy, cause? }
//     · `code`     —— 稳定错误码（见 `exception/codes.js`）；机器可判
//     · `reason`   —— 人话；**保留原 message**，不在这里改文案
//     · `blockedBy`—— 被工具/环境挡住的是什么（`host` / `fs` / 层名或服务能力名）
//     · `cause`    —— 原始 thrown 值（便于排查；序列化时通常为空，故可选）
//
// 三条规则：
//   ① **成功结果不动**（原对象返回，连身份都不变）；
//   ② **已经是失败结果** → 保留原字段、缺的补齐（不重写 reason）；
//   ③ 其余任何值（Error / 字符串 / 数字 / 对象 / undefined）→ 都归一成失败结果，**不抛**。
import { CODES, codeForLayer, isKnownCode } from './codes.js';

/** 是不是"统一结果"里的失败形状。 */
export function isFail(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && value.ok === false;
}

/** 是不是"统一结果"里的成功形状。 */
export function isOk(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && value.ok === true;
}

/**
 * 取任意输入里的"人话原因"；取不到返回 ''（由调用方兜底成"未知原因"）。
 * 与旧代码里的 `String((err && err.message) || err)` 等价——**文案来源不变**。
 * @param {unknown} input
 * @returns {string}
 */
export function reasonOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message || String(input);
  if (input && typeof input === 'object') {
    if (typeof input.reason === 'string' && input.reason) return input.reason;
    if (typeof input.message === 'string' && input.message) return input.message;
    return '';
  }
  if (input === undefined || input === null) return '';
  try {
    const text = String(input);
    return text === '[object Object]' ? '' : text;
  } catch {
    return '';
  }
}

/** 从错误对象上读"适配层附加的分类提示"（fs 适配层会挂 milieuCode / milieuBlockedBy）。 */
function hintOf(input) {
  if (!input || typeof input !== 'object') return {};
  return {
    code: input.milieuCode,
    blockedBy: input.milieuBlockedBy,
  };
}

/**
 * 归一任意失败输入。
 * @param {unknown} input thrown 值 / 失败结果 / 任意值
 * @param {{code?:string, blockedBy?:string, layer?:string, keepCause?:boolean}} [opts]
 *   · `code`      未指定具体码时的候选码（优先于层默认码）
 *   · `blockedBy` 未指定时补的"被谁挡住"
 *   · `layer`     层名（host / fs / config / protocol / session / state / ui / unknown），用其默认码
 *   · `keepCause` 是否保留 `cause`（默认 true；已是失败结果时不加）
 * @returns {{ok:false, code:string, reason:string, blockedBy:string|null, cause?:unknown}}
 */
export function normalizeError(input, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};

  // ① 成功结果不动
  if (isOk(input)) return input;

  // ② 已是失败结果：保留原字段，只补缺
  if (isFail(input)) {
    const out = { ...input };
    if (!out.reason) out.reason = '未知原因';
    else out.reason = String(out.reason);
    if (!out.code) out.code = options.code || codeForLayer(options.layer);
    if (out.blockedBy === undefined) out.blockedBy = options.blockedBy || null;
    return out;
  }

  // ③ thrown Error / 字符串 / 未知值
  const hint = hintOf(input);
  const hintCode = isKnownCode(hint.code) ? hint.code : null;
  const optionCode = isKnownCode(options.code) ? options.code : null;
  const reason = reasonOf(input) || '未知原因';
  const result = {
    ok: false,
    code: hintCode || optionCode || codeForLayer(options.layer),
    reason,
    blockedBy: (typeof hint.blockedBy === 'string' && hint.blockedBy) || options.blockedBy || null,
  };
  if (options.keepCause !== false) result.cause = input;
  return result;
}

/** 别名：`normalize` 与 `normalizeError` 是同一件事（按文件名更顺口）。 */
export const normalize = normalizeError;
