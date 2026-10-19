# dsh-milieu（工作区环境插件）

> **一句话**：把「环境 = 信息 + 工具」落成一个可安装的 DSH 插件——会话开场时，保证工作区有协议、有状态页、有一条**已经读过工作区**的预加载会话。

## 它是什么

装上去以后，宿主半边在会话开场做四件事：

1. **检查三个库在不在**（认知 / 工具 / 外部信息），不在就补目录——只建目录，不铺内容。
2. **把协议写进工作区**：`AGENTS.md` 里一个托管段（`<!-- dsh-milieu:begin … -->` … `<!-- dsh-milieu:end -->`）+ `.dsh-milieu/` 下的三份协议文件（定义 / 建议 / 原因）。
3. **保证这个工作区有一条已经读过的预加载会话**（**默认关闭**）：打开 `preloadSession` 后，没有就建一条并让它真读一次；已有但空白就补读。
4. **把工作区那一页状态**（`<认知库>/STATE.md`）注入。

界面半边：切进一条会话时读状态文件，按判据决定弹不弹「这个工作区变了，要不要重读」的卡片；点「重读」就发一条「读一遍并说明变化」的请求。

## 安装（GitHub）

在 DSH 里：**插件管理器 → 安装 → 填 GitHub 地址**：

```
github:sxwpskd/dsh-milieu
```

要钉死版本（推荐）：

```
github:sxwpskd/dsh-milieu#9351b002030809f854f38cf50994434b8ce8b523
```

装完**完全退出 DSH，再打开**。第一次安装由 pnpm 拉 GitHub 仓库，可能需要几十秒。

> 只需要 DSH **0.2.x**（`>=0.2.0-0 <0.3.0`）。本包零依赖；不装 Node 以外的东西。

## 它会写你工作区的什么

只碰这四处：

- `AGENTS.md`：**只维护** `<!-- dsh-milieu:begin … -->` 到 `<!-- dsh-milieu:end -->` 之间；段外一个字不动；
- `.dsh-milieu/`：协议三份（DEFINITION / SUGGESTIONS / RATIONALE）+ `preload.json` 诊断；
- 三个库目录（`review/` `tools/` `external/`）：**缺就建目录，不铺内容**；
- 认知库里的 `STATE.md`：缺就建**状态页骨架**；只重写 `<!-- judgement -->` 以下的材料段。

**卸载不会自动清理这些**（插件管理器移除后，工作区文件还在）。第二期会补清理。

## 为什么协议写文件而不是注入提示词

（主人 2026-10-14 定）用户可能**自己**建会话——那条会话不归我们管，我们不会给它注入任何东西；但它同样需要知道协议。**写进工作区，任何读它的 AI 都看得见。** 所以声源是**工作区文件**；同一份内容只此一处（定义不再进系统提示，避免「同一件事两个版本」）。

写失败就在日志里报告原因，**不搞兜底机制**。

## 它不做什么

- 不跑定期整理；
- 不碰 `AGENTS.md` 托管段以外的任何内容；
- 不在三个库里铺 README / 内容；**唯一的例外**：认知库缺 `STATE.md` 时建一个**状态页骨架**（判断段标记 + 材料段），否则状态页注入在首装工作区里不工作；
- **不再手写消息**：阅读请求只走 `sessionController.prompt`（宿主）或 `session/prompt` Remote（客户端）；没有 prompt 通道时**宁可不发**——手写消息缺 id 会把会话写坏（2026-10-18 真机事故，journal/041）。

## 文件

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `package.json` | 包清单：`type: module`、`exports`（含 `./client`）、`dsh.bundle.patch`、`dsh.client` 段 | 齐 |
| `cordis.patch.yml` | 补丁层：`insert` 我们的 `milieu` 行 + 可配置项（三库路径等） | 齐 |
| `index.js` | **宿主半边**：`apply(ctx, config)`（**不声明 `Config`**，见下方说明）；补三库 → 写协议 → 自动生成状态文件 → 建预加载会话（默认关）→ 注入状态页 | 语法 + 干跑通过；含在 8 套自测里 |
| `protocol.js` | **写进工作区**（补库目录 + `AGENTS.md` 托管段 + `.dsh-milieu/` 三份文件）；幂等、段外不动、失败要报告 | **66 项**自测 |
| `milieu-state.js` | **状态文件生成器**（纯模块：算完返回）：扫工作区 → 比基准 → **事件流** → 有界 → 投影出六桶与计数。**实现住包里**（宿主不能假设用户有 `tools/`）；工具区那份转调它 | 随 `client-selftest` 的投影用例验 |
| `state-page.js` | **注入页的材料段**（纯模块）：启动时重写 `<!-- judgement -->` 以下的材料（变更账 / 三库 / 最近改动 / 受管会话）；**判断段一字不动**，没有标记的页面不碰，内容没变就不写；**首装没有页面时建骨架**（`ensureStatePage`） | 干跑实测 + `index-injection-test` |
| `changes.js` | **变更台账的纯函数**：条目表组装（认知库逐文件 / 其它库一级 / 索引文件 / 排除目录整棵）、比差量出事件、有界、**投影**（六桶与计数的唯一算法）、机制自产物排除表 | 同上 |
| `views.js` | **两种变更视图**（纯）：会话 **30 天内用过** → 文件名 + 大小变化（旧→新 + 净变化）；**超过 30 天** → 认知库只给文件名（最多 20 条，超过写「改动过大」）、其它库只给两个索引文件。接在「重读」的请求文本里 | 随动作自测 |
| `plugin-dryrun.mjs` | 包内干跑脚本（假 ctx）：注册了什么、注到了什么、会不会重发 | `node plugin-dryrun.mjs` |
| `session.js` | **预加载会话的身份与选项组装**（纯）：`mintSessionId()`（`session-<uuid>`，格式照平台）、`buildAgentCreateOptions()`、`findPreloadSession()` | 纯函数，随 `milieu-session` 工具离线可看 |
| `preload-session.js` | **建预加载会话的动作**：先查认知库门槛 → 解析工作区 id → `create({workspaceId})` → 取消归档 → **`prompt` 发阅读**；空白补读、用过的旧会话转 active 再建新的；每步写诊断文件 | **真机验证通过（2026-10-18）；门槛为离线验证** |
| `DEFINITION.md` | **定义层原文**（主人声明，不可改）。被 `protocol.js` 写进工作区 | 原文未改一字 |
| `core.js` | **判据**：识别 / 建库门槛 / 缓存失效 / 指纹淘汰 / 两方向 / 5 分钟阈值 | **90 项** |
| `criteria.js` | **判据与显示阈值的唯一默认值表**（19 个阈值 + `debug` 开关）：判据 / 台账 / 视图 / 客户端 / 宿主；`mergeCriteria()` 负责深合并 | 纯常量，无 import |
| `state.js` | **状态文件形状（v3：事件流为唯一事实）** + 解析容错 + 事件归一（**六桶与计数在解析时由事件流派生**） | 含在 client 自测里 |
| `client-core.js` | **客户端判据**：五关链（归属 / 只弹一次 / 有变化 / **变化够大（结构或内容阈值）** / **距这条会话最后活动 ≥ 阈值**） | 同上 |
| `card.js` | **卡片**：纯 React 组件，只用主题 token | **21 项** |
| `texts.js` | **文本拼装**（纯模块 + **配置层**）：预加载 / 重读两段请求文本，**宿主与客户端共用同一份**；默认值可被 `Config.texts` 整体替换 | 含在动作自测里 |
| `actions.js` | **发请求**：`promptReadViaRemote()`（走现成的 `session/prompt`）；**不再有手写消息的 `sendReadRequest`**（会写坏会话） | 见动作自测 |
| `client.js` | **客户端半边（源码，ES 模块）**：盯当前会话（含它的最后活动时间）→ 读状态文件 → 判据 → 挂卡片 → 三种收场 → 点「重读」**真的发出去** | **接线 46 项** |
| `lib/client.js` | **界面半边的打包产物**（**生成物，别手改**）：平台按**普通脚本**加载界面插件（ES 模块会报 `Cannot use import statement outside a module`）。改界面源码后跑 `node tools/build-client.mjs` | 自检：无 import/export、能注册、能 apply |

**开发工作区里有八套离线测试（约 428 项，全过）**——不随包发布；入口 `node tools/run-tests.mjs`。本包自己那两套 = `protocol-selftest` 66 + `index-injection-test` 48。

**状态机说明**：变更台账的规则见包内 `changes.js` / `state.js`；工作区协作面另有一份 `dsh-milieu/CHANGE-STATE-MACHINE.md`（**不随包发布**）。

## 预加载会话怎么建（真机踩出来的正路）

```
workspaceRegistry.resolveByPath(root)                  // ① 工作区 id（list() 按路径兜底）
sessionController.inspect(sessionId)                   // ② 已有？看有没有第二条 user/message
//    空白 → prompt 补读；已用过 → 转 active，再建新的；只读过一次 → 认领
sessionController.create({ workspaceId, sessionId })   // ③ 建/认领：只有传 id 才会 attach
workspaceRegistry.unarchiveSession(sessionId)          // ④ 从归档集合拿回来
sessionController.prompt({ sessionId, content })       // ⑤ 真读一次（平台补消息 id/来源）
```

几条硬约束，都是真机撞出来的：

- **只传 `cwd` → 无主会话**：平台只在传 `workspaceId` 时才 `attachSession`；无主会话可能进 `archivedSessionIds`，侧栏不显示。
- **空白且没被打开的会话，侧栏不列**：Ctrl+N 建出来也是空白，但界面会立刻打开它；我们只「建/挂」不读，它就一直是空白。所以最后一步必须**真读一次**。
- **消息来源只能是 `user`**：会话格式 v4 拒绝 `kind: 'plugin'`（报 `format v4 message requires a producer-owned source kind`）。
- **每步写进 `.dsh-milieu/preload.json`**（`stage / workspaceId / sessionId / step / unarchive / blank / didRead / error`）；失败先读它，别先猜。

## 数据流（一眼看清分工）

```
宿主脚本 milieu-state.mjs ──写──> review/milieu-state.json ──读──> 客户端 client.js
   （清单 → 分库差量 → 判据）          （材料：谁、上次读何时、变了什么）     │
                                                                    ├─ client-core.js 判该不该弹
                                                                    ├─ card.js 画卡片
                                                                    └─ 你点「重读」→ actions.js
                                                                                    ↓
                                                            现成的 session/prompt Remote
                                                                                    ↓
                                                      往那条会话发一次「读工作区」的请求
```

**判据一处、材料一份、文本一份、界面一处。**

## 已知的架构难点（**已解，留档备查**）

- **「切到了哪条会话」是客户端事实**——宿主看不见。客户端靠 `retainedBy.mainView` 计数判断当前会话。
- **客户端读文件用现成的 `remote.workspaceFiles.read(sessionId, path)`**——不需要自建 Remote、不需要代码生成。
- **盯「当前会话」用轮询**（2 秒一次）：一开始只想订阅当前那条的保留计数，**结果切到别人那条时收不到通知**（接线测试抓出来的）。轮询简单、不漏，代价是一点点唤醒。

## 真机验证状态（2026-10-18 晚）

1. **插槽键 `conversation.chat.turnTail`** —— ✅ 真机确认（卡片挂在这里）。
2. **`ctx.sessions.list.subscribe` 是否存在** —— 未验；现在靠 2 秒轮询，功能不受影响。
3. **`remote.workspaceFiles.read` 的返回** —— ✅ 实测是 `{ ok: true, value: { … } }`，代码已拆包装（journal/044）。
4. **卡片 + 「重读」** —— ✅ 真机通过：卡片出现、点"重读"收到带变更视图的请求。
5. **预加载会话“用过后毕业”** —— ✅ 真机可见：正在用的那条已转 `active`；新建会被 readiness 门槛拦下（真实工作区的认知库还不满 10 文件 / 10 KB）。
6. **工作区定位（2026-10-19）** —— 空 `workspaceRoot` 时问平台 `workspaceRegistry`：只有一个工作区就用它；多个时用平台顺序里的第一个（日志会报出用的是哪一个）。**已重启验证**：配置为空、根解析到 `D:\DSH`；但本包没有持久日志，`（registry）` 那行看不到。

## 依据

官方技能「cordis-plugin-development」的 `references/host-plugin.md`。要点：

- Host-only 的 bundle **不需要依赖、不需要构建**；
- `index.js` 只能二选一：`export function apply(ctx, config)`（可带 `inject` / `Config`），**或**默认导出 service class——**不许混用**；
- 一切注册放进 `apply`，用 `ctx.effect` / `ctx.on` 并**返回清理**；
- 声明 `Config` 的插件**在激活时**校验该行的 `config`——**但 Cordis 要求 `Config` 是 Schemastery Schema**（`~standard.validate`），**普通对象会让激活直接失败**（2026-10-18 真机踩过：`TypeError: Cannot read properties of undefined (reading 'validate')`）。所以本包**不声明 `Config`**：可调项照旧从补丁层的 `config` 传入，代码里有 `DEFAULT_CONFIG` 兜底。

## 配置项一览（逐项说明）

**默认值只在一处**：顶层在 `index.js` 的 `DEFAULT_CONFIG`，阈值在 `criteria.js`；补丁层 `cordis.patch.yml` 只写覆盖。
宿主把**生效的 `criteria`** 写进 `milieu-state.json`，客户端读同一份（两半不许各写一份）。

### 顶层配置

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `libs.review` / `libs.tools` / `libs.external` | `review` / `tools` / `external` | 三个库的**目录名**。改名只改这里；插件靠它找库 |
| `statePath` | `STATE.md` | 状态页在认知库里的相对路径。注入 / 刷新材料段用它 |
| `injectState` | `true` | 要不要把状态页作为提示段注入 |
| `injectBudgetKiB` | `128` | 注入预算（KiB）；超了**跳过**，不截断 |
| `writeProtocol` | `true` | 要不要写 `AGENTS.md` 托管段 + `.dsh-milieu/` 三份协议文件 |
| `ensureLibs` | `true` | 三个库缺目录时要不要补建；**只建目录，不铺内容** |
| `texts` | `DEFAULT_TEXTS` | 预加载 / 重读两段请求文本。默认值在 `texts.js`；**函数不能经 YAML 传**，覆盖走宿主侧注入。第一行是时间（用于请求本身/日志；**标题由宿主的标题提供方决定**） |
| `preloadSession` | `false`（代码与发布补丁层都关） | 要不要保证一条**已经读过**的预加载会话；没有就建，空白补读，用过的旧会话转 `active` 后新建。**默认关**：它会真跑一次 agent（花钱、动会话列表）；要用再打开 |
| `autoState` | `true` | 会话开场自动生成状态文件，并顺手刷新 `STATE.md` 材料段（**首装没有这一页就先建骨架**） |
| `workspaceRoot` | `''`（空） | 工作区根。空 = **问平台** `workspaceRegistry`：只有一个工作区就用它；多个时用平台顺序里的第一个（日志报出用的是哪个）。配置了就固定用它 |
| `criteria` | `DEFAULT_CRITERIA` | 19 个判据 / 显示阈值 + `debug`，见下表 |

### `criteria`（19 个阈值 + `debug` 开关）

| 键 | 默认 | 含义 | 现在生效吗 |
| --- | --- | --- | --- |
| `structuralThreshold` | 1 | 新增/消失几个文件就重读 | ✅ 客户端弹卡 |
| `contentThreshold` | 5 | 改动几个文件就重读 | ✅ 客户端弹卡 |
| `staleHintDays` | 30 | 距上次阅读超过多少天，给一句“该看看了”的提示 | ❌ 预留 |
| `promptThresholdMs` | 300000（5 分钟） | 距这条会话最后活动多久，才弹“要不要重读”的卡 | ✅ 客户端弹卡 |
| `readiness.minFiles` | 10 | 认知库至少几个文件才算“建立完成” | ✅ 新建预加载时 |
| `readiness.minBytes` | 10240 | 认知库至少多大（10 KB） | ✅ 新建预加载时 |
| `readiness.windowMs` | 300000 | 观察窗（5 分钟） | ✅ 新建预加载时 |
| `readiness.maxGrowthRate` | 0.30 | 窗内新增速度要 < 30% | ✅ 新建预加载时 |
| `readiness.maxChangedRatio` | 0.20 | 窗内变动占比要 < 20% | ✅ 新建预加载时 |
| `fingerprint.keepDays` | 1 | 会话指纹保留最近 1 天 | ❌ 预留 |
| `fingerprint.keepRecent` | 5 | 再并上最近 5 条会话的指纹 | ❌ 预留 |
| `eventKeepDays` | 30 | 事件流保留最近 30 天 | ✅ 状态文件生成 |
| `eventKeepCount` | 500 | 再并上最近 500 条事件 | ✅ 状态文件生成 |
| `staleDays` | 30 | 会话超过 30 天没用 → 重读时只给文件名 | ✅ 重读视图 |
| `staleMaxReview` | 20 | 视图 B 里认知库最多列 20 条 | ✅ 重读视图 |
| `clientMemoryLimit` | 20 | 客户端记住“弹过”的会话数上限 | ✅ 客户端 |
| `debug` | `false` | 客户端在聊天里渲染一行自报状态（排查用，平时关） | — |
| `pollMs` | 2000 | 客户端轮询“当前是哪条会话”的间隔 | ⚠️ 部分（启动时用默认；状态里的值目前不会重启轮询） |
| `readTimeoutMs` | 4000 | 客户端读状态文件的超时 | ⚠️ 部分（第一次读用默认，之后用状态里的值） |
| `agentLoopWaitMs` | 10000 | 宿主等 `agentLoop` 就绪的兜底时间 | ✅ 宿主 |

> **“预留”** = 函数存在、测试覆盖，但实时路径还没调用；改了不改变运行行为。
> **“部分”** = 第一次读/启动时用默认，之后跟随状态文件。

### 工作区级配置（`.dsh-milieu.json`）

| 键 | 含义 |
| --- | --- |
| `libs` | 和插件那份同名，供状态生成器 / 工具使用 |
| `inventory.excludePaths` | 不逐文件登记的子树（当前是 `external/refs`） |
| `changes` | 事件流有界参数（`keepDays` / `keepCount`），可选 |
| `criteria` | 独立工具 `milieu-state.mjs` 用的阈值；不写就用默认 |

## 设计纪律（写代码时就守着）

1. **零依赖、纯 ESM、无构建**（界面那半边除外——它必须打成普通脚本）。
2. **不假设 API 存在**：扩展点查不到就静默跳过，绝不抛错影响宿主启动。
3. **内容没变不重发**：按「文件 mtime + 字节数」做指纹，没变就返回 `null`（省 token）。
4. **超预算不硬塞**：超过 `injectBudgetKiB` 就跳过，**不静默截断**。
5. **写入面很窄**：只写协议托管段、`.dsh-milieu/`（协议三份 + 诊断文件）、认知库里的 `milieu-state.json` 与 `STATE.md` 材料段；不碰用户其它内容。

## 开发：从源码安装

改源码时用**本地目录**装（官方 `install_bundle`，`target` 指向本仓库根目录的绝对路径，也就是 `package.json` 所在处）：

```
D:\你的路径\dsh-milieu
```

装完**完全退出 DSH，再打开**。`link` 安装，改源码重启即生效，不用重装。

官方规范：**不要手写 profile 的 `package.json` / `cordis.patch.yml`，不要在 profile 目录跑 pnpm**——装交给插件管理器。

## 状态（作者本机，2026-10-18/19）

- 已安装、已激活；协议写入、状态页注入、预加载会话、卡片 + 「重读」都在真机跑通。
- **阅读请求只走 `sessionController.prompt`**：不手写消息（手写会缺 id、写坏会话）。
- 旧预加载会话会“毕业”：被人用过的 `role: preload` 转 `active`，插件再新建一条。
- 详细验证记录在开发工作区的 `journal/` 里（不随包发布）。

## 平台契约与踩坑

见工作区的 `field-notes/dsh-plugin-dev.md`（**不随包发布**）。那份记的是 `journal/023`、`028`–`040` 里踩出来的平台契约：`Config` / `inject` / `agentLoop` / 挂工作区 / v4 来源 / 打包形态。

## License

MIT。见 [LICENSE](LICENSE)。
