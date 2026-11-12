# 更新日志

## 0.1.1 — 2026-11-12

相对 0.1.0。

### 1. 重大改动

- **重构整个项目架构**：按 `adapter/`（宿主与文件系统）、`core/`（业务）、`model/`、`config/`、`exception/`、`log/`、`ui/` 等层重写文件组织；`index.js` / `client.js` 只做装配，业务判断下沉；一个 Loader 行 + 每个工作区一个独立 child fiber。
- **补充日志系统**：宿主写 `.dsh-milieu/milieu.log`（JSONL、有界轮转）；客户端增加内存日志、浏览器侧持久日志和配置页诊断入口；宿主与客户端错误都有统一报告路径。
- **补充错误处理器**：稳定错误码、统一失败结果、`guardSync` / `guardAsync`、UI 错误边界；主流程 fail-closed，状态页 / 卡片 / 配置页 fail-open。
- **适配层**：有 `adapter/dsh.js`（DSH 宿主接口）和 `adapter/fs.js`（文件系统）；**没有单独的 SDK 适配层**（本插件只对接 DSH 宿主，不另包一层 SDK）。
- **工作区改动长期监控**：`turn/end` 触发 + 低频定时兜底；无变化不写盘；同大小内容变化用 hash 检测；原始变更日志落 `.dsh-milieu/changes.jsonl`。
- **新增 `uninstall/` 卸载层**：运行时副作用台账 + `withdraw` 撤回，解决“插件卸载后工作区里还留着状态/日志/托管段”的问题；默认 dry-run、默认保留协议、`--all` 才撤协议。

### 2. 解决重大 bug

- **解决了 0.1.0 的预加载会话加载时机问题**：0.1.0 只在宿主启动时判断一次，且容易在服务未就绪时建会话；0.1.1 改为**挂载后的长期对账**——等 `agentLoop` 就绪，按 `turn/end` 去抖 + `preloadPollMs` 兜底检查；空白会话补读、用过的会话空闲 `preloadIdleMs` 后毕业并补建、受管表收敛为恰好一条，不再依赖下一次重启。
- 同时修复：配置判据变化后状态文件不更新（悬浮球与配置页不一致）、浮球/配置页的 React 组件渲染错误、工作区弹窗渲染错误、悬浮窗英文标签。

### 3. 新增功能

- **配置修改页**：插件管理页「dsh-milieu」行配置，支持 `preloadSession` / `autoState` / `criteria` 标量编辑、`form.mutate` 保存、工作区摘要与勾选管理。
- **配置查看悬浮球**：DSH 页面内的只读 ⚙ 浮球，显示生效 `criteria`、单位/人话换算和客户端诊断日志。
- **插件同时管理多个工作区**：通过 `workspaces[]` 配置，一个 Loader 行下为每个工作区建立独立实例，各管自己的状态、日志、预加载和会话。
- **卸载撤回（withdraw）**：先于卸载运行，按 `.dsh-milieu/side-effects.json` 撤插件留下的运行痕迹；`AGENTS.md` 只撤托管段，`STATE.md` 只撤材料段；协议三件默认保留，`--all` 才撤。用法：

```powershell
node <包目录>\uninstall\withdraw.mjs --root <工作区> --dry-run
node <包目录>\uninstall\withdraw.mjs --root <工作区> --apply
node <包目录>\uninstall\withdraw.mjs --root <工作区> --apply --all
```

详见 [uninstall/README.md](uninstall/README.md)。

### 4. 发布注意

- **重读机制由于测试问题，可能仍然存在问题**：本地测试和真机测试覆盖了主要路径，但阈值、会话结束基线、多会话交错等边界尚未完全验证；发布初期不要把“重读卡片”当成稳定契约。
- **正式验收仍未执行**：官方 `check` / `verify`、干净 profile 安装和跨机器验证尚未完成；本版先作为本地/GitHub 版本，不包含 npm 发布。
- `preloadSession` 发布默认仍为 **`false`**；`workspaceRoot` 默认留空，由平台工作区表解析。
- **卸载撤回必须发生在卸载插件之前**：卸载后包已删除，`withdraw.mjs` 不再可执行。
- **宿主 profile 的配置行和 `node_modules` junction 不归卸载层管**：这是 DSH 插件管理器的卸载残留，插件代码在卸载后已不存在；需要时由宿主/用户清理。
