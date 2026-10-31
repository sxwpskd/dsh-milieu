// dsh-milieu —— 指纹（纯工具：不读文件、不访问宿主、不改全局状态）
//
// 只负责"把一段内容算成一个短串"。**读文件是调用方的事**——这里不 import 'node:fs'。
import { createHash } from 'node:crypto';

/** 文本指纹：sha256 前 12 位（与清单同一算法；判定"内容变没变"用这个）。 */
export function fpOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** 字节指纹：md5 前 12 位（文件"变没变"用；md5 够，清单那份 sha256 是给它自己用的）。 */
export function fpBytes(data) {
  return createHash('md5').update(data).digest('hex').slice(0, 12);
}
