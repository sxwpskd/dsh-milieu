// dsh-milieu —— 宿主半边入口（**只装配**；业务在 `core/boot.js` 与 `core/` 其余文件）
//
// 它做三件事，而且只做这三件：
//   ① 声明依赖（Cordis 契约：不声明就访问服务会抛 `cannot get property … without inject`）；
//   ② 创建能力对象：宿主 adapter（**唯一出现宿主服务名的地方**）、文件系统 adapter、日志器；
//   ③ 调 `core/boot.js`，把它的清理函数原样交还宿主（`ctx.effect` 自己交还 disposer）。
//
// 日志（task-7 / LOG-SCHEMA.md v2）：
//   · 入口生成 **bootId**（8 位；宿主每次启动一个）并创建新形态 logger（`side:"host"`）；
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
import { createDsh } from './adapter/dsh.js';
import { createFs } from './adapter/fs.js';
import { createLogger } from './log/logger.js';
import { makeBootId } from './log/schema.js';
import { createFileSink, createDeferredSink } from './log/file-sink.js';
import { boot } from './core/boot.js';
import { guardSync } from './exception/guard.js';
import { CODES } from './exception/codes.js';

/**
 * **依赖声明**（Cordis 契约）：要访问某个服务，必须先在 `inject` 里声明它。
 * 不声明就访问 → `cannot get property … without inject`（2026-10-18 真机踩到）。
 *   · `systemPrompt` —— 注入状态页要用；
 *   · `agents`     —— 建预加载会话要用（`preloadSession` 开着时）。
 * `logger` / `effect` 是 ctx 上的直接属性，不需要声明；
 * 工作区 / 会话控制器只在 `ctx.inject` 回调里用，不在顶层声明。
 */
export const inject = ['systemPrompt', 'agents'];

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
 * 宿主入口。
 * @param {object} ctx Cordis ctx
 * @param {object} rawConfig 补丁层给的配置（`cordis.patch.yml` 的 config）
 * @returns {Function} 清理函数（由 `core/boot.js` 里的 `ctx.effect` 交还）
 */
export function apply(ctx, rawConfig) {
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

  const started = guardSync('插件装配', () => {
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
      log.event('error.caught', '[milieu] 插件装配失败：' + started.reason, {
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
