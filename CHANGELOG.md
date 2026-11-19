# 更新日志

## 0.1.2 — 2026-11-19

### 重大改动

- 预加载会话的“空白 / 是否已被人使用”检测改用平台 `sessionController.events`：DSH 0.2.2 没有 `inspect`，旧检测恒为“查不到”。同时用 `session/list` 的 `blank` 兜底，失败原因写进 `preload.json`。
- 置顶按会话所属工作区生效，不改变其他工作区的排序。

### 解决重大 bug

- **“没有预加载会话”**：使用过的会话一直被当成 `role: preload`，既不毕业也不新建。现在按人类消息来源计数，使用后毕业并新建。
- 使用后立即解除预加载置顶；没置顶时平台 `unpin` 是 no-op，不干预。
- 空白预加载会话认领后会补读一次；补读失败照实报错。

### 新增功能

- 配置页分组：预加载 / 预加载门槛（认知库） / 工作区监控 / 重读判据 / 状态与客户端。
- `preloadAgentPreset`：新建预加载会话的模式（跟随平台默认 / 标准 / 创造）；已有预加载不改模式。
- `preloadPin`：新建预加载会话置顶（默认开，可关）；只影响新建的预加载。

### 发布注意

- 从 **0.1.1** 升到 **0.1.2**。本次只合并 Git `main` + tag，**npm 未发布**。
- 宿主侧改动需完全重启 DSH 才会全部生效；已有预加载保持原模式，新建的才用新模式/置顶。
- 本机 `readiness.minFiles` 是运行配置覆盖（5）；源码默认仍是 10，别的机器需按认知库实际大小调整。

## 0.1.2-dev.3 — 未发布

- **修复预加载会话"消失"**：DSH 0.2.2 的 `sessionController` 没有 `inspect`（只有 `events`），旧检测恒为"查不到"，把已被人使用的会话继续当成预加载，于是不再新建。
- 改用平台 `sessionController.events` 读最近 100 条事件，按 `data.source.kind === 'user'` 数人类消息；空白会话补读，使用后毕业。
- 拿不到事件时用 `session/list` 的 `blank` 兜底；仍失败把原因写进 `preload.json`（`inspectError`），不再静默当成干净。

## 0.1.2-dev.2 — 未发布

- **预加载会话置顶**：新增 `preloadPin`（默认开）；新建预加载后调用 `workspaceRegistry.pinSession`，在**该会话所属工作区**内置顶。
- **使用后自动解除置顶**：检测到预加载会话被人使用（人类消息 >1）时调用 `unpinSession`；平台没置顶时是 no-op，不影响毕业/新建。
- 配置页「预加载」组增加 `preloadPin` 开关；pin/unpin 失败只记诊断，不让预加载失败。

## 0.1.2-dev.1 — 未发布

- **预加载会话模式可选**：新增 `preloadAgentPreset`，可选 `standard`（标准模式）/ `cordis`（创造模式）；空 = 跟随平台默认。只影响新建的预加载会话，已有会话保持原模式。
- 配置页「预加载」组增加模式选择；`preloadAgentPreset` 是 volatile，保存后生效。

## 0.1.2-dev.0 — 未发布

- 配置页字段分组：`readiness.*` 从“重读判据”移到“预加载门槛（认知库）”；`agentLoopWaitMs` 归“预加载”；`fingerprint.*` / `eventKeep*` / `clientMemoryLimit` / `pollMs` / `readTimeoutMs` / `debug` 归“状态与客户端”。
- 这是 **dev 分支**的改动，未发布；0.1.1 仍是稳定版。

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

- **正式验收已完成**：2026-11-12 在 DSH desktop profile 从 GitHub 安装 **0.1.1**，重启后插件正常加载；安装/运行/默认配置路径已通过。
- **重读机制**已完成基本真机验收；复杂多会话交错、极端时间边界仍建议持续观察，不建议把未验证的边缘行为当成稳定契约。
- **npm 发布**：本版同步发布 `0.1.1`；从 npm 安装的用户由插件市场按 npm latest 检查更新。
- `preloadSession` 发布默认仍为 **`false`**；`workspaceRoot` 默认留空，由平台工作区表解析。
- **卸载撤回必须发生在卸载插件之前**：卸载后包已删除，`withdraw.mjs` 不再可执行。
- **宿主 profile 的配置行和 `node_modules` junction 不归卸载层管**：这是 DSH 插件管理器的卸载残留，插件代码在卸载后已不存在；需要时由宿主/用户清理。
