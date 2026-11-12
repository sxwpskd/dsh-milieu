// dsh-milieu —— 文件系统适配层（**只翻译**：不决定扫描哪些目录、不决定写什么内容）
//
// 规则（ARCHITECTURE.md §4.1）：
//   · 这里只把 `node:fs` 的同步接口翻成**能力对象**，交给 `core/` 用参数接收；
//   · `core/` 不许 import 'node:fs'（边界检查会看），所以读、写、存在、建目录、列目录、stat 全在这里；
//   · 本层不做判断：扫描范围在 `core/state-generator.js`，写什么在 `core/protocol.js` 等；
//   · 错误**原样抛出**（与 `node:fs` 一致），由调用方包成 reason——翻译层不吞错。
//
// 异常边界（task-5）：抛出前给错误挂两个**分类提示**（不改 message、不吞错）：
//   · `milieuCode`      —— 稳定错误码（`exception/codes.js`），供 `exception/normalize.js` 取用；
//   · `milieuBlockedBy` —— 固定 `'fs'`。
//   这样上游 `normalizeError(err)` 能拿到分类，而 `String(err.message)` 的文案一字不变。
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  readdirSync, statSync, rmSync, renameSync, rmdirSync,
} from 'node:fs';
import { CODES } from '../exception/codes.js';

/**
 * 给 thrown 值挂分类提示（原样返回同一个错误对象；只读/冻结对象退化成新 Error）。
 * @param {unknown} err
 * @param {string} code
 */
function withFsHint(err, code) {
  try {
    if (err && typeof err === 'object') {
      if (!err.milieuCode) err.milieuCode = code;
      if (!err.milieuBlockedBy) err.milieuBlockedBy = 'fs';
      return err;
    }
  } catch {
    /* 错误对象坏了：退回新 Error */
  }
  const wrapped = new Error(typeof err === 'string' ? err : String(err));
  wrapped.milieuCode = code;
  wrapped.milieuBlockedBy = 'fs';
  wrapped.cause = err;
  return wrapped;
}

/** 把一个 `node:fs` 调用包成"抛错带分类提示"的版本。 */
function call(fn, code) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      throw withFsHint(err, code);
    }
  };
}

/**
 * 造一份文件系统能力对象。
 *
 * 形状是一份"能力清单"（ARCHITECTURE.md §4.2 的能力对象）：入口建一次、传给 `core/boot.js`，
 * 再逐层传给需要的核心模块。测试可以拿同一个对象（或覆盖其中一两个方法做失败注入）。
 */
export function createFs() {
  return {
    /** 读文本（utf8）。读不到 → 抛。 */
    readText: call((path) => readFileSync(path, 'utf8'), CODES.FS_READ_FAILED),
    /** 读字节（算指纹用）。读不到 → 抛。 */
    readBytes: call((path) => readFileSync(path), CODES.FS_READ_FAILED),
    /** 写文本（utf8）。父目录不在 → 抛（调用方先 mkdirp）。 */
    writeText: call((path, text) => writeFileSync(path, text, 'utf8'), CODES.FS_WRITE_FAILED),
    /** 存在吗。 */
    exists: call((path) => existsSync(path), CODES.FS_READ_FAILED),
    /** 递归建目录（已存在不算错）。 */
    mkdirp: call((path) => mkdirSync(path, { recursive: true }), CODES.FS_WRITE_FAILED),
    /** 列目录（带 dirent，区分文件/目录）。读不到 → 抛。 */
    readDir: call((path) => readdirSync(path, { withFileTypes: true }), CODES.FS_READ_FAILED),
    /** stat（大小 / mtime）。读不到 → 抛。 */
    stat: call((path) => statSync(path), CODES.FS_READ_FAILED),
    /** 追加文本（utf8）。**每次调用自己开/关句柄**（不长期持有）——日志 sink 依赖这条。 */
    appendText: call((path, text) => appendFileSync(path, text, 'utf8'), CODES.FS_WRITE_FAILED),
    /** 文件大小（字节）。读不到 → 抛。 */
    size: call((path) => statSync(path).size, CODES.FS_READ_FAILED),
    /** 删除文件（不存在不算错：`force:true`；目录不在此列——目录删除是别的责任）。 */
    remove: call((path) => rmSync(path, { force: true }), CODES.FS_WRITE_FAILED),
    /** 删除**空目录**（非空会抛；卸载撤回用，调用方自己判断空）。 */
    removeDir: call((path) => rmdirSync(path), CODES.FS_WRITE_FAILED),
    /** 改名（Windows 上目标已存在会失败——调用方负责先删目标）。 */
    rename: call((from, to) => renameSync(from, to), CODES.FS_WRITE_FAILED),
  };
}
