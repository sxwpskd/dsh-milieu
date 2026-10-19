#!/usr/bin/env node
// plugin-dryrun —— 喂一个假 ctx，干跑 `./index.js` 的宿主半边
//
// 它住在**包内**（`plugin/`），因为宿主在真机上要干跑的就是这个包里的 `index.js`；
// 而"能导入 ≠ 能用"这条判据要求：**只有观察到的能力才算成功**。
// 工作区里那份 `tools/plugin-dryrun.mjs` 会转调它（开发时的工作台）。
//
// 用法：node plugin/plugin-dryrun.mjs [工作区根]
import { apply, DEFAULT_CONFIG } from './index.js';

const root = process.argv[2] || process.cwd();
const events = [];
const sections = [];
let captured = null;
let disposed = 0;

// 仿官方 `ctx.effect(callback, label?) => () => void`：它自己交还一个 disposer
const fakeCtx = {
  logger: {
    info: (...a) => events.push(['info', a.map(String).join(' ')]),
    warn: (...a) => events.push(['warn', a.map(String).join(' ')]),
  },
  effect(fn) {
    const ret = fn();
    return () => { disposed++; if (typeof ret === 'function') ret(); };
  },
  systemPrompt: {
    getSectionOrder: (name) => (name === 'MILIEU_WORKSPACE_STATE' ? 4242 : undefined),
    section(spec) { sections.push(spec); captured = spec; return () => { disposed++; }; },
  },
};

const cfg = { ...DEFAULT_CONFIG, workspaceRoot: root };
const dispose = apply(fakeCtx, cfg);

console.log('== 1. apply 有没有炸 ==');
console.log('   没炸（执行到底）');

console.log('\n== 2. 它注册了什么 ==');
console.log('   注册的 section 共 ' + sections.length + ' 个：' + sections.map((s) => s.name).join(' , '));
console.log('   最后捕获的 name  = ' + (captured && captured.name));
console.log('   order            = ' + (captured && captured.order) + '（getSectionOrder 给了 4242）');

console.log('\n== 3. text() 真的读到了那一页吗 ==');
const out = captured ? captured.text() : '';
console.log('   返回长度 = ' + out.length + ' 字节');
console.log('   含 system-reminder 包裹: ' + out.includes('<system-reminder>'));
console.log('   含工作区根路径: ' + out.includes(root));

console.log('\n== 4. 第二次调用会不会因为"内容没变"而跳过 ==');
console.log('   第二次返回长度 = ' + (captured ? captured.text().length : 0) + '（0 = 正确跳过）');

console.log('\n== 5. 拆解 ==');
if (typeof dispose === 'function') dispose();
console.log('   section 的 disposer 被调用次数 = ' + disposed);

console.log('\n== 6. 日志（apply 自己报的处境）==');
for (const [lvl, msg] of events) console.log('   [' + lvl + '] ' + msg);

console.log('\n结论：能导入 ≠ 能用。第 2–4 项才是"注册上了、读到了、不重发"的证据。');
