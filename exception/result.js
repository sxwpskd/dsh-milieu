// dsh-milieu —— 统一结果（纯模块：只定"成功/失败"的形状与报告，不放业务判断）
//
// 为什么要有它：失败路径散在各处时，每处都自己拼 `{ ok:false, reason }`，
//   于是有的说清了原因、有的没说。这里把**形状**固定成一处：
//     · 成功：`{ ok:true, value }`
//     · 失败：`{ ok:false, reason, blockedBy, code? }`
//   `reason` 说清发生了什么；`blockedBy` 说清被**工具或环境**挡住什么，不落在"我没做"上。
//
// **渐进使用**（ARCHITECTURE.md 10.1-6）：新边界代码用 `ok` / `fail`；旧返回值不要求一次改完。

/** 成功结果。 */
export function ok(value) {
  return { ok: true, value };
}

/**
 * 失败结果。
 * @param {string} reason 发生了什么（主语落在工具或环境上）
 * @param {string} [blockedBy] 被谁挡住（工具名 / 能力名）
 * @param {string} [code] 可选错误码（旧返回值需要区分时用）
 */
export function fail(reason, blockedBy = null, code = null) {
  const r = {
    ok: false,
    reason: String(reason || '未知原因'),
    blockedBy: blockedBy ? String(blockedBy) : null,
  };
  if (code) r.code = String(code);
  return r;
}

/**
 * 把结果报给日志：成功记 info，失败记 warn（失败说清原因与挡住它的东西）。
 * **有 log 才报**；返回原结果，便于链式调用。
 * @param {{ok:boolean, reason?:string, blockedBy?:string}} result
 * @param {{info?:Function, warn?:Function}} [log]
 */
export function report(result, log) {
  const r = result && typeof result === 'object' ? result : fail('没有结果可报告');
  const level = r.ok ? 'info' : 'warn';
  const text = r.ok
    ? '[milieu] ' + (r.reason || '完成')
    : '[milieu] ' + (r.reason || '未知原因') + (r.blockedBy ? '（挡住它的是：' + r.blockedBy + '）' : '');
  if (log && typeof log[level] === 'function') {
    try { log[level](text); } catch { /* 日志失败不吞调用方 */ }
  }
  return r;
}
