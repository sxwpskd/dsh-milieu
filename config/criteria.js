// dsh-milieu —— **判据与显示阈值的唯一默认值表** + 合并逻辑
//
// 为什么单独一个文件：这些数**宿主和客户端都要用**——
//   · 宿主：建会话、写状态、生成事件流；
//   · 客户端：弹卡、选视图、轮询。
// 两边各写一份 = "同一件事两个版本"（这个工作区最怕的那种错）。
// 所以：**默认值只在这里**；宿主把**生效值**写进 `milieu-state.json` 的 `criteria` 字段，
// 客户端读同一份。配置覆盖走 `Config.criteria`（宿主）；客户端跟随状态文件。
//
// **纯模块、零 import**：core / changes / views / state / client 都能引，不产生环。
//
// 字段分六组：
//   判据（core/criteria.js）      structuralThreshold / contentThreshold / staleHintDays / promptThresholdMs / readiness / fingerprint
//   预加载（core/preload.js）     preloadIdleMs（"用过的预加载会话多久算空闲"）
//   监控（core/*-monitor.js）     preloadPollMs（预加载）/ workspacePollMs（工作区改动）
//   台账（core/changes.js）       eventKeepDays / eventKeepCount
//   视图（core/views.js）         staleDays / staleMaxReview
//   客户端 / 宿主                 clientMemoryLimit / pollMs / readTimeoutMs / agentLoopWaitMs
export const DEFAULT_CRITERIA = {
  // ---- 判据：要不要"再读一遍"（core/criteria.js） ----
  structuralThreshold: 1,          // 新增/消失几个就重读
  contentThreshold: 5,             // 改动几个就重读
  staleHintDays: 30,               // 距上次阅读超过这么多天 → 只提示，不重读
  promptThresholdMs: 5 * 60 * 1000, // 距这条会话最后活动 ≥ 5 分钟才弹卡

  // ---- 预加载：被用户用过的预加载会话，空闲多久才算"可以毕业并新建"（core/preload.js） ----
  // 独立于 promptThresholdMs：那个管"弹不弹重读卡"，这个管"预加载会话要不要换新"；
  // 两者碰巧都是 5 分钟，但一个改不应牵动另一个（2026-10-31 定）。
  preloadIdleMs: 5 * 60 * 1000,

  // ---- 监控：预加载会话的长期 effect 多久兜底扫一次（core/preload-monitor.js） ----
  // 轮次事件（turn/end）已经能及时触发；定时只是"事件丢了也能自愈"的低频兜底。
  // 别调太小：每 tick 都会读状态文件 + 扫认知库（只读，但没必要）。
  preloadPollMs: 60 * 1000,

  // ---- 监控：工作区改动的长期 effect 多久兜底扫一次（core/workspace-monitor.js） ----
  // 与 preloadPollMs 各自独立：一个管"会话对不对"，一个管"工作区变没变"；
  // 改一个不应牵动另一个。turn/end 已经能及时触发，定时只是防丢事件的兜底。
  workspacePollMs: 60 * 1000,

  // ---- 判据：认知库"建立完成"的门槛（core/criteria.js 的 evaluateReadiness） ----
  readiness: {
    minFiles: 10,                  // 文件数 ≥ 10
    minBytes: 10 * 1024,           // 总大小 ≥ 10 KB
    windowMs: 5 * 60 * 1000,       // 观察窗：5 分钟
    maxGrowthRate: 0.30,           // 窗内新增速度 < 30%
    maxChangedRatio: 0.20,         // 窗内变动占比 < 20%
    // 认知库里的**插件自己产物**：算 readiness 时不计数、不读、事件也不计入窗内新增/变动。
    // 它们是插件写的动态文件（状态文件、状态页），不是"认知"；否则插件自己能把门槛顶高。
    // 相对认知库（libs.review）；**只影响 readiness，不影响变更账**（变更账仍记它们，
    // 客户端判"工作区变没变"用的是变更账，两者不是一回事）。
    ignore: ['milieu-state.json', 'STATE.md'],
  },

  // ---- 判据：会话指纹保留策略（core/criteria.js 的 planFingerprintRetention） ----
  fingerprint: {
    keepDays: 1,                   // 最近 1 天
    keepRecent: 5,                 // ∪ 最近 5 条
  },

  // ---- 台账：事件流有界（core/changes.js 的 boundEvents） ----
  eventKeepDays: 30,               // 保留最近 30 天
  eventKeepCount: 500,             // ∪ 最近 500 条

  // ---- 视图：超过这么久没用 → 只给文件名（core/views.js） ----
  staleDays: 30,
  staleMaxReview: 20,              // 认知库最多列 20 条，超过写"改动过大"

  // ---- 客户端（client.js / ui/card-criteria.js） ----
  clientMemoryLimit: 20,           // 客户端记住"弹过"的会话数
  pollMs: 2000,                    // 盯当前会话的轮询间隔
  readTimeoutMs: 4000,             // 读状态文件的超时
  debug: false,                    // 客户端在 turnTail 里渲染一行自报状态（排查用，平时关）

  // ---- 宿主（index.js） ----
  agentLoopWaitMs: 10000,          // 等 agentLoop 的兜底尝试
};

/**
 * 把覆盖值叠到基准上（只深合并 `readiness` / `fingerprint` 两组）。
 * **坏输入不抛**：不是对象的覆盖值直接忽略。
 */
export function mergeCriteria(base = DEFAULT_CRITERIA, override = {}) {
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base : DEFAULT_CRITERIA;
  const o = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
  return {
    ...b,
    ...o,
    readiness: { ...(b.readiness || {}), ...(o.readiness || {}) },
    fingerprint: { ...(b.fingerprint || {}), ...(o.fingerprint || {}) },
  };
}
