#!/usr/bin/env node
// dsh-milieu —— 卸载前撤回（**要先于卸载插件运行**；卸载后包没了，跑不了）。
//
// 用法：
//   node <包目录>/uninstall/withdraw.mjs --root <工作区> --dry-run
//   node <包目录>/uninstall/withdraw.mjs --root <工作区> --apply
//   node <包目录>/uninstall/withdraw.mjs --root <工作区> --apply --all
//
// 默认 dry-run；--apply 才真改盘；--all 才把协议文件一起撤（默认保留协议）。
import { resolve } from 'node:path';
import { createFs } from '../adapter/fs.js';
import { createLedger } from './ledger.js';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const rootArg = argValue('--root');
if (!rootArg) {
  console.error('用法：node uninstall/withdraw.mjs --root <工作区> [--apply] [--all]');
  process.exit(2);
}
const root = resolve(rootArg);
const apply = process.argv.includes('--apply') || process.argv.includes('--yes');
const all = process.argv.includes('--all');
const dryRun = !apply;

const fs = createFs();
const ledger = createLedger({ root, fs, plugin: 'dsh-milieu' });
if (!ledger.existed) {
  console.log('[milieu] 没有副作用台账：' + ledger.path);
  console.log('没有需要撤回的遗留（或者台账已经被撤过）。');
  process.exit(0);
}

console.log('[milieu] 工作区：' + root);
console.log('[milieu] 台账：' + ledger.path);
console.log('[milieu] 模式：' + (dryRun ? 'dry-run（只报告）' : 'apply（会改盘）') + (all ? ' + 协议一起撤' : ''));
const result = ledger.withdraw({ dryRun, all });
for (const a of result.actions) {
  const mark = a.ok === false ? '跳过' : '计划/完成';
  console.log('  [' + mark + '] ' + a.action + '  ' + a.path + (a.reason ? '  —— ' + a.reason : ''));
}
console.log('[milieu] ' + result.reason);
if (!dryRun && !result.ok) {
  console.error('[milieu] 有未完成的撤回项；台账保留，修好后可重跑。');
  process.exit(1);
}
