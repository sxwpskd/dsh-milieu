// dsh-milieu —— 界面半边入口：**只装配**（实现都在 `ui/`，本文件不做判断/渲染/请求）
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不需要自己装一份。
//
// **平台按 classic script 加载界面插件**（不是 ES 模块，2026-10-18 真机踩到
// `Cannot use import statement outside a module`）：发布的是 `lib/client.js` 构建产物，
// 由 `node tools/build-client.mjs` 从本文件 + `ui/*.js` + 它们依赖的纯模块拼接生成。
// 改界面源码后必须重新生成，否则跑的是旧代码。
//
// 责任边界（ARCHITECTURE.md 工作包 C）：入口只创建 `ui/plugin.js` 并交给模块加载器；
//   注册插槽、判据、渲染、读文件、发请求全在 `ui/`。
import { createClientPlugin, CLIENT_INJECT } from './ui/plugin.js';

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-milieu',
    factory(require) {
      const React = require('react');
      // 浏览器里 `ctx` 由加载器在 apply 时注入；这里先把工厂交出去。
      // 注意：`createClientPlugin` 需要 ctx，所以真正 apply 时再构造。
      return {
        inject: CLIENT_INJECT,
        apply(ctx) {
          // 工厂层只负责把 React 与 ctx 交给可测的那个构造器；
          // 注册、订阅、清理**全在构造器返回的 apply 里**（那份代码离线测过）。
          const plugin = createClientPlugin({ React, ctx });
          return plugin.apply(ctx);
        },
      };
    },
  });
}
