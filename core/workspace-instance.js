// dsh-milieu —— **工作区实例（child fiber）入口**（核心层：一个工作区一份，不碰别的 root）
//
// 拆自原 `index.js` 的 `apply()`（2026-11-05 工作区管理 A 方案，WORKSPACE-MANAGEMENT.md）：
//   · `index.js` 是**启动器**：只读 `workspaces` 配置、校验、为每项 `ctx.plugin(...)` 挂一个实例；
//   · 本文件是**实例主体**：承载一个工作区的装配（adapters、logger、boot），每个实例
//     **独立 root / 状态 / 预加载 / 日志 / 监控**，不共享可变状态。
//
// 这个模块导出一个 Cordis **对象插件** `{ name, inject, apply }`：
//   · `inject: ['systemPrompt', 'agents']` —— 依赖声明放在实例这一层，实例 fiber 会等服务就绪才启动；
//   · `apply(ctx, rawConfig)` —— 由启动器经 `ctx.plugin(workspacePlugin, childConfig)` 挂载；
//   · 启动器已经把 childConfig 归一好（顶层默认 + 该工作区覆盖，`workspaceRoot` 固定为该项 path），
//     所以本文件**不再读 `workspaces`**（child config 不递归）。
//
// 日志（task-7 / LOG-SCHEMA.md v2）：
//   · 每个实例生成自己的 **bootId** 并创建新形态 logger（`side:"host"`）；
//   · sinks 两条：① 宿主控制台 sink（把记录还原成**旧日志的可见文本**，控制台行为不变；
//     debug 默认关）；② **延迟挂载的文件 sink**（工作区根要到 boot 里才知道，根定了 boot 才 attach）；
//   · 文件 sink 写不进去时用**宿主 logger 原通道**报告一次（不经过可能已坏掉的日志链）。
//
// 设计纪律：纯 ESM、零依赖、无构建；会随部署变化的值一律走配置（`config/defaults.js` 兜底）；
// 这里**不写业务判断**、不拼协议文本、不读写文件（ARCHITECTURE.md §3.1-5）。
//
// 异常边界（task-5）：装配本身也可能抛（例如宿主 ctx 形状不对）。激活期抛错会被平台算成
//   **致命加载失败**，所以整段装配包在 `guardSync` 里——归一、报一次（结构化 `error.caught`）、
//   返回空清理函数，**不让异常抛给宿主**；同时**不假装成功**。
import { createDsh } from '../adapter/dsh.js';
import { createFs } from '../adapter/fs.js';
import { createLogger } from '../log/logger.js';
import { makeBootId } from '../log/schema.js';
import { createFileSink, createDeferredSink } from '../log/file-sink.js';
import { boot } from './boot.js';
import { guardSync } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';

/** 安全地取宿主 logger（真 ctx 是代理：读未声明属性可能抛）。 */
function hostLoggerOf(ctx) {
  try {
    return (ctx && ctx.logger) || null;
  } catch {
    return null;
  }
}

/**
 * **宿主控制台 sink**：把结构化记录还原成旧日志的可见文本（`record.message` 逐字写过去）。
 *
 * 为什么需要它：新形态 logger 只写 sinks——不接宿主 logger 就没有控制台输出（行为会变）。
 * 为什么只写 message：旧代码 `log.info/warn` 的文案已经带 `[milieu] ` 前缀，结构化字段进文件即可；
 *   `debug` 默认关（LOG-SCHEMA §3）→ 控制台不输出（文件里仍有）。
 */
function hostConsoleSink(hostLogger) {
  return (line, record) => {
    if (!record || typeof record.message !== 'string') return;
    if (record.level === 'debug') return; // 开发细节默认关
    const level = record.level === 'error' ? 'error' : (record.level === 'warn' ? 'warn' : 'info');
    let fn = hostLogger && hostLogger[level];
    // 宿主 logger 不一定有 error 级：主流程失败不能因此静默，退回 warn。
    if (typeof fn !== 'function' && level === 'error' && hostLogger) fn = hostLogger.warn;
    if (typeof fn === 'function') fn.call(hostLogger, record.message);
  };
}

/**
 * 一个工作区实例的装配（供 `workspacePlugin.apply` 调用；也可被离线测试直接调）。
 * @param {object} ctx 实例自己的 Cordis ctx（由 `ctx.plugin` 提供；离线假 ctx 直接传入）
 * @param {object} rawConfig 该实例的已归并配置（启动器负责；含 `workspaceRoot`）
 * @returns {Function} 清理函数（由 `core/boot.js` 里的 `ctx.effect` 交还）
 */
export function applyChild(ctx, rawConfig) {
  const hostLogger = hostLoggerOf(ctx);
  const bootId = makeBootId();
  const fileSink = createDeferredSink();
  const log = createLogger({
    side: 'host',
    bootId,
    module: 'host',
    sinks: [fileSink, hostConsoleSink(hostLogger)],
    hostLogger,
  });

  const started = guardSync('工作区实例装配', () => {
    const host = createDsh(ctx);
    const fs = createFs();
    /**
     * 工作区根确定后才挂文件 sink（启动早期没有工作区根，见 LOG-SCHEMA §6.1）。
     * 报告口用**宿主 logger 原通道**：此时文件日志可能已经坏了，不能再经过日志链。
     */
    const attachFileSink = (root) => fileSink.attach(createFileSink({
      fs,
      root,
      report: (reason) => {
        const message = '[milieu] 日志文件写不进去（已停用文件日志）：' + reason;
        try {
          if (hostLogger && typeof hostLogger.warn === 'function') {
            hostLogger.warn(message);
            return;
          }
        } catch { /* 宿主 logger 也坏了：试控制台 */ }
        try {
          if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(message);
        } catch { /* 控制台也没有：只能放弃（不能影响主流程） */ }
      },
    }));
    return boot({ host, fs, log, config: rawConfig, attachFileSink });
  }, {
    optional: false,
    log: null, // 由下面报一次结构化 error.caught（带 code/blockedBy）
    code: CODES.HOST_CALL_FAILED,
    blockedBy: 'host',
  });

  if (started && started.ok === false) {
    try {
      log.event('error.caught', '[milieu] 工作区实例装配失败：' + started.reason, {
        level: 'error',
        ok: false,
        code: started.code,
        blockedBy: started.blockedBy,
        error: started.cause instanceof Error ? started.cause : undefined,
      });
    } catch { /* 日志不能反噬装配 */ }
    // 装不上时交还一个**空清理函数**（宿主调用它不会炸），失败已报告。
    return () => {};
  }
  return typeof started === 'function' ? started : () => {};
}

/**
 * 工作区实例的 **Cordis 对象插件**：启动器用 `ctx.plugin(workspacePlugin, childConfig)` 挂载。
 *
 * `inject` 声明在本层（而不是启动器）：每个实例 fiber 各自等 `systemPrompt` / `agents` 就绪，
 * 缺服务时停在 PENDING，不会拖住启动器，也不影响其他工作区的实例。
 */
export const workspacePlugin = {
  name: 'dsh-milieu:workspace',
  inject: ['systemPrompt', 'agents'],
  apply: applyChild,
};
