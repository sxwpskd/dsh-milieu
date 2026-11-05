// dsh-milieu —— 宿主半边**入口 / 启动器**（只做三件事：读配置、校验、挂工作区实例）
//
// A 方案（WORKSPACE-MANAGEMENT.md）：profile 里仍然只有**一个 Loader 行**；
//   这一行读 `workspaces` 列表，用 `ctx.plugin(workspacePlugin, childConfig)` 为每个工作区挂一个
//   **child fiber**。每个 child 只碰自己的 root；用户没配的工作区不建 fiber、不写文件、不弹卡。
//
// 为什么不是多行 profile：DSH 的 client module system 扫到同一个包出现在多个 active Loader 行时
//   会抛 `package … resolves from multiple active Loader sources`（我们的包有 `dsh.client`），
//   所以多实例只能在**一个 Loader 行内**用 Cordis 原生的多 fiber 实现。
//
// 分工（不要混）：
//   · **本文件**：配置规划（`core/workspace-plan.js`）、重复/非法路径拒绝、child 挂载、清理；
//   · **child 实例**（`core/workspace-instance.js`）：adapters / logger / boot / 监控，一个工作区一份；
//   · 本文件**不建 logger、不跑 boot、不碰工作区文件**。
//
// 异常边界（task-5 惯例）：挂载一个 child 失败只报告，不影响其他 child；启动器本身不抛给宿主。
// 清理：返回的清理函数会 dispose 每个 child fiber（真实宿主里父 fiber 卸载也会递归 dispose，
//   这里显式做一次是为了让离线测试与"手动卸载"路径也走同一条）。
import { planWorkspaces } from './core/workspace-plan.js';
import { workspacePlugin } from './core/workspace-instance.js';
import { guardSync } from './exception/guard.js';
import { CODES } from './exception/codes.js';

/** 安全地取宿主 logger（真 ctx 是代理：读未声明属性可能抛）。 */
function hostLoggerOf(ctx) {
  try {
    return (ctx && ctx.logger) || null;
  } catch {
    return null;
  }
}

/**
 * 启动器自己的报告口（**还没有实例 logger**，所以用宿主 logger 原通道，最后退到控制台）。
 * 只用于配置/挂载失败的"一声报告"——实例的日志由各自 child logger 负责。
 */
function reportProblem(ctx, message) {
  const text = '[milieu] ' + message;
  try {
    const logger = hostLoggerOf(ctx);
    if (logger && typeof logger.warn === 'function') {
      logger.warn(text);
      return;
    }
  } catch { /* 宿主 logger 坏了：试控制台 */ }
  try {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(text);
  } catch { /* 控制台也没有：只能放弃（不能因此抛给宿主） */ }
}

/**
 * 把一个 child 配置挂成实例。
 *
 * 真实 Cordis：`ctx.plugin(plugin, config)` 返回 fiber（一个工作区一个 fiber，父 fiber 卸载时递归卸载）。
 * 离线假 ctx / 没有 plugin API 的宿主：**直接调用实例的 apply**（等价于一个实例）——
 * 这是项目"扩展点查不到就降级"的惯例，只在没有 `ctx.plugin` 时使用，有 plugin API 的路径一律走 fiber。
 *
 * @returns {Function} 清理函数（dispose fiber 或调用实例 apply 的清理）
 */
function mountChild(ctx, childConfig) {
  if (ctx && typeof ctx.plugin === 'function') {
    const fiber = ctx.plugin(workspacePlugin, childConfig);
    return () => {
      try {
        if (fiber && typeof fiber.dispose === 'function') {
          const pending = fiber.dispose();
          if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 卸载失败不反噬宿主 */ });
        }
      } catch { /* 卸载失败不反噬宿主（父 fiber 卸载还会再递归一次） */ }
    };
  }
  const cleanup = workspacePlugin.apply(ctx, childConfig);
  return typeof cleanup === 'function' ? cleanup : () => {};
}

/**
 * 宿主入口 / 启动器。
 * @param {object} ctx Cordis ctx
 * @param {object} rawConfig 补丁层给的配置（`cordis.patch.yml` 的 config）
 * @returns {Function} 清理函数：dispose 所有 child fiber
 */
export function apply(ctx, rawConfig) {
  const plan = planWorkspaces(rawConfig);
  if (!plan.ok) {
    // 配置非法：**一个实例都不挂**（不静默去重、不半挂载），如实报告。
    reportProblem(ctx, '工作区配置无效，本次不挂载任何实例：' + plan.errors.join('；'));
    return () => {};
  }

  const cleanups = [];
  for (const child of plan.children) {
    const mounted = guardSync('挂载工作区实例', () => mountChild(ctx, child.config), {
      optional: false,
      log: null, // 启动器没有 logger；失败用下面一句人话报告
      code: CODES.HOST_CALL_FAILED,
      blockedBy: 'host',
    });
    if (typeof mounted === 'function') {
      cleanups.push(mounted);
    } else if (mounted && mounted.ok === false) {
      reportProblem(ctx, '工作区实例挂载失败（' + (child.path || '默认实例') + '）：' + mounted.reason);
    }
  }

  return () => {
    for (const cleanup of cleanups) {
      try {
        const pending = cleanup();
        if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 清理失败不反噬宿主 */ });
      } catch { /* 清理失败不反噬宿主 */ }
    }
  };
}
