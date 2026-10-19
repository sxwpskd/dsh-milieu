# dsh-milieu

> **让 AI 在每个新会话里都记得这个工作区**：这里的规矩、三个库、当前状态、上次读到哪。

DSH 的会话是"没有记忆"的：每开一个新会话，AI 都要重新摸一遍你的工作区。
dsh-milieu 把「这个工作区该怎么管」和「它现在是什么样」落成文件和状态，让每个会话——**包括你自己建的、不归插件管的会话**——都看得见。

## 它解决什么问题

- **新会话从零开始**：AI 不知道这里的规矩、三个库在哪、上次读到哪里，每次都要重新摸索。
- **认知会过期**：工作区新增 / 改动 / 删除了文件，会话里的 AI 还在用旧认知回答，没人提醒它"该重读了"。
- **自己建的会话没人管**：插件不会给用户自己建的会话注入任何东西，但它同样需要知道协议。

## 它做什么

### 1. 把协议装进工作区，帮 AI 管理这个工作区

装好之后，每次会话开场它会做四件事：

1. **补全三个库**（`review/` `tools/` `external/`）：缺就建目录，**只建目录，不铺内容**；
2. **把协议写进工作区**：`AGENTS.md` 里只加一个托管段（`<!-- dsh-milieu:begin … -->` … `<!-- dsh-milieu:end -->`），段外一字不动；同时写 `.dsh-milieu/` 三份文件（定义 / 建议 / 原因）；
3. **生成状态文件**：扫一遍工作区，记下"变了什么"（事件流），客户端据此判断该不该提醒重读。**需要工作区里有 `tools/manifest.md`**（开发工具生成）；全新工作区没有清单时，这一步会先跳过（见"边界与已知限制"）；
4. **注入一页状态**（`review/STATE.md`）：上半是 agent 写的判断，下半是机器扫出的材料（变更账 / 三个库 / 最近改动 / 受管会话）。首装没有这一页时，先建一个只带判断段标记的骨架。

**为什么写文件，而不是注入提示词？**
因为用户可能**自己**建会话——那条会话不归我们管，注入不进去；但它同样需要知道协议。
**写进工作区文件，任何读这个工作区的 AI 都看得见。** 同一份定义只此一处，避免"同一件事两个版本"。

### 2. 预加载会话，维护"会话的认知"

- **预加载会话**：打开 `preloadSession` 后，工作区没有一条"已经读过"的会话就建一条，并让它真读一次；空白会话会补读；被人用过的旧会话转成 `active`，再建一条干净的。
- **该重读时提醒**：界面按五关判断——这条会话归不归我们管 → 弹过没有 → 工作区变没变 → 变化够不够大 → 距会话最后活动够不够久。都过了才弹「这个工作区变了，要不要重读」。
- **重读带变更摘要**：点"重读"发出去的请求里带变更视图——30 天内用过的会话给"文件名 + 旧→新大小变化"；超过 30 天只给文件名（认知库最多 20 条）和其它库的两个索引文件。
- **只提示，不自动重发**。改代码、跑脚本都不会被它打断。

> `preloadSession` **默认关闭**：它会真跑一次 agent（花 token、动会话列表）。要用再在配置里打开。

## 30 秒看懂它怎么跑

```
安装 → 打开工作区
  ├─ 会话开场：补三库 → 写协议 → 生成状态文件 → 注入状态页
  ├─ 切进会话：读状态文件 → 五关判据 → （工作区变了就）弹卡片
  └─ 点「重读」：发一条带变更摘要的请求 → 那条会话的 AI 重新认识工作区
```

## 安装

在 DSH 里：**插件管理器 → 安装 → 填 GitHub 地址**：

```
github:sxwpskd/dsh-milieu
```

装完**完全退出 DSH，再打开**。第一次安装由 pnpm 拉 GitHub 仓库，可能需要几十秒。

- 需要 DSH **0.2.x**（`>=0.2.0-0 <0.3.0`）；本包零依赖，不装 Node 以外的东西。
- 想钉死版本：在仓库的 commit 页面复制 SHA，写成 `github:sxwpskd/dsh-milieu#<sha>`。

## 它会写你工作区的什么

只碰这四处：

- `AGENTS.md`：**只维护**托管段（`<!-- dsh-milieu:begin … -->` 到 `<!-- dsh-milieu:end -->` 之间）；段外一个字不动；
- `.dsh-milieu/`：协议三份（DEFINITION / SUGGESTIONS / RATIONALE）+ `preload.json` 诊断；
- 三个库目录（`review/` `tools/` `external/`）：**缺就建目录，不铺内容**；
- 认知库里的 `STATE.md`：缺就建**状态页骨架**；只重写 `<!-- judgement -->` 以下的材料段。

**卸载不会自动清理这些**（插件管理器移除后，工作区文件还在）。第二期会补清理。

## 配置

默认值只有一处：顶层在 `index.js` 的 `DEFAULT_CONFIG`，阈值在 `criteria.js`；补丁层 `cordis.patch.yml` 只写覆盖。
宿主把生效的 `criteria` 写进 `milieu-state.json`，客户端读同一份。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `workspaceRoot` | `''`（空） | 工作区根。空 = **问平台** `workspaceRegistry`：只有一个工作区就用它；多个时用平台顺序里的第一个（日志报出用的是哪个） |
| `preloadSession` | `false` | 要不要保证一条**已经读过**的预加载会话。默认关：它会真跑一次 agent |
| `libs.review` / `libs.tools` / `libs.external` | `review` / `tools` / `external` | 三个库的目录名 |
| `statePath` | `STATE.md` | 状态页在认知库里的相对路径 |
| `injectState` / `injectBudgetKiB` | `true` / `128` | 要不要注入状态页；注入预算（KiB），超了跳过、不截断 |
| `writeProtocol` / `ensureLibs` | `true` / `true` | 要不要写协议；要不要补库目录 |
| `autoState` | `true` | 会话开场自动生成状态文件、刷新状态页材料段 |
| `criteria` | `DEFAULT_CRITERIA` | 19 个判据 / 显示阈值，见下 |

<details>
<summary><code>criteria</code>：19 个阈值 + <code>debug</code>（点开）</summary>

| 键 | 默认 | 含义 | 现在生效吗 |
| --- | --- | --- | --- |
| `structuralThreshold` | 1 | 新增/消失几个文件就重读 | ✅ 客户端弹卡 |
| `contentThreshold` | 5 | 改动几个文件就重读 | ✅ 客户端弹卡 |
| `staleHintDays` | 30 | 距上次阅读超过多少天，给一句"该看看了"的提示 | ❌ 预留 |
| `promptThresholdMs` | 300000（5 分钟） | 距这条会话最后活动多久，才弹"要不要重读"的卡 | ✅ 客户端弹卡 |
| `readiness.minFiles` | 10 | 认知库至少几个文件才算"建立完成" | ✅ 新建预加载时 |
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
| `clientMemoryLimit` | 20 | 客户端记住"弹过"的会话数上限 | ✅ 客户端 |
| `debug` | `false` | 客户端在聊天里渲染一行自报状态（排查用） | — |
| `pollMs` | 2000 | 客户端轮询"当前是哪条会话"的间隔 | ⚠️ 部分 |
| `readTimeoutMs` | 4000 | 客户端读状态文件的超时 | ⚠️ 部分 |
| `agentLoopWaitMs` | 10000 | 宿主等 `agentLoop` 就绪的兜底时间 | ✅ 宿主 |

> **"预留"** = 函数存在、测试覆盖，但实时路径还没调用；改了不改变运行行为。
> **"部分"** = 第一次读/启动时用默认，之后跟随状态文件。

</details>

<details>
<summary>工作区级配置 <code>.dsh-milieu.json</code>（点开）</summary>

| 键 | 含义 |
| --- | --- |
| `libs` | 和插件那份同名，供状态生成器 / 工具使用 |
| `inventory.excludePaths` | 不逐文件登记的子树（当前是 `external/refs`） |
| `changes` | 事件流有界参数（`keepDays` / `keepCount`），可选 |
| `criteria` | 独立工具用的阈值；不写就用默认 |

</details>

## 边界与已知限制

- **`preloadSession` 默认关**：会真跑一次 agent，要自己打开。
- **状态文件依赖工作区清单**：`autoState` 目前要 `tools/manifest.md`（开发工具 `inventory` 生成）。全新工作区没有清单时，状态文件与"重读提示"不会出现——**这是下一步要补的**（让插件自己扫工作区，不依赖清单）。
- **预加载受认知库门槛限制**：新建预加载前要求认知库 ≥ 10 文件 / ≥ 10 KB（`readiness`）。全新工作区会被拦住——这是有意的，避免在"还没建立认知"的地方乱建会话。
- **多工作区还没验**：空 `workspaceRoot` 时，只有一个工作区就直接用，多个时用平台顺序里的第一个；"每个工作区各管各的"还没做。
- **没有持久日志**（第二期）：出问题先看 `.dsh-milieu/preload.json` 和界面上的调试行（`criteria.debug`）。
- **卸载不清理**：见上一节。
- **失败只报告，不兜底**：写不进去、服务取不到，日志里说清原因，不会假装成功，也不会把宿主拖崩。
- **不做定期整理**：只做协议、状态、预加载、重读提示这四件事。

## 开发与验证

- 开发工作区里有 **8 套 / 约 428 项**离线测试，入口 `node tools/run-tests.mjs`（测试不随包发布）。
- 官方静态检查：`dsh-plugin-dev check` → **OK (8 / 0 / 3 / 5)**；剩 3 条 warning 是发布期的事（`packageManager` / icon+locale / 五语 README）。
- 协议写入、状态页注入、预加载会话、卡片 + 「重读」都在真机通过（2026-10-18/19）。

<details>
<summary>文件说明（点开）</summary>

| 文件 | 作用 |
| --- | --- |
| `index.js` | **宿主半边**：`apply(ctx, config)`；补三库 → 写协议 → 生成状态 → 建预加载会话（默认关）→ 注入状态页 |
| `protocol.js` | **写进工作区**：补库目录 + `AGENTS.md` 托管段 + `.dsh-milieu/` 三份文件；幂等、段外不动、失败要报告 |
| `milieu-state.js` | 状态文件生成器（纯模块）：扫工作区 → 比基准 → 事件流 → 有界 → 投影 |
| `state-page.js` | 注入页的材料段：只重写 `<!-- judgement -->` 以下；首装建骨架 |
| `changes.js` / `views.js` | 变更台账的纯函数 / 两种变更视图（30 天内给大小变化，超过只给文件名与索引） |
| `session.js` / `preload-session.js` | 预加载会话的身份组装 / 建会话、补读、毕业的动作 |
| `core.js` / `criteria.js` / `state.js` / `client-core.js` | 判据 / 阈值 / 状态文件形状 / 客户端五关判据 |
| `card.js` / `texts.js` / `actions.js` / `client.js` | 卡片 / 请求文本 / 发请求 / 界面半边 |
| `lib/client.js` | 界面半边的**打包产物**（平台按普通脚本加载；改界面源码后跑 `node tools/build-client.mjs`） |

</details>

<details>
<summary>预加载会话怎么建（真机踩出来的正路，点开）</summary>

```
workspaceRegistry.resolveByPath(root)                  // ① 工作区 id（list() 按路径兜底）
sessionController.inspect(sessionId)                   // ② 已有？看有没有第二条 user/message
//    空白 → prompt 补读；已用过 → 转 active，再建新的；只读过一次 → 认领
sessionController.create({ workspaceId, sessionId })   // ③ 建/认领：只有传 id 才会 attach
workspaceRegistry.unarchiveSession(sessionId)          // ④ 从归档集合拿回来
sessionController.prompt({ sessionId, content })       // ⑤ 真读一次（平台补消息 id/来源）
```

几条硬约束：

- **只传 `cwd` → 无主会话**：平台只在传 `workspaceId` 时才 `attachSession`；无主会话可能进归档、侧栏不显示。
- **空白且没被打开的会话，侧栏不列**：只"建/挂"不读，它就一直是空白。所以最后一步必须**真读一次**。
- **消息来源只能是 `user`**：v4 拒绝 `kind: 'plugin'`。
- **不要手写消息**：只走 `sessionController.prompt`，平台补消息 id / 来源 / 排队。手写会缺 id、把会话写坏。
- 每步写进 `.dsh-milieu/preload.json`；失败先读它，别先猜。

</details>

<details>
<summary>设计纪律（点开）</summary>

1. **零依赖、纯 ESM、无构建**（界面那半边除外——它必须打成普通脚本）。
2. **不假设 API 存在**：扩展点查不到就静默跳过，绝不抛错影响宿主启动。
3. **内容没变不重发**：按「文件 mtime + 字节数」做指纹，没变就返回 `null`（省 token）。
4. **超预算不硬塞**：超过 `injectBudgetKiB` 就跳过，**不静默截断**。
5. **写入面很窄**：只写协议托管段、`.dsh-milieu/`、认知库里的 `milieu-state.json` 与 `STATE.md` 材料段。
6. **失败要报告，主语落在工具/环境上**，不写"我没做"。

</details>

## License

MIT。见 [LICENSE](LICENSE)。
