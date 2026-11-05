// dsh-milieu —— 宿主半边**入口 / 启动器**（读配置、校验、挂工作区实例、即时字段重载）
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
//   · **本文件**：配置入口（Config schema）、规划（`core/workspace-plan.js`）、重复/非法路径拒绝、
//     child 挂载/清理、**即时字段（Volatile）更新后的重载**；
//   · **child 实例**（`core/workspace-instance.js`）：adapters / logger / boot / 监控，一个工作区一份；
//   · 本文件**不建 logger、不跑 boot、不碰工作区文件**。
//
// 配置（task-12 / SETTINGS-UI-PLAN.md §3.1）：
//   · 本模块再导出 `Config`（`config/schema.js`）给 Cordis——Loader 用它在 `apply` 前校验/补默认值；
//   · 即时字段（`preloadSession` / `autoState` / `criteria` / 只读展示的 `workspaces`）是 `.volatile()`：
//     Loader 只改这些字段时不重载插件行，而是发一次 `loader/volatile-update`；
//     启动器收到后**重新规划并重挂 child fiber**（第 1 步接受"保存后实例重载"的语义）；
//   · 普通字段变化仍走 Loader 的常规生命周期（卸载整行 → 重新 `apply`），本文件不接管。
//
// 异常边界（task-5 惯例）：挂载/重载一个 child 失败只报告，不影响其他 child；启动器本身不抛给宿主。
// 清理：返回的清理函数会取消 volatile 监听并 dispose 每个 child fiber（真实宿主里父 fiber 卸载
//   也会递归 dispose，这里显式做一次是为了让离线测试与"手动卸载"路径也走同一条）。
import { planWorkspaces } from './core/workspace-plan.js';
import { workspacePlugin } from './core/workspace-instance.js';
import { plainConfig } from './config/values.js';
import { guardSync } from './exception/guard.js';
import { CODES } from './exception/codes.js';

/** 再导出给 Cordis：Loader 用它校验配置、补默认值、把标记字段解析成 Volatile 引用。 */
export { Config } from './config/schema.js';

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
 * 只用于配置/挂载/重载的"一声报告"——实例日志由各自 child logger 负责。
 * @param {object} ctx
 * @param {'info'|'warn'} level
 * @param {string} message 不含 `[milieu] ` 前缀（这里加）
 */
function reportMessage(ctx, level, message) {
  const text = '[milieu] ' + message;
  try {
    const logger = hostLoggerOf(ctx);
    const fn = logger && logger[level];
    if (typeof fn === 'function') {
      fn.call(logger, text);
      return;
    }
  } catch { /* 宿主 logger 坏了：试控制台 */ }
  try {
    if (typeof console !== 'undefined') {
      const fn = level === 'warn' ? console.warn : (console.info || console.log);
      if (typeof fn === 'function') fn.call(console, text);
    }
  } catch { /* 控制台也没有：只能放弃（不能因此抛给宿主） */ }
}

function reportProblem(ctx, message) {
  reportMessage(ctx, 'warn', message);
}

/** 一句话原因（异常/未知值都别把 String(undefined) 亮出来）。 */
function reasonOf(err) {
  return String((err && err.message) || err || '未知原因');
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
 * @param {object} config 该 Loader 行的配置（经 `Config` 校验；即时字段是 Volatile 引用）
 * @returns {Function} 清理函数：取消 volatile 监听 + dispose 所有 child fiber
 */
export function apply(ctx, config) {
  let disposed = false;
  let reloading = false;
  /** 当前挂载的 child 清理函数（重载/卸载时整体替换）。 */
  let childCleanups = [];

  /** 卸载当前所有 child（幂等；单个清理失败不影响其他）。 */
  const disposeChildren = () => {
    const cleanups = childCleanups;
    childCleanups = [];
    for (const cleanup of cleanups) {
      try {
        const pending = cleanup();
        if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 清理失败不反噬宿主 */ });
      } catch { /* 清理失败不反噬宿主 */ }
    }
  };

  /**
   * 按当前配置规划并挂载 child。
   * @returns {{ok:boolean, mounted:number, reason?:string}}
   */
  const mountChildren = () => {
    // **Volatile 引用先展开成普通值**再规划（task-12；规划器内部也会再展开一次作防御）。
    const plan = planWorkspaces(plainConfig(config));
    if (!plan.ok) {
      return { ok: false, mounted: 0, reason: '工作区配置无效：' + plan.errors.join('；') };
    }
    let mounted = 0;
    for (const child of plan.children) {
      const result = guardSync('挂载工作区实例', () => mountChild(ctx, child.config), {
        optional: false,
        log: null, // 启动器没有 logger；失败用下面一句人话报告
        code: CODES.HOST_CALL_FAILED,
        blockedBy: 'host',
      });
      if (typeof result === 'function') {
        childCleanups.push(result);
        mounted += 1;
      } else if (result && result.ok === false) {
        reportProblem(ctx, '工作区实例挂载失败（' + (child.path || '默认实例') + '）：' + result.reason);
      }
    }
    return { ok: true, mounted };
  };

  const initial = mountChildren();
  if (!initial.ok) reportProblem(ctx, '本次不挂载任何实例：' + initial.reason);

  // ------------------------------------------------------------------
  // 即时字段（Volatile）更新：重新规划并重挂 child fiber。
  // 能收到这个事件，说明 Loader 认出了本行的 Config.volatile 字段；没有 `ctx.on`（离线假 ctx /
  // 非 Cordis 宿主）就静默跳过——不改变普通字段的 Loader 生命周期。
  // ------------------------------------------------------------------
  let listenerDispose = null;
  if (ctx && typeof ctx.on === 'function') {
    try {
      listenerDispose = ctx.on('loader/volatile-update', (changed) => {
        if (disposed || reloading) return;
        reloading = true;
        const paths = Array.isArray(changed) && changed.length ? changed.join('.') : 'volatile';
        try {
          reportMessage(ctx, 'info', '即时配置更新（' + paths + '）：重载工作区实例');
          const reloaded = guardSync('即时配置重载', () => {
            disposeChildren();
            return mountChildren();
          }, {
            optional: false,
            log: null,
            code: CODES.HOST_CALL_FAILED,
            blockedBy: 'host',
          });
          if (!reloaded || reloaded.ok !== true) {
            const reason = reasonOf(reloaded && reloaded.reason);
            reportProblem(ctx, '即时配置重载失败（当前没有工作区实例）：' + reason);
          } else {
            reportMessage(ctx, 'info', '即时配置已生效：挂载 ' + reloaded.mounted + ' 个工作区实例');
          }
        } finally {
          reloading = false;
        }
      });
    } catch (err) {
      reportProblem(ctx, '监听即时配置失败（本次不热更新）：' + reasonOf(err));
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof listenerDispose === 'function') {
      try { listenerDispose(); } catch { /* 取消监听失败不反噬宿主 */ }
      listenerDispose = null;
    }
    disposeChildren();
  };
}
