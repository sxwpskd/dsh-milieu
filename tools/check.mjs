#!/usr/bin/env node
// 边界检查：宿主名词 / 本机路径不许出现在 adapter/（以及 tests/、tools/、lib/）之外。
//
// 为什么把 tools/ 也排除：本文件自己就带着"禁词清单"（FORBIDDEN 里的字符串），
//   扫自己必然命中；tools/ 里的开发脚本不进发布包，允许出现假宿主（ARCHITECTURE.md §4.1）。
//
// 用法：node tools/check.mjs [目录]    （默认检查本包根）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 本文件在 <包根>/tools/check.mjs → 默认检查 <包根>。
const ROOT = process.argv[2] ? resolve(process.argv[2]) : join(HERE, '..');
const SKIP = new Set(['adapter', 'tests', 'tools', 'lib', 'node_modules', '.git']);
const FORBIDDEN = [
  ['sessionController', '宿主服务名（只许出现在 adapter/）'],
  ['workspaceRegistry', '宿主服务名（只许出现在 adapter/）'],
  ['ctx.get(', '真机上取不到服务（用 inject 回调里的 ctx 属性）'],
  ['D:\\DSH', '本机路径不许进插件'],
  ['D:/DSH', '本机路径不许进插件'],
];

const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) { walk(path); continue; }
    if (!['.js', '.mjs', '.cjs'].includes(extname(name))) continue;
    const text = readFileSync(path, 'utf8');
    const rel = path.slice(ROOT.length + 1).replace(/\\/g, '/');
    for (const [needle, why] of FORBIDDEN) {
      if (text.includes(needle)) hits.push({ file: rel, needle, why });
    }
  }
}

walk(ROOT);

if (hits.length) {
  console.error('边界检查失败：');
  for (const hit of hits) console.error('  ' + hit.file + ' —— `' + hit.needle + '`：' + hit.why);
  process.exit(1);
}
console.log('边界检查通过：宿主名词 / 本机路径只出现在 adapter/（tests/、tools/、lib/ 除外）。');
