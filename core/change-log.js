// dsh-milieu —— **原始变更日志**（append-only JSONL；机器数据，不是状态文件的一部分）
//
// 为什么需要它（2026-11-02）：状态文件里的 `events` 是**有界投影**（最近 30 天 ∪ 最近 500 条，
//   更早的只留 archived 计数）——它服务"要不要重读"的判断，本来就不该无限长。
//   工作区监控要看"到底发生过哪些变化"，所以另有一份**只追加、不重写、不截断**的日志：
//   `.dsh-milieu/changes.jsonl`。
//
// 边界（ARCHITECTURE.md §4.2）：
//   · 本层只拼行、只写文件，读写走参数传入的 `fs` 能力（**不 import 'node:fs'**）；
//   · **失败只报告、不抛**：它不在主流程的关键路径上（状态文件写成功才算这一轮成立），
//     调用方拿到 `{ok:false, reason, code, blockedBy}` 后照常往下走；
//   · 它是**机制自己的产物**：`changes.js` 的 `isSelfArtifact` 认这个路径，
//     否则"每写一行日志 → 下一轮多一个新增"就成了自喂环。
//
// 行形状（一行一个事件；JSONL 的纪律是**一行必须是完整 JSON**，读方按行 parse）：
//   {"v":1,"at":<写日志时刻 ms>,"time":<事件自己的时间 ms>,"path":"review/a.md",
//    "kind":"created","before":null,"after":1024,"delta":1024}
//   · `time` 是**事件自己的时间**（`changes.js` 的 makeEvent 取文件 mtime）；
//   · `at` 是**什么时候记下来的**——两者不是一回事（扫描可能晚于文件修改）。
//   · `v` 是行格式版本：将来加字段/改语义就升它，读方按 v 分支。
import { dirname, join } from 'node:path';
import { normalizeError } from '../exception/normalize.js';
import { CODES } from '../exception/codes.js';

/** 原始日志相对工作区根的位置（**唯一**知道这个路径的地方）。 */
export const RAW_LOG_REL = '.dsh-milieu/changes.jsonl';

/** 行格式版本（见文件头；加字段/改语义才升）。 */
export const RAW_LOG_VERSION = 1;

/**
 * 事件 → 一行记录。**只取白名单字段**：事件里多出来的东西（例如上游的调试字段）
 * 不带到长期历史里——历史一旦写出去就收不回来，格式越窄越稳。
 */
function toLine(event, at) {
  return {
    v: RAW_LOG_VERSION,
    at,
    time: event.time === undefined ? null : event.time,
    path: String(event.path || ''),
    kind: event.kind || null,
    before: event.before === undefined ? null : event.before,
    after: event.after === undefined ? null : event.after,
    delta: event.delta === undefined ? null : event.delta,
  };
}

/**
 * 把这一轮的**新事件**追加进原始日志（append-only；不重写、不截断、不轮转）。
 *
 * @param {object} o
 *   · root   工作区根（必需；路径从这里解析，不写死本机路径）
 *   · events 本轮新事件（调用方传 `generateState` 的 `freshEvents`）
 *   · fs     文件系统能力（必需；本层不 import 'node:fs'）
 *   · now    写日志时刻（毫秒；默认 Date.now()）
 * @returns {{ok:true, appended:number}|{ok:false, reason:string, code:string, blockedBy:string|null}}
 *   **永不 throw / 永不 reject**。
 */
export function appendChanges({ root, events, fs, now } = {}) {
  if (!root) {
    return { ok: false, reason: '没有工作区根，记不了原始变更日志', code: CODES.CONFIG_INVALID, blockedBy: 'config' };
  }
  if (!fs || typeof fs.appendText !== 'function' || typeof fs.mkdirp !== 'function') {
    return { ok: false, reason: '没有文件系统能力（fs），记不了原始变更日志', code: CODES.FS_UNAVAILABLE, blockedBy: 'fs' };
  }
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  // 只记"像事件"的行：没有 path 的东西写进历史就是永久噪声，而历史不能回滚重写。
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e === 'object' && typeof e.path === 'string' && e.path);
  // 没有新事件就不产生空文件，也不白建目录（首轮/稳定态每轮都调它，不能每轮碰盘）。
  if (list.length === 0) return { ok: true, appended: 0 };
  try {
    const abs = join(root, RAW_LOG_REL);
    fs.mkdirp(dirname(abs));
    fs.appendText(abs, list.map((e) => JSON.stringify(toLine(e, at)) + '\n').join(''));
    return { ok: true, appended: list.length };
  } catch (err) {
    // 写入边界：异常归一成带稳定错误码的失败结果；**reason 带上原 message**，不吞错、不抛。
    const failure = normalizeError(err, { code: CODES.STATE_WRITE_FAILED, blockedBy: 'fs' });
    return {
      ok: false,
      reason: '原始变更日志写入失败：' + failure.reason,
      code: failure.code,
      blockedBy: failure.blockedBy,
    };
  }
}
