// dsh-milieu —— **Config Schema**（插件配置的运行时校验/默认值/Volatile 声明）
//
// 依据（SETTINGS-UI-PLAN.md §3.1 与官方 `adding-a-settings-card`）：
//   · Cordis 的配置页/表单要求插件导出 `Config`（Schemastery / Standard Schema），
//     Loader 在 `apply` 前用它校验配置、补默认值、把 `.volatile()` 字段解析成稳定引用；
//   · 本文件是**默认值的消费者**：所有默认值都从 `config/defaults.js` / `config/criteria.js` 取，
//     不在这里重新写一份数字（"同一件事两个版本"是本工作区最怕的错）。
//
// Volatile（即时字段）只标 4 个（SETTINGS-UI-PLAN §2 / task-12）：
//   · `preloadSession` / `autoState` / `criteria` —— 保存后可以即时生效；
//   · `workspaces` —— 第 1 步**只读展示**用；标记 volatile 让 Loader 在只改它时也能触发
//     `loader/volatile-update`（页面先不提供写控件，后续任务再决定结构性编辑走哪条路）。
//   其余字段是普通字段：改它们走 Loader 的常规生命周期（重载插件行），不是即时更新。
//
// 不可用的配置形状（类型不对、workspaces 项缺 path）在 Loader 校验阶段就报错——**fail loud**；
// 未知字段保留（Schemastery 默认行为，向前兼容新增字段）。
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_CONFIG } from './defaults.js';
import { DEFAULT_CRITERIA } from './criteria.js';

// ---------------------------------------------------------------------------
// libs：三个库的名字
//   · 顶层：带默认值（缺省 = 约定名）；
//   · workspaces 项里的覆盖是**原样透传**的（见 workspaceItem 注释：避免对象/数组 schema
//     把"缺省"物化成 {} / []，把那项覆盖变成"把顶层值清空"）。
// ---------------------------------------------------------------------------
const libsDefaults = Schema.object({
  review: Schema.string().default(DEFAULT_CONFIG.libs.review),
  tools: Schema.string().default(DEFAULT_CONFIG.libs.tools),
  external: Schema.string().default(DEFAULT_CONFIG.libs.external),
});

const readinessDefaults = Schema.object({
  minFiles: Schema.number().default(DEFAULT_CRITERIA.readiness.minFiles),
  minBytes: Schema.number().default(DEFAULT_CRITERIA.readiness.minBytes),
  windowMs: Schema.number().default(DEFAULT_CRITERIA.readiness.windowMs),
  maxGrowthRate: Schema.number().default(DEFAULT_CRITERIA.readiness.maxGrowthRate),
  maxChangedRatio: Schema.number().default(DEFAULT_CRITERIA.readiness.maxChangedRatio),
  ignore: Schema.array(Schema.string()).default([...DEFAULT_CRITERIA.readiness.ignore]),
});

const fingerprintDefaults = Schema.object({
  keepDays: Schema.number().default(DEFAULT_CRITERIA.fingerprint.keepDays),
  keepRecent: Schema.number().default(DEFAULT_CRITERIA.fingerprint.keepRecent),
});

const criteriaDefaults = Schema.object({
  structuralThreshold: Schema.number().default(DEFAULT_CRITERIA.structuralThreshold),
  contentThreshold: Schema.number().default(DEFAULT_CRITERIA.contentThreshold),
  staleHintDays: Schema.number().default(DEFAULT_CRITERIA.staleHintDays),
  promptThresholdMs: Schema.number().default(DEFAULT_CRITERIA.promptThresholdMs),
  preloadIdleMs: Schema.number().default(DEFAULT_CRITERIA.preloadIdleMs),
  preloadPollMs: Schema.number().default(DEFAULT_CRITERIA.preloadPollMs),
  workspacePollMs: Schema.number().default(DEFAULT_CRITERIA.workspacePollMs),
  readiness: readinessDefaults.default(DEFAULT_CRITERIA.readiness),
  fingerprint: fingerprintDefaults.default(DEFAULT_CRITERIA.fingerprint),
  eventKeepDays: Schema.number().default(DEFAULT_CRITERIA.eventKeepDays),
  eventKeepCount: Schema.number().default(DEFAULT_CRITERIA.eventKeepCount),
  staleDays: Schema.number().default(DEFAULT_CRITERIA.staleDays),
  staleMaxReview: Schema.number().default(DEFAULT_CRITERIA.staleMaxReview),
  clientMemoryLimit: Schema.number().default(DEFAULT_CRITERIA.clientMemoryLimit),
  pollMs: Schema.number().default(DEFAULT_CRITERIA.pollMs),
  readTimeoutMs: Schema.number().default(DEFAULT_CRITERIA.readTimeoutMs),
  debug: Schema.boolean().default(DEFAULT_CRITERIA.debug),
  agentLoopWaitMs: Schema.number().default(DEFAULT_CRITERIA.agentLoopWaitMs),
});

// ---------------------------------------------------------------------------
// workspaces 项：只声明并校验 `path`（必填）；其余键是**覆盖字段**，原样透传。
//
// 为什么不在这里声明 `libs` / `criteria` 等覆盖 schema：Schemastery 的 object/array 类型
// **自带默认值 `{}` / `[]`**（即使没写 `.default()`）——一旦声明嵌套覆盖，配置里没写的
// `criteria` 会被物化成 `{readiness:{ignore:[]}, fingerprint:{}}`，规划器的深合并就会把
// 顶层的 `readiness.ignore` 覆盖成空数组（"缺省"变成"清空"）。
// 第 1 步 workspaces 页面**只读展示**，不需要嵌套表单字段；覆盖值由 `core/workspace-plan.js`
// 做类型宽容的深合并（与原行为一致）。后续若要在表单里编辑 workspaces（结构性编辑），
// 再为它设计不会物化缺省值的字段模型。
// ---------------------------------------------------------------------------
const workspaceItem = Schema.object({
  path: Schema.string().required(),
});

// ---------------------------------------------------------------------------
// 顶层 Config
// ---------------------------------------------------------------------------
export const Config = Schema.object({
  libs: libsDefaults.default(DEFAULT_CONFIG.libs),
  statePath: Schema.string().default(DEFAULT_CONFIG.statePath),
  injectState: Schema.boolean().default(DEFAULT_CONFIG.injectState),
  injectBudgetKiB: Schema.number().default(DEFAULT_CONFIG.injectBudgetKiB),
  writeProtocol: Schema.boolean().default(DEFAULT_CONFIG.writeProtocol),
  ensureLibs: Schema.boolean().default(DEFAULT_CONFIG.ensureLibs),

  // ---- 即时字段（Volatile） ----
  preloadSession: Schema.boolean().default(DEFAULT_CONFIG.preloadSession).volatile(),
  autoState: Schema.boolean().default(DEFAULT_CONFIG.autoState).volatile(),
  criteria: criteriaDefaults.default(DEFAULT_CRITERIA).volatile(),
  // 第 1 步只读展示（页面不提供写控件）；先标 volatile 让只改它也能收到更新事件。
  workspaces: Schema.array(workspaceItem).default([]).volatile(),

  // ---- 普通字段 ----
  workspaceRoot: Schema.string().default(DEFAULT_CONFIG.workspaceRoot),
});

/** 列出即时字段名（启动器/测试用；与上面 `.volatile()` 的字段保持一致）。 */
export const VOLATILE_FIELDS = Object.freeze(['preloadSession', 'autoState', 'criteria', 'workspaces']);
