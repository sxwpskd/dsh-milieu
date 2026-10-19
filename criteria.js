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
// 字段分四组：
//   判据（core.js）       structuralThreshold / contentThreshold / staleHintDays / promptThresholdMs / readiness / fingerprint
//   台账（changes.js）    eventKeepDays / eventKeepCount
//   视图（views.js）      staleDays / staleMaxReview
//   客户端 / 宿主         clientMemoryLimit / pollMs / readTimeoutMs / agentLoopWaitMs
export const DEFAULT_CRITERIA = {
  // ---- 判据：要不要"再读一遍"（core.js） ----
  structuralThreshold: 1,          // 新增/消失几个就重读
  contentThreshold: 5,             // 改动几个就重读
  staleHintDays: 30,               // 距上次阅读超过这么多天 → 只提示，不重读
  promptThresholdMs: 5 * 60 * 1000, // 距这条会话最后活动 ≥ 5 分钟才弹卡

  // ---- 判据：认知库"建立完成"的门槛（core.js 的 evaluateReadiness） ----
  readiness: {
    minFiles: 10,                  // 文件数 ≥ 10
    minBytes: 10 * 1024,           // 总大小 ≥ 10 KB
    windowMs: 5 * 60 * 1000,       // 观察窗：5 分钟
    maxGrowthRate: 0.30,           // 窗内新增速度 < 30%
    maxChangedRatio: 0.20,         // 窗内变动占比 < 20%
  },

  // ---- 判据：会话指纹保留策略（core.js 的 planFingerprintRetention） ----
  fingerprint: {
    keepDays: 1,                   // 最近 1 天
    keepRecent: 5,                 // ∪ 最近 5 条
  },

  // ---- 台账：事件流有界（changes.js 的 boundEvents） ----
  eventKeepDays: 30,               // 保留最近 30 天
  eventKeepCount: 500,             // ∪ 最近 500 条

  // ---- 视图：超过这么久没用 → 只给文件名（views.js） ----
  staleDays: 30,
  staleMaxReview: 20,              // 认知库最多列 20 条，超过写"改动过大"

  // ---- 客户端（client.js / client-core.js） ----
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
