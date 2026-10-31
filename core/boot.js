// dsh-milieu —— 宿主半边的**启动流程**（核心层：不写宿主服务名、不 import 'node:fs'、不渲染界面）
//
// 它是从 `index.js` 的 `apply()` 搬出来的业务主体（ARCHITECTURE.md §6.3）：
//   ① 注册状态页 section（同步；注入文本惰性读）；
//   ② 定工作区根（配置 > 平台工作区表 > cwd 兜底）；
//   ③ 启动序列：挂日志文件 sink → 写协议 → 生成状态文件 → 刷新注入页材料段 → 安排预加载会话；
//   ④ 拆解：把注册、计时器、fiber、agent 的清理交给框架。
//
// 日志（task-7 / LOG-SCHEMA.md v2）：
//   · 关键事件用 `log.event(...)` 写结构化记录（`boot.start` / `boot.ready` / `protocol.sync(.failed)`
//     / `state.generate(.failed)` / `state.page.refresh|skip` / `preload.create|skip|failed` / `error.caught`）；
//   · 失败记录带稳定错误码（`exception/codes.js`）与 `blockedBy`；
//   · **正常路径不逐文件刷**：一条记录代表一步，文件明细进 data/诊断文件；
//   · 文件 sink 在**工作区根确定之后**才挂（启动早期没有工作区根）；挂载失败只报告，不影响主流程。
//
// 分层（ARCHITECTURE.md §4.2）：入口建 `host` / `fs` / `log` 三个能力对象传进来；
// 本文件只调能力名（`host.systemPrompt` / `host.workspace` / …），**一个宿主服务名都不写**。
//
// 设计纪律（框架 + 官方规范）：
//   · 注册放进 `ctx.effect`，返回清理函数；
//   · **不假设 API 存在**：查不到就跳过/报告，绝不抛错影响宿主启动；
//   · **内容没变不重发 / 不重写**（指纹），省 token、少动用户文件；
//   · 超预算**跳过**，不静默截断；
//   · 写入**失败就报告**（不搞兜底机制）。
import { join, resolve } from 'node:path';
import { withDefaults } from '../config/defaults.js';
import { DEFAULT_TEXTS } from './texts.js';
import { pickWorkspaceRoot } from './root.js';
import { syncProtocol } from './protocol.js';
import { generateState, writeStateFile, summarize } from './state-generator.js';
import { ensureStatePage, refreshStatePage } from './state-page.js';
import { preloadSession } from './preload.js';
import { guardSync } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';
import { workspaceKey } from '../utils/path.js';

/** 兜底 order：拿不到官方分区顺序时用（数值只求稳定，不求精确）。 */
const FALLBACK_ORDER = 500;

/** 状态页的 order（定义已经在工作区的 AGENTS.md 里，不在这里排）。 */
const ORDER_STATE = 500;

/**
 * guard 用的日志口：guard 的文案不带前缀，由这里补 `[milieu] `（与旧日志逐字对齐）。
 * @param {{info:Function, warn:Function}|null} log
 */
function guardLogOf(log) {
  if (!log) return null;
  return {
    info: (message) => log.info('[milieu] ' + message),
    warn: (message) => log.warn('[milieu] ' + message),
  };
}

/** 安全地写一条事件日志（日志自己坏了也不能反噬主流程）。 */
function emit(log, event, message, fields) {
  try {
    if (log && typeof log.event === 'function') return log.event(event, message, fields || {});
  } catch { /* 日志通道坏了：主流程照旧 */ }
  return null;
}

/** 从失败结果里取"可携带的 cause"（只带 Error，别的放 reason 里已经够了）。 */
function causeOf(result) {
  return result && result.cause instanceof Error ? result.cause : undefined;
}

/**
 * 取要注入的**状态页**文本；返回 '' 表示"这次不注入（没页 / 没变 / 根还没解析出来）"。
 *
 * 异常边界（task-5）：注入是**装饰**，fail-open——拼装抛错就返回 ''（跳过这一轮），
 *   只记 info，不中断主流程、不把异常抛进宿主的提示词拼装。
 */
function composeSection(cfg, lastSent, root, fs, guardLog) {
  const composed = guardSync('拼装状态页注入文本', () => composeSectionInner(cfg, lastSent, root, fs), {
    optional: true,
    log: guardLog,
    code: CODES.STATE_INJECT_FAILED,
    blockedBy: 'fs',
  });
  return typeof composed === 'string' ? composed : '';
}

/** 状态页注入文本的内部实现（失败返回 ''，不抛）。 */
function composeSectionInner(cfg, lastSent, root, fs) {
  if (!cfg.injectState) return '';
  if (!root) return ''; // 根还没解析出来：不按 cwd 瞎猜，这一轮不注入
  const file = join(root, cfg.libs.review, cfg.statePath);

  let stat;
  try {
    stat = fs.stat(file);
  } catch {
    return ''; // 没有那一页：不是错误，是尚未生成
  }
  const budget = cfg.injectBudgetKiB * 1024;
  if (stat.size > budget) return ''; // 超预算跳过，不截断

  const fingerprint = stat.mtimeMs + ':' + stat.size;
  if (lastSent.get(file) === fingerprint) return ''; // 内容没变 → 不重发
  lastSent.set(file, fingerprint);

  let text;
  try {
    text = fs.readText(file);
  } catch {
    return '';
  }

  return [
    '<system-reminder>',
    '# 工作区状态（dsh-milieu 注入）',
    '',
    '这是 ' + root + ' 的工作区状态。它分两半：**"我的判断"由 agent 写，"材料"由脚本扫出**。以本份为准；细节仍按索引去取。',
    '',
    neutralize(text),
    '</system-reminder>',
  ].join('\n');
}

/**
 * 把注入正文里可能出现的 `</system-reminder>` 打断——否则那段文本会**提前把注入闭合**，
 * 后面的正文就跑到提示词正文里去了（静默，不报错）。
 * 两半都要过这一道（2026-10-14 的自测当场抓到"只做了定义层那一半"）。
 */
function neutralize(text) {
  return String(text).replace(/<\/system-reminder>/gi, '<\\/system-reminder>');
}

/**
 * 把协议**写进工作区**（宿主半边的唯一写动作），失败如实报告。
 *
 * 日志事件：`protocol.sync` / `protocol.sync.failed` 各一条（不逐文件刷；明细在 data）。
 */
function syncProtocolToWorkspace(cfg, root, fs, log) {
  const wk = root ? workspaceKey(root) : null;
  try {
    if (!root) return { ok: false, reason: '没有工作区根', wrote: [], changed: false };
    const result = syncProtocol({ root, libs: cfg.libs, ensureLibs: cfg.ensureLibs !== false, fs });
    if (!result.ok) {
      emit(log, 'protocol.sync.failed', '[milieu] 协议没能写进工作区：' + result.reason, {
        ok: false,
        code: result.code || CODES.PROTOCOL_WRITE_FAILED,
        blockedBy: result.blockedBy || 'protocol',
        workspaceKey: wk,
      });
    } else {
      emit(log, 'protocol.sync',
        result.changed
          ? '[milieu] 协议已写进工作区：' + result.wrote.join('、')
          : '[milieu] ' + result.reason,
        {
          ok: true,
          workspaceKey: wk,
          data: { changed: !!result.changed, wrote: result.wrote.length },
        });
    }
    return result;
  } catch (err) {
    const reason = String((err && err.message) || err);
    emit(log, 'protocol.sync.failed', '[milieu] 协议同步抛错：' + reason, {
      ok: false,
      code: CODES.PROTOCOL_WRITE_FAILED,
      blockedBy: 'protocol',
      workspaceKey: wk,
      error: err instanceof Error ? err : undefined,
    });
    return { ok: false, reason, wrote: [], changed: false };
  }
}

/**
 * **自动生成状态文件**（需求 R5 的地基；2026-10-16 加）。
 *
 * 为什么必须有这一步：客户端判"工作区变没变"读的是状态文件，**它太旧就永远不提示**。
 * 所以会话开场扫一次：工作区真变了 → 重算、写状态文件；没变 → 不写。
 *
 * **失败只报告，不兜底、不炸宿主**（清单还没跑过是常见情形，不是错误）。
 * 日志事件：`state.generate` / `state.generate.failed` 各一条。
 */
function refreshStateFile(cfg, root, fs, log) {
  const wk = root ? workspaceKey(root) : null;
  try {
    if (!root) return { ok: false, reason: '没有工作区根' };
    // `ensureLibs=false` 时不许为了写状态文件去造认知库目录（R3 的配置边界）。
    if (cfg.ensureLibs === false && !fs.exists(join(root, cfg.libs.review))) {
      // 这是**配置边界导致的正常跳过**：不是失败，不写错误日志（summary 行会说明）。
      return { ok: false, skipped: true, reason: '认知库目录不在（ensureLibs=false）' };
    }
    const report = generateState({ root, now: Date.now(), criteria: cfg.criteria, fs });
    if (!report.ok) {
      // **清单还没跑过**是装机后第一次的正常状态，不是错误 → 记 info；其余才算 error。
      const isFirstBoot = String(report.reason || '').includes('清单不存在');
      if (isFirstBoot) {
        emit(log, 'state.generate', '[milieu] 状态文件先不生成（' + report.reason + '）', {
          ok: true, workspaceKey: wk, data: { firstBoot: true },
        });
      } else {
        emit(log, 'state.generate.failed', '[milieu] 状态文件没能生成：' + report.reason, {
          ok: false,
          code: report.code || CODES.STATE_SCAN_FAILED,
          blockedBy: report.blockedBy || 'state',
          workspaceKey: wk,
        });
      }
      return { ok: false, reason: report.reason, firstBoot: isFirstBoot };
    }
    const written = writeStateFile(report, { fs });
    if (!written.ok) {
      emit(log, 'state.generate.failed', '[milieu] 状态文件写入失败：' + written.reason, {
        ok: false,
        code: written.code || CODES.STATE_WRITE_FAILED,
        blockedBy: written.blockedBy || 'fs',
        workspaceKey: wk,
      });
      return { ok: false, reason: written.reason };
    }
    emit(log, 'state.generate', '[milieu] ' + summarize(report), {
      ok: true,
      workspaceKey: wk,
      data: { fresh: report.fresh, bounded: report.bounded, firstRun: !!report.firstRun },
    });
    return { ok: true, reason: summarize(report), state: report.state };
  } catch (err) {
    const reason = String((err && err.message) || err);
    emit(log, 'state.generate.failed', '[milieu] 状态文件生成抛错：' + reason, {
      ok: false,
      code: CODES.STATE_SCAN_FAILED,
      blockedBy: 'state',
      workspaceKey: wk,
      error: err instanceof Error ? err : undefined,
    });
    return { ok: false, reason };
  }
}

/**
 * **刷新注入页的材料段**（需求 R5 的"让 AI 每轮看到当前状态"；2026-10-18 主人要求）。
 *
 * 为什么：注入的那一页（`STATE.md`）以前只有**手动跑 summary.js** 才更新，注入的永远是旧内容。
 * 这里让启动时顺手刷新——**只动标记以下**，判断段一字不动。失败只报告（fail-open）。
 * 日志事件：`state.page.refresh`（真的刷新了）/ `state.page.skip`（debug，跳过了）。
 */
function refreshPage(cfg, stateRun, root, fs, log) {
  const wk = root ? workspaceKey(root) : null;
  try {
    if (!root) return { ok: false, changed: false, reason: '没有工作区根' };
    // `ensureLibs=false` 时不许为了建骨架去造库目录（R3 的配置边界）。
    if (!fs.exists(join(root, cfg.libs.review))) {
      const reason = '认知库目录不在（ensureLibs=false）';
      emit(log, 'state.page.skip', '[milieu] 注入页未动：' + reason, { ok: false, workspaceKey: wk });
      return { ok: false, changed: false, reason };
    }
    const statePath = join(cfg.libs.review, cfg.statePath);
    // **首装没有这一页就建骨架**：否则状态页注入在全新工作区里永远不工作。
    if (cfg.injectState) {
      const ensured = ensureStatePage({ root, statePath, fs });
      if (ensured.created) log.info('[milieu] 注入页骨架已建：' + statePath);
    }
    const result = refreshStatePage({
      root,
      libs: cfg.libs,
      statePath,
      state: (stateRun && stateRun.state) || null,
      now: Date.now(),
      fs,
    });
    if (result.ok && result.changed) {
      emit(log, 'state.page.refresh', '[milieu] 注入页材料段已刷新：' + cfg.libs.review + '/' + cfg.statePath, {
        ok: true, workspaceKey: wk,
      });
    } else if (!result.ok) {
      // 页面没有标记 / 读不到：装饰步骤跳过（debug；控制台默认不显示）。
      emit(log, 'state.page.skip', '[milieu] 注入页未动：' + result.reason, { ok: false, workspaceKey: wk });
    }
    return result;
  } catch (err) {
    const reason = String((err && err.message) || err);
    emit(log, 'state.page.skip', '[milieu] 注入页刷新抛错（已跳过）：' + reason, {
      ok: false, workspaceKey: wk, error: err instanceof Error ? err : undefined,
    });
    return { ok: false, changed: false, reason };
  }
}

/**
 * 宿主半边启动流程（对外入口）。
 *
 * 异常边界（task-5）：**装配类**的意外异常在入口收掉——归一、报一次、返回空清理函数，
 *   **不让异常抛给宿主**（激活期抛错会被平台算成致命加载失败）。
 *   正常的业务失败仍由各步骤返回 `{ok:false, reason}`，行为与文案不变（fail-closed，不假装成功）。
 *
 * @param {object} o
 *   · host 宿主能力（`adapter/dsh.js` 的 `createDsh(ctx)`）
 *   · fs   文件系统能力（`adapter/fs.js` 的 `createFs()`）
 *   · log  日志（`log/logger.js` 的新形态 logger；由入口绑定 bootId/side/sinks）
 *   · config 补丁层给的配置（可能缺字段）
 *   · attachFileSink `(root) => void`：工作区根确定后挂宿主文件日志 sink（由入口提供）
 * @returns {Function} 框架用的清理函数（来自 `ctx.effect`）
 */
export function boot({ host, fs, log, config, attachFileSink } = {}) {
  const started = guardSync('宿主启动流程', () => bootInner({ host, fs, log, config, attachFileSink }), {
    optional: false,
    log: null, // 由下面用结构化事件报一次（error.caught）
    code: CODES.HOST_CALL_FAILED,
    blockedBy: 'host',
  });
  if (started && started.ok === false) {
    emit(log, 'error.caught', '[milieu] 启动流程失败：' + started.reason, {
      level: 'error',
      ok: false,
      code: started.code,
      blockedBy: started.blockedBy,
      error: causeOf(started),
    });
    return () => {};
  }
  return started;
}

/**
 * 启动流程的内部实现（业务主体；`boot` 负责收掉意外异常）。
 * @param {object} o 同 `boot`
 * @returns {Function|undefined} `host.effect` 交还的清理函数
 */
function bootInner({ host, fs, log, config, attachFileSink } = {}) {
  const cfg = withDefaults(config);
  // `texts` 是函数，不能放 config/（反向依赖 core/）——在这里合并默认模板。
  if (!cfg.texts) cfg.texts = DEFAULT_TEXTS;
  const lastSent = new Map();
  const warn = (message) => log.warn('[milieu] ' + message);
  const guardLog = guardLogOf(log);

  /**
   * 注册进宿主 `ctx.effect` 的主体（注册 section、起 timer、安排预加载、返回清理函数）。
   * **单独拆出来再包一层边界**（见下）：即使宿主把 effect 主体推迟执行，主体里的意外异常
   * 也不能变成宿主侧的未捕获错误——归一、报一次、交还空清理函数。
   */
  function effectBody() {
    const disposers = [];
    let registered = 0;

    /**
     * 注册一个 section。**注册不上不许掀翻宿主**：如实报告，继续。
     * `orderName` 是问官方要"这个分区该排第几"用的名字；拿不到就用兜底 order。
     */
    const registerSection = (name, orderName, fallbackOrder, compose) => {
      const order = host.systemPrompt.orderOf(orderName, fallbackOrder);
      const result = host.systemPrompt.section({ name, order, text: compose });
      if (!result || !result.ok) throw new Error((result && result.reason) || '宿主拒绝注册扩展点');
      const disposer = result.value;
      // 官方 JSDoc 说可能是函数，也可能是 undefined（没挂 systemPrompt 服务时）
      if (typeof disposer === 'function') disposers.push(disposer);
      else if (disposer && typeof disposer.dispose === 'function') disposers.push(() => disposer.dispose());
      registered += 1;
    };

    // 工作区根：**配置 > 平台工作区表 > cwd**。
    // 别人机器上没有本机路径；空根时由平台告诉我们它管的工作区。
    let root = cfg.workspaceRoot ? resolve(cfg.workspaceRoot) : '';
    let rootSource = cfg.workspaceRoot ? 'config' : '';
    let decided = !!root;
    let started = false;

    // 状态页**先注册**（同步；compose 惰性读 `root`）。定义层不再注入——它已经在工作区的 AGENTS.md 里了。
    if (host.systemPrompt.available()) {
      try {
        registerSection('dsh-milieu:workspace-state', 'MILIEU_WORKSPACE_STATE', ORDER_STATE,
          () => composeSection(cfg, lastSent, root, fs, guardLog));
      } catch (err) {
        warn('状态页注册失败：' + String((err && err.message) || err));
      }
    }

    /** 一切**依赖工作区根**的动作（协议 / 状态账 / 注入页 / 预加载）都在根确定后开始。 */
    const start = () => {
      if (started) return;
      started = true;

      // ⓪ **日志落盘**：工作区根确定之后才挂文件 sink（启动早期没有工作区根）。
      //    挂载失败只是没有文件日志（含 sink 自己内部禁用的情形）——不阻断主流程。
      if (typeof attachFileSink === 'function') {
        guardSync('挂载日志文件 sink', () => attachFileSink(root), {
          optional: true,
          log: guardLog,
          code: CODES.FS_WRITE_FAILED,
          blockedBy: 'fs',
        });
      }
      const startedAt = Date.now();
      const wk = workspaceKey(root);
      emit(log, 'boot.start', '启动检查开始', { workspaceKey: wk });

      // ① **先把协议写进工作区**（声源在这里；写失败就报告，不兜底）。
      const proto = cfg.writeProtocol
        ? syncProtocolToWorkspace(cfg, root, fs, log)
        : { ok: true, changed: false, reason: '配置里关了（writeProtocol=false）', wrote: [] };

      // ② **自动生成状态文件**（会话开场扫一次）——客户端判"变没变"读的就是它。
      //    失败只报告（清单还没跑过是常见情形，不是错误）。
      const stateRun = cfg.autoState
        ? refreshStateFile(cfg, root, fs, log)
        : { ok: true, skipped: true, reason: '配置里关了（autoState=false）' };

      // ②b **顺手刷新注入页的材料段**（首装还会先建骨架）。
      //    只动 `<!-- judgement -->` 以下；判断段一字不动；没标记的页面不碰。
      const pageRun = cfg.autoState
        ? refreshPage(cfg, stateRun, root, fs, log)
        : { ok: false, changed: false, reason: '配置里关了（autoState=false）' };

      // ③ 保证这个工作区**有一条已经读过的预加载会话**（需求 R4 / M5）。
      //
      // 💥 2026-10-18 真机事故：启动期直接建 agent → 宿主崩
      //    （`no agent factory registered (load an agent-loop plugin)` → `fatal load failure`）。
      //    根因：Agent 创建由 `dsh-agent-loop` 的 **AgentLoop 服务**提供，工厂在它的**构造函数**里注册；
      //    我们这一行比它早就绪时，工厂还不存在。
      //
      // ✅ 正解（2026-10-18 查 Cordis 源码后定）：用 **`ctx.inject([...], cb)`**——
      //    "等服务就绪后再执行"。cb 跑的时候 AgentLoop 已经构造过 → 工厂一定在 → 建会话必然可用。
      //    **自动**：一次配置，之后每次启动都自己检查（已有就不再建）。
      if (cfg.preloadSession) {
        let handle = null;
        let cancelled = false;
        let ran = false;
        const run = (subHost) => {
          if (cancelled || ran) return;
          ran = true;
          // 异步边界：preloadSession 自己已包 guardAsync（永不 reject）；这里再收一次"调度时同步抛"。
          const scheduled = guardSync('预加载会话调度', () => preloadSession({
            host: subHost, fs, root,
            libs: cfg.libs, texts: cfg.texts, criteria: cfg.criteria,
          }), {
            optional: false,
            log: null, // 失败由下面的 result 事件报一次（带 code），不在这里重复
            code: CODES.SESSION_CREATE_FAILED,
            blockedBy: 'host',
          });
          void Promise.resolve(scheduled).then((result) => guardSync('预加载会话结果', () => {
            if (cancelled) return;
            if (result && result.handle) handle = result.handle;
            if (result && result.ok) {
              if (result.created) {
                emit(log, 'preload.create', '[milieu] ' + result.reason + '：' + (result.sessionId || '（没有 id）'), {
                  ok: true, workspaceKey: wk, sessionId: result.sessionId, data: { didRead: !!result.didRead },
                });
              } else {
                emit(log, 'preload.skip', '[milieu] ' + result.reason, {
                  ok: true, workspaceKey: wk, sessionId: result.sessionId,
                });
              }
            } else if (result && result.readiness && result.readiness.ready === false) {
              // readiness 不达标是**正常跳过**（不是错误）：info 级，带原因。
              emit(log, 'preload.skip', '[milieu] ' + (result.reason || '认知库没到预加载门槛'), {
                ok: false, workspaceKey: wk, data: { reason: 'readiness' },
              });
            } else if (result && result.code) {
              // 边界归一出来的意外失败（guard 已捕获，这里只报一次结构化记录）。
              emit(log, 'error.caught', '[milieu] 预加载会话意外失败：' + String(result.reason || '未知原因'), {
                level: 'error',
                ok: false,
                code: result.code,
                blockedBy: result.blockedBy,
                workspaceKey: wk,
                sessionId: result.sessionId,
                error: causeOf(result),
              });
            } else {
              emit(log, 'preload.failed', '[milieu] 预加载会话没能建起来：' + String((result && result.reason) || '未知原因'), {
                ok: false,
                code: CODES.SESSION_CREATE_FAILED,
                blockedBy: 'session',
                workspaceKey: wk,
                sessionId: result && result.sessionId,
                data: { retryable: !!(result && result.retryable) },
              });
            }
          }, { optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED }))
            .catch((err) => guardSync('预加载会话异常', () => {
              emit(log, 'error.caught', '[milieu] 预加载会话抛错：' + String((err && err.message) || err), {
                level: 'error', ok: false, code: CODES.SESSION_CREATE_FAILED, blockedBy: 'session',
                workspaceKey: wk, error: err instanceof Error ? err : undefined,
              });
            }, { optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED }));
        };
        let fiber = null;
        let fallbackTimer = null;
        try {
          if (host.canInject()) {
            // 宿主回调里**不许抛**：回调抛错会变成宿主侧的错误（可能是致命的），这里收一次。
            fiber = host.awaitPreload((subHost) => guardSync('预加载调度回调', () => run(subHost), {
              optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED, blockedBy: 'host',
            }));
          } else {
            warn(host.labels.noInject);
          }
          // **兜底**：若服务始终没就绪（某些组合里会话服务是懒实例化的），
          //   10 秒后用父 ctx 再试一次——attach/unarchive 不依赖工厂，只有起 agent 才需要。
          //   失败只会写进 `.dsh-milieu/preload.json`，不会崩（定时器回调里，不在加载期）。
          fallbackTimer = setTimeout(() => guardSync('预加载兜底定时器', () => { if (!ran) run(host); }, {
            optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED, blockedBy: 'host',
          }), cfg.criteria.agentLoopWaitMs);
        } catch (err) {
          warn(host.labels.waitSessionFailed + '：' + String((err && err.message) || err));
        }
        disposers.push(() => {
          cancelled = true;
          if (fallbackTimer !== null) clearTimeout(fallbackTimer);
          try { if (fiber && typeof fiber.dispose === 'function') fiber.dispose(); } catch { /* 释放失败不吞宿主 */ }
          if (handle && typeof handle.dispose === 'function') {
            try { Promise.resolve(handle.dispose()).catch(() => { /* 同上 */ }); } catch { /* 同上 */ }
          }
        });
      }

      // ④ 启动时如实报告处境：**注册上了几个扩展点、协议写没写进去，绝不假装成功**
      //    这一条同时是 `boot.ready` 事件（结构化字段进文件；人话保持旧日志文本不变）。
      const where = registered > 0
        ? '已注册 ' + registered + ' 个扩展点（' + host.labels.extensionPoints + '）'
        : '没有任何扩展点可用（将不注入状态页）';
      const ok = !(proto && proto.ok === false)
        && !(cfg.autoState && stateRun && stateRun.ok === false && !stateRun.firstBoot && !stateRun.skipped);
      emit(log, 'boot.ready',
        '[milieu] 工作区=' + root + '（' + rootSource + '），三库=' + cfg.libs.review + '/' + cfg.libs.tools + '/' + cfg.libs.external +
        '，状态文件=' + cfg.statePath +
        '，协议写入工作区=' + (cfg.writeProtocol ? (proto.ok ? (proto.changed ? '已同步' : '已是最新') : '失败：' + proto.reason) : '关') +
        '，状态文件=' + (cfg.autoState ? (stateRun.ok ? '已生成' : (stateRun.firstBoot ? '等清单' : '失败：' + stateRun.reason)) : '关') +
        '，注入页=' + (pageRun.ok ? (pageRun.changed ? '已刷新' : '已是最新') : '未动（' + pageRun.reason + '）') +
        '，预加载会话=' + (cfg.preloadSession ? '开' : '关') +
        '，' + where,
        {
          ok,
          workspaceKey: wk,
          durationMs: Date.now() - startedAt,
          data: {
            protocol: cfg.writeProtocol ? (proto.ok ? (proto.changed ? 'synced' : 'latest') : 'failed') : 'off',
            state: cfg.autoState ? (stateRun.ok ? 'ok' : (stateRun.firstBoot ? 'first-boot' : (stateRun.skipped ? 'skipped' : 'failed'))) : 'off',
            page: pageRun.ok ? (pageRun.changed ? 'refreshed' : 'unchanged') : 'skipped',
            preload: cfg.preloadSession ? 'on' : 'off',
            extensionPoints: registered,
          },
        });
    };

    /** 启动序列的安全壳：意外异常归一成 error.caught（不抛进宿主）。 */
    const startSafely = () => {
      const result = guardSync('启动序列', start, {
        optional: false, log: null, code: CODES.HOST_CALL_FAILED, blockedBy: 'host',
      });
      if (result && result.ok === false) {
        emit(log, 'error.caught', '[milieu] 启动序列失败：' + result.reason, {
          level: 'error', ok: false, code: result.code, blockedBy: result.blockedBy, error: causeOf(result),
        });
      }
      return result;
    };

    // 根从哪来：配置直接有 → 同步做；没有 → 问平台（`WorkspaceRegistry.list()` 是同步缓存读）。
    if (root) {
      startSafely();
    } else {
      let fiber = null;
      let timer = null;
      /** 定下工作区根（**只定一次**）；异常在这里收掉，不让它抛进宿主回调/定时器。 */
      const settle = (picked, source) => guardSync('确定工作区根', () => {
        if (decided) return;
        decided = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (picked) {
          root = picked;
          rootSource = source;
          startSafely();
        } else {
          warn('无法确定工作区：平台里没有工作区（或读不到）；请在配置里设置 workspaceRoot（本次不写任何文件）');
        }
      }, { optional: false, log: guardLog, code: CODES.HOST_CALL_FAILED, blockedBy: 'host' });
      try {
        if (host.canInject()) {
          fiber = host.awaitWorkspace((subHost) => guardSync('读取平台工作区表', () => {
            const listed = subHost.workspace.listPaths();
            settle(listed && listed.ok ? pickWorkspaceRoot(listed.value, host.cwd()) : null, 'registry');
          }, { optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED, blockedBy: 'host' }));
        }
      } catch (err) {
        warn(host.labels.waitWorkspaceFailed + '：' + String((err && err.message) || err));
      }
      // 平台没有这个服务（例如 headless）→ 2 秒后按 cwd；registry 已说"说不清"时不会走到这里。
      timer = setTimeout(() => guardSync('工作区根兜底定时器', () => {
        timer = null;
        settle(resolve(host.cwd()), 'cwd');
      }, { optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED, blockedBy: 'host' }), 2000);
      if (timer && typeof timer.unref === 'function') timer.unref();
      disposers.push(() => {
        if (timer) clearTimeout(timer);
        try { if (fiber && typeof fiber.dispose === 'function') fiber.dispose(); } catch { /* 释放失败不吞宿主 */ }
      });
    }

    return () => {
      for (const disposer of disposers) {
        guardSync('清理资源', disposer, {
          optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED, blockedBy: 'host',
        });
      }
    };
  }

  // 把主体交给宿主的 effect 生命周期；主体崩了不把异常抛给宿主（结构化事件已报过，不假装成功）。
  return host.effect(() => {
    const cleaned = guardSync('启动 effect 主体', () => effectBody(), {
      optional: false, log: null, code: CODES.HOST_CALL_FAILED, blockedBy: 'host',
    });
    if (cleaned && cleaned.ok === false) {
      emit(log, 'error.caught', '[milieu] 启动 effect 主体失败：' + cleaned.reason, {
        level: 'error', ok: false, code: cleaned.code, blockedBy: cleaned.blockedBy, error: causeOf(cleaned),
      });
      return () => {};
    }
    return typeof cleaned === 'function' ? cleaned : () => {};
  });
}
