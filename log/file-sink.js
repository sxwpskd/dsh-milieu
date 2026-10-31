// dsh-milieu —— **宿主文件 sink**（日志落盘：`.dsh-milieu/milieu.log`，JSONL 追加 + 有界轮转）
//
// 依据 `plugin/dsh-milieu/LOG-SCHEMA.md` v2 §6.1：
//   · 文件：`<root>/.dsh-milieu/milieu.log`，一行一个 JSON 对象，UTF-8 追加；
//   · **写前检查大小**：当前大小 + 本行（含换行）> 1 MiB → 先轮转；
//     `.log` → `.log.1`，`.log.1` → `.log.2`，**只保留最近 2 份**；
//   · **Windows 不能把文件改名为已存在的名字**：先删目标，再改名；
//   · **不长期打开文件句柄**：每次 `appendText` 自己开关（崩溃时不丢内存缓冲，也不会碰到"文件被占用"）；
//   · **写/轮转失败：报告一次，然后禁用这个 sink**——不崩、不刷屏（日志不能反噬主流程）。
//
// 分层：本文件**不 import 'node:fs'**，读写全走参数传入的 `fs` 能力（`adapter/fs.js`）；
//   也不做"要不要写日志"的判断——那是 `log/logger.js` 的事。这里只回答"怎么安全地写一行"。

import { join } from 'node:path';
import { byteLengthOf } from './schema.js';

/** 日志目录（工作区根下）。与协议文件同目录；见 LOG-SCHEMA §6.1。 */
export const LOG_DIR_NAME = '.dsh-milieu';

/** 日志文件名。轮转文件是它加 `.1` / `.2`。 */
export const LOG_FILE_NAME = 'milieu.log';

/** 日志文件相对工作区根的路径（状态账排除用；`core/changes.js` 里也按这个契约排除）。 */
export const LOG_REL_PATH = LOG_DIR_NAME + '/' + LOG_FILE_NAME;

/** 触发轮转的大小（1 MiB；LOG-SCHEMA §6.1）。 */
export const DEFAULT_MAX_BYTES = 1024 * 1024;

/** 保留几份轮转备份（`.1` / `.2`）。 */
export const DEFAULT_KEEP = 2;

/** 默认失败报告：宿主 logger 不在时最后还是要说一句（只一次）。 */
function defaultReport(reason) {
  try {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[milieu] 日志文件写不进去（已停用文件日志）：' + reason);
    }
  } catch { /* 控制台也没有就算了 */ }
}

/**
 * 造一个文件 sink（形状满足 `log/logger.js` 的 sink 契约：`{ write(line, record) }`）。
 *
 * **永不抛**：任何读写异常都在内部收掉 → 报告一次 → `disabled()` 变 true → 之后 `write` 直接返回 false。
 *
 * @param {object} o
 *   · fs       文件系统能力（必需：`exists/readText/mkdirp/size/appendText/remove/rename`）
 *   · root     工作区根（必需；根确定之后才挂这个 sink —— 见 `core/boot.js`）
 *   · maxBytes 轮转阈值（默认 1 MiB；测试可调小）
 *   · keep     保留备份数（默认 2）
 *   · report   `(reason) => void`：第一次失败时报告（默认 console.warn）
 * @returns {{write:Function, path:string, disabled:Function, reason:Function, maxBytes:number, keep:number}}
 */
export function createFileSink({ fs, root, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, report = null } = {}) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
  const backups = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : DEFAULT_KEEP;
  const notify = typeof report === 'function' ? report : defaultReport;
  const sinkPath = root ? join(String(root), LOG_DIR_NAME, LOG_FILE_NAME) : null;
  const dirPath = root ? join(String(root), LOG_DIR_NAME) : null;
  // 能力不全（入口一定会给全；这里防测试/误用）：直接当"不可用"，**不报错不刷屏**。
  const missing = !sinkPath || !fs
    || typeof fs.exists !== 'function' || typeof fs.mkdirp !== 'function'
    || typeof fs.size !== 'function' || typeof fs.appendText !== 'function'
    || typeof fs.remove !== 'function' || typeof fs.rename !== 'function';

  let disabled = missing;
  let reported = missing;
  let lastReason = missing ? '缺少文件系统能力或工作区根（文件日志不可用）' : null;

  /** 失败只报一次，然后禁用（不刷屏；日志通道坏了不能反过来影响主流程）。 */
  function fail(reason) {
    lastReason = String(reason || '未知原因');
    if (disabled) return false;
    disabled = true;
    if (!reported) {
      reported = true;
      try { notify(lastReason); } catch { /* 报告口自己坏了：只能放弃 */ }
    }
    return false;
  }

  /**
   * 轮转：`.log` → `.1` → `.2`（保留 `backups` 份）。
   * **从最后一份往前处理**：先把 `.1` 挪到 `.2`，最后才把 `.log` 挪到 `.1`。
   * **先删目标再改名**（Windows 上改名到已存在名字会失败）。
   */
  function rotate() {
    for (let i = backups; i >= 1; i--) {
      const target = i === 1 ? sinkPath + '.1' : sinkPath + '.' + i;
      const source = i === 1 ? sinkPath : sinkPath + '.' + (i - 1);
      if (fs.exists(target)) fs.remove(target);
      if (fs.exists(source)) fs.rename(source, target);
    }
  }

  /** 写一整行（不带换行也行——这里补 `\n`；`line` 必须已经序列化好）。 */
  function write(line) {
    if (disabled || !sinkPath) return false;
    if (typeof line !== 'string' || !line) return false;
    try {
      // 先建目录：首次启动时 `.dsh-milieu/` 可能还不存在（协议同步通常会建，但不能依赖顺序）。
      fs.mkdirp(dirPath);
      const bytes = byteLengthOf(line) + 1; // + '\n'
      // **写前检查大小**：先看现在多大，再决定要不要先轮转。
      let current = 0;
      if (fs.exists(sinkPath)) current = fs.size(sinkPath);
      if (current + bytes > limit) rotate();
      fs.appendText(sinkPath, line + '\n');
      return true;
    } catch (err) {
      return fail(String((err && err.message) || err));
    }
  }

  return {
    path: sinkPath,
    dir: dirPath,
    maxBytes: limit,
    keep: backups,
    write,
    disabled: () => disabled,
    reason: () => lastReason,
  };
}

/**
 * **延迟挂载的 sink**（入口先造 logger、根确定后才挂文件 sink 时用）。
 *
 * 为什么需要：`createLogger` 在创建时固定 sink 列表（task-6），而工作区根要到 `core/boot.js`
 * 问过平台才知道。于是入口先放一个"代理 sink"进 logger，等根确定再 `attach` 真实文件 sink。
 * 未挂载时 `write` 返回 false（不报错——启动早期本来就没有文件可写）。
 */
export function createDeferredSink() {
  let target = null;
  return {
    /** sink 契约：挂载前什么都不写（返回 false）。 */
    write(line, record) {
      if (!target) return false;
      try {
        return target.write(line, record);
      } catch {
        return false; // 真实 sink 自己承诺不抛；这里再兜一层，绝不让日志反噬
      }
    },
    /** 挂上真实 sink（可以重复挂；每次覆盖）。 */
    attach(realSink) {
      target = realSink && typeof realSink.write === 'function' ? realSink : null;
      return target;
    },
    /** 挂上了没有（测试/诊断用）。 */
    attached() {
      return !!target;
    },
    /** 当前真实 sink（测试/诊断用；可能为 null）。 */
    target() {
      return target;
    },
  };
}
