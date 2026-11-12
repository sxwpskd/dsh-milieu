# uninstall/ —— 卸载层

> 这一层回答：**我们走了以后，怎么把留在工作区里的痕迹收干净。**
> 依据：`plugin/_scaffold/uninstall/README.md`（架构规范）与 `reference/core/effects.js`（参考实现，非规范）。

## 为什么不是一个卸载回调

**宿主卸载时，插件的代码已经没了，跑不了 `dispose` 回调。** 所以卸载是两件事：

1. 运行时记台账：插件每次创建 / 修改 / 删除工作区文件，记一条；
2. 用户**先**跑撤回，再卸载插件本体。

## 台账

路径：`<root>/.dsh-milieu/side-effects.json`

```json
{
  "version": 1,
  "plugin": "dsh-milieu",
  "items": [
    { "kind": "created", "path": "review/milieu-state.json", "owner": "plugin", "strategy": "remove" },
    { "kind": "modified", "path": "AGENTS.md", "owner": "plugin", "strategy": "managed-block" },
    { "kind": "modified", "path": ".dsh-milieu/DEFINITION.md", "owner": "protocol", "strategy": "full", "backup": "…" }
  ]
}
```

- `path` 一律相对工作区根；撤回时做根内校验，禁止目录穿越。
- `owner`：`plugin`（默认撤）/ `protocol`（默认留，`--all` 才撤）/ `user`（永远不撤）。
- `strategy`：`full` / `remove` / `managed-block` / `state-material` / `dir`。

运行时记录在 `record.js`（包装文件系统写操作）；已有旧版本产物在首次启用时由 `seedKnownArtifacts()` 认领，避免“新版本第一次启动前就已经存在”无法撤。

## 用法（先撤回，再卸载）

```powershell
# 只看会动什么（默认 dry-run）
node <包目录>\uninstall\withdraw.mjs --root D:\DSH --dry-run

# 真撤：插件运行痕迹 + AGENTS.md 托管段 + STATE.md 材料段
node <包目录>\uninstall\withdraw.mjs --root D:\DSH --apply

# 连协议文件一起撤（.dsh-milieu/ 三件 + AGENTS.md 托管段）
node <包目录>\uninstall\withdraw.mjs --root D:\DSH --apply --all
```

**顺序**：先停插件（完全退出 DSH）→ dry-run → 人确认 → `--apply` → 卸载插件本体。

## 默认撤什么 / 不撤什么

| 对象 | 默认 `withdraw` | `--all` |
| --- | --- | --- |
| 状态文件 / 缓存 / 诊断文件（`.dsh-milieu/*`、`review/milieu-state.json`、`tools/.milieu-state-prev.json`） | 撤 | 撤 |
| `AGENTS.md` 托管段 | 撤（段外一字不动） | 撤 |
| `STATE.md` 材料段 | 撤（判断段保留；有旧材料就还原旧材料） | 撤 |
| 协议三件（`.dsh-milieu/DEFINITION/SUGGESTIONS/RATIONALE`） | **保留**（插件走了，协议还在工作区） | 撤/还原 |
| 用户文件、用户改过的内容、别人的改动 | **永远不撤** | **永远不撤** |

## 边界

- 幂等：成功后删台账；再跑就是“没有台账”；
- 只认台账里的路径，不做目录级递归猜测；
- 撤不掉要报告（缺备份 / 非空目录 / 路径越界）；
- 非空目录不删；用户内容永远不删；
- **DSH profile 的配置行和 `node_modules` junction 不归这一层管**：那是宿主插件管理器的卸载行为，插件代码在卸载后已不存在。需要时由用户/宿主清理。

## 文件

| 文件 | 负责 |
| --- | --- |
| `ledger.js` | 台账形状、持久化、`withdraw` 编排（dry-run / 倒序 / 逐条报告） |
| `record.js` | 运行时包装 fs：写前记录；`seedKnownArtifacts` 认领旧产物 |
| `withdraw.mjs` | 先于卸载运行的 CLI |

`package.json` 的 `files` 已包含 `uninstall/`；CLI 在发布包里也能用。
