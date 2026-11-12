// dsh-milieu —— **单个工作区实例的启动流程**（核心层：不写宿主服务名、不 import 'node:fs'、不渲染界面）
//
// 它由 `core/workspace-instance.js`（每个工作区一个 child fiber）在装配后调用；
// 一个实例 = 一个 root 的一份 boot：
//   ① 注册状态页 section（同步；注入文本惰性读）；**section 名按工作区唯一化**，文本只给
//      cwd 匹配的会话返回内容（见 `core/section-name.js`，多工作区 A 方案）；
//   ② 定工作区根（配置 > 平台工作区表 > cwd 兜底）；
//   ③ 启动序列：挂日志文件 sink → 写协议 → **首扫工作区**（原始日志 / 状态文件 / 注入页）
//      → 启动工作区监控与预加载监控（长期 effect，共享一条串行队列）；
//   ④ 拆解：把注册、计时器、fiber、两个监控的清理交给框架。
//
// 日志（task-7 / LOG-SCHEMA.md v2）：
//   · 关键事件用 `log.event(...)` 写结构化记录（`boot.start` / `boot.ready` / `protocol.sync(.failed)`
//     / `state.generate(.failed)` / `state.page.refresh|skip` / `error.caught`）；
//   · 预加载的 `preload.create|skip|failed` 由 `core/preload-monitor.js` 在**状态变化**时写；
//   · 工作区改动的 `state.generate` 由 `core/workspace-monitor.js` 只在"有变化/首轮/失败"时写
//     （稳定态每 60 秒的扫描**不写日志**）；
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
//   · **内容没变不重发 / 不重写**（指纹），省 token、少动用户文件；**没变化不写状态文件**；
//   · 超预算**跳过**，不静默截断；
//   · 写入**失败就报告**（不搞兜底机制）。
import { join, resolve } from 'node:path';
import { withDefaults } from '../config/defaults.js';
import { DEFAULT_TEXTS } from './texts.js';
import { pickWorkspaceRoot } from './root.js';
import { syncProtocol } from './protocol.js';
import { generateState, writeStateFile, summarize } from './state-generator.js';
import { ensureStatePage, refreshStatePage } from './state-page.js';
import { appendChanges } from './change-log.js';
import { createSerialQueue } from './run-queue.js';
import { startPreloadMonitor } from './preload-monitor.js';
import { startWorkspaceMonitor, reportScanResult } from './workspace-monitor.js';
import { guardSync } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';
import { workspaceKey } from '../utils/path.js';
import { workspaceSectionName, sectionMatchesRoot } from './section-name.js';
import { createLedger } from '../uninstall/ledger.js';
import { createTrackedFs, seedKnownArtifacts } from '../uninstall/record.js';

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
 * **扫描一次工作区**（对外导出：boot 首扫、`core/workspace-monitor.js` 的每轮都复用它）。
 *
 * 为什么必须有这一步：客户端判"工作区变没变"读的是状态文件，**它太旧就永远不提示**。
 * 链路（2026-11-02 定）：
 *   generateState（算差量，含 freshEvents）
 *   → **只有首轮或本轮有新事件**才：appendChanges（原始 append-only 日志）→ writeStateFile（状态文件）
 *   → 条件刷新注入页材料段。
 *   **没有变化时一个盘都不碰**——工作区监控每 60 秒扫一次，不能每 60 秒重写状态文件。
 *
 * 纪律：失败只报告、不兜底、不抛；原始日志追加失败**不阻断**状态文件写。
 * 日志不在这里写（由调用方用 `reportScanResult` 统一判定：稳定态不写、失败不静默）。
 *
 * @param {object} cfg 生效配置（withDefaults 之后）
 * @param {string} root 工作区根
 * @param {object} fs 文件系统能力（`adapter/fs.js`）
 * @param {object} log 日志（refreshPage 里建骨架/写页面时用；可空）
 * @returns {{ok:boolean, reason:string, summary:string, skipped:boolean, firstBoot:boolean,
 *   firstRun:boolean, freshEvents:Array, changed:boolean, wroteState:boolean,
 *   rawAppend:object|null, page:object|null, state:object|null, workspaceKey:string|null,
 *   code?:string, blockedBy?:string, error?:Error}}
 */
export function scanWorkspaceNow(cfg, root, fs, log, opts = {}) {
  const wk = root ? workspaceKey(root) : null;
  const base = {
    ok: false,
    reason: '',
    summary: '',
    skipped: false,
    firstBoot: false,
    firstRun: false,
    freshEvents: [],
    changed: false,
    wroteState: false,
    rawAppend: null,
    page: null,
    state: null,
    workspaceKey: wk,
  };
  try {
    if (!root) return { ...base, skipped: true, reason: '没有工作区根' };
    // `ensureLibs=false` 时不许为了写状态文件去造认知库目录（R3 的配置边界）。
    if (cfg.ensureLibs === false && !fs.exists(join(root, cfg.libs.review))) {
      // 这是**配置边界导致的正常跳过**：不是失败，不写错误（boot.ready 的 summary 行会说明）。
      return { ...base, skipped: true, reason: '认知库目录不在（ensureLibs=false）' };
    }

    const now = Date.now();
    const report = generateState({ root, now, criteria: cfg.criteria, fs, turnEnd: opts.turnEnd });
    if (!report.ok) {
      // **清单还没跑过**是装机后第一次的正常状态（老路径），不是错误 → 由调用方记 info。
      const isFirstBoot = String(report.reason || '').includes('清单不存在');
      return {
        ...base,
        reason: report.reason,
        firstBoot: isFirstBoot,
        code: report.code,
        blockedBy: report.blockedBy,
      };
    }

    const freshEvents = Array.isArray(report.freshEvents) ? report.freshEvents : [];
    const firstRun = report.firstRun === true;
    const criteriaChanged = report.criteriaChanged === true;
    const turnEndChanged = report.turnEndChanged === true;
    // 判据变了 / 会话 turn 基线变了也要写状态文件（供客户端的悬浮球/卡片读），
    // 但它们不是“工作区变了”，不产生 freshEvents、不额外追加原始日志。
    const changed = firstRun || freshEvents.length > 0 || criteriaChanged || turnEndChanged;
    const summary = summarize(report);

    if (!changed) {
      // **稳定态：不追加原始日志、不写状态文件**（否则每 60 秒写一次）。
      // 唯一的例外是注入页还缺着一页（首装/被删）：补建一次，否则注入永远不工作。
      let page = { ok: true, changed: false, reason: '没有变化，未刷新' };
      const pagePath = join(root, cfg.libs.review, cfg.statePath);
      if (cfg.injectState !== false && !fs.exists(pagePath)) {
        page = refreshPage(cfg, report, root, fs, log);
      }
      return {
        ...base, ok: true, reason: summary, summary, state: report.state, page,
        firstRun: false, freshEvents: [], changed: false,
      };
    }

    // ① 原始 append-only 日志（`.dsh-milieu/changes.jsonl`）。失败只报告，**不阻断**状态写。
    let rawAppend = null;
    try {
      rawAppend = appendChanges({ root, events: freshEvents, fs, now });
    } catch (err) {
      // appendChanges 设计上不抛；这里再收一次，保证"原始日志坏了不拖垮状态文件"。
      rawAppend = {
        ok: false,
        reason: String((err && err.message) || err),
        code: CODES.STATE_WRITE_FAILED,
        blockedBy: 'fs',
      };
    }

    // ② 状态文件（有变化才写）。
    const written = writeStateFile(report, { fs });
    if (!written.ok) {
      return {
        ...base,
        reason: written.reason,
        summary,
        code: written.code,
        blockedBy: written.blockedBy,
        firstRun,
        freshEvents,
        changed: true,
        rawAppend,
      };
    }

    // ③ 注入页材料段（扫描变了才刷；fail-open 在 refreshPage 里）。
    const page = refreshPage(cfg, report, root, fs, log);
    return {
      ...base,
      ok: true,
      reason: summary,
      summary,
      state: report.state,
      firstRun,
      freshEvents,
      changed: true,
      wroteState: true,
      rawAppend,
      page,
    };
  } catch (err) {
    return {
      ...base,
      reason: String((err && err.message) || err),
      code: CODES.STATE_SCAN_FAILED,
      blockedBy: 'state',
      error: err instanceof Error ? err : undefined,
    };
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
    //
    // 多工作区（A 方案 / WORKSPACE-MANAGEMENT.md §4）：
    //   · section 名按工作区**唯一化**（`dsh-milieu:workspace-state:<8位hash>`），否则同包多实例注册重名会抛；
    //   · 文本函数收 `AssembleContext`，用 `context.agent.session.header.cwd` 归一后与 root 比较——
    //     只有**自己工作区的会话**才返回内容；cwd 不匹配 / 没有 agent → ''（裸组装不注入）。
    if (host.systemPrompt.available()) {
      try {
        registerSection(workspaceSectionName(root), 'MILIEU_WORKSPACE_STATE', ORDER_STATE,
          (assembleContext) => (sectionMatchesRoot(assembleContext, root)
            ? composeSection(cfg, lastSent, root, fs, guardLog)
            : ''));
      } catch (err) {
        warn('状态页注册失败：' + String((err && err.message) || err));
      }
    }

    /** 一切**依赖工作区根**的动作（协议 / 状态账 / 注入页 / 预加载）都在根确定后开始。 */
    const start = () => {
      if (started) return;
      started = true;

      // ⓪ **副作用台账 + 日志落盘**：工作区根确定后先建台账，再用**记录版 fs** 包住所有写操作。
      //    台账坏了不能让插件不工作——降级为不记录（撤回时会说“没有台账”）。
      let trackedFs = fs;
      try {
        const ledger = createLedger({ root, fs, plugin: 'dsh-milieu' });
        seedKnownArtifacts({ ledger, fs, root, libs: cfg.libs, statePath: cfg.statePath });
        trackedFs = createTrackedFs({ fs, ledger, root, libs: cfg.libs, statePath: cfg.statePath });
      } catch (err) {
        warn('副作用台账不可用（本次不记录卸载痕迹）：' + String((err && err.message) || err));
      }

      // 日志 sink 也用记录版 fs：这样日志文件本身也在台账里（撤回时一起收）。
      if (typeof attachFileSink === 'function') {
        guardSync('挂载日志文件 sink', () => attachFileSink(root, trackedFs), {
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
        ? syncProtocolToWorkspace(cfg, root, trackedFs, log)
        : { ok: true, changed: false, reason: '配置里关了（writeProtocol=false）', wrote: [] };

      // **串行队列**（一个插件 / 一个工作区一份）：预加载监控与工作区监控都往这里排队，
      // 避免两边同时读-改-写 `milieu-state.json` 时互相覆盖（预加载刚登记的受管会话可能被扫描写回旧表）。
      const serial = createSerialQueue();

      // ② **启动首扫**（客户端判"变没变"读的就是它；之后由工作区监控长期接棒）。
      //    链路见 `scanWorkspaceNow`：有变化才追加原始日志 + 写状态文件 + 刷注入页；
      //    稳定态一个盘都不碰。失败只报告（清单还没跑过是常见情形，不是错误）。
      const stateRun = cfg.autoState
        ? scanWorkspaceNow(cfg, root, trackedFs, log)
        : {
          ok: true, skipped: true, reason: '配置里关了（autoState=false）',
          firstRun: false, freshEvents: [], changed: false, wroteState: false, page: null,
        };
      // 首扫的日志按老行为"如实报一条"；之后每轮扫描由 monitor 只在变化/失败时写。
      if (cfg.autoState) reportScanResult(log, stateRun, { workspaceKey: wk, initial: true });

      // ②b 注入页结果：有变化时已在扫描里刷新；无变化时沿用上次（boot.ready 如实说明）。
      const pageRun = cfg.autoState
        ? (stateRun.page || (stateRun.ok
          ? { ok: true, changed: false, reason: '没有变化，未刷新' }
          : { ok: false, changed: false, reason: '状态扫描失败，未刷新' }))
        : { ok: false, changed: false, reason: '配置里关了（autoState=false）' };

      // ③ **工作区改动监控**（长期 effect：turn/end 去抖 + workspacePollMs 定时兜底）。
      //    只跟 `autoState` 走——**与 `preloadSession` 无关**（预加载关着也要跟踪工作区变化）。
      if (cfg.autoState) {
        let workspaceMonitor = null;
        let pendingTurnEnd = null;
        guardSync('启动工作区监控', () => {
          workspaceMonitor = startWorkspaceMonitor({
            host,
            scan: () => {
              const turnEnd = pendingTurnEnd;
              pendingTurnEnd = null;
              return scanWorkspaceNow(cfg, root, trackedFs, log, { turnEnd });
            },
            onTurnEnd: (turnEnd) => { pendingTurnEnd = turnEnd; },
            criteria: cfg.criteria,
            log,
            enqueue: serial.enqueue,
          });
        }, { optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED, blockedBy: 'host' });
        disposers.push(() => {
          if (workspaceMonitor) {
            try { workspaceMonitor.stop(); } catch { /* 卸载期停止失败不反噬宿主 */ }
            workspaceMonitor = null;
          }
        });
      }

      // ④ 预加载会话：**挂载后的长期 effect**（需求 R4 / M5）——不是"启动时算一次"。
      //
      // 为什么必须等就绪（2026-10-18 真机事故）：启动期直接建 agent → 宿主崩
      //    （`no agent factory registered (load an agent-loop plugin)` → `fatal load failure`）。
      //    根因：Agent 创建由 `dsh-agent-loop` 的 **AgentLoop 服务**提供，工厂在它的**构造函数**里注册；
      //    我们比它早就绪时工厂还不存在。正解：`ctx.inject([...], cb)` —— "等服务就绪后再执行"。
      //
      // 为什么是长期 effect（2026-10-31）：以前算完一次就结束，用户真用了预加载会话之后，
      //    插件要等**下次重启**才发现"该毕业 / 该补一条 / 受管表不是恰好一条"。
      //    现在交给 `core/preload-monitor.js`：初始一次 + `turn/end` 去抖 + 低频定时兜底；
      //    它的日志只在状态变化时写，稳定态不刷屏。它与工作区监控**共享 `serial` 队列**。
      //
      // 兜底保留：某些组合里会话服务是懒实例化的，`ctx.inject` 可能一直不来——
      //    10 秒后（`agentLoopWaitMs`）用父 ctx 启一次；失败只进日志/诊断，不在加载期炸。
      if (cfg.preloadSession) {
        let monitor = null;
        let monitorSource = ''; // 'inject'（服务就绪的正路 ctx）| 'fallback'（父 ctx 兜底）
        let fiber = null;
        let fallbackTimer = null;
        let disposed = false;
        /**
         * 启动监控。**一个工作区一份**，但兜底启动的那份可以被正路替换：
         * 父 ctx 可能拿不到会话服务（兜底只是"服务始终没就绪"时的最后手段），
         * 一旦 `ctx.inject` 的回调真的来了，必须用回调里的 scoped host 重启——
         * 否则"兜底先跑"会把监控锁在一个能力不全的 ctx 上。
         * `guardSync` 收掉"调度时同步抛"：宿主回调 / 定时器里抛错会被平台算成致命加载失败。
         */
        const startMonitor = (subHost, source) => {
          if (disposed || !subHost) return;
          if (monitor) {
            if (source !== 'inject' || monitorSource !== 'fallback') return; // 不重复启动
            const stale = monitor;
            monitor = null;
            monitorSource = '';
            try { stale.stop(); } catch { /* 旧监控停不下来也不能挡住新监控 */ }
          }
          monitor = startPreloadMonitor({
            host: subHost, fs: trackedFs, root,
            libs: cfg.libs, texts: cfg.texts, criteria: cfg.criteria, log,
            enqueue: serial.enqueue, // 与工作区监控串行（避免同时写状态文件）
          });
          monitorSource = source;
        };
        try {
          if (host.canInject()) {
            // 宿主回调里**不许抛**：回调抛错会变成宿主侧的错误（可能是致命的），这里收一次。
            fiber = host.awaitPreload((subHost) => guardSync('预加载监控挂载', () => startMonitor(subHost, 'inject'), {
              optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED, blockedBy: 'host',
            }));
          } else {
            warn(host.labels.noInject);
          }
          // **兜底**：只有服务始终没就绪时才用父 ctx 启一次；正路回调后来仍可替换它。
          //   失败只会写进日志 / `.dsh-milieu/preload.json`，不会崩（定时器回调里，不在加载期）。
          fallbackTimer = setTimeout(() => guardSync('预加载兜底启动', () => {
            if (!monitor) startMonitor(host, 'fallback');
          }, {
            optional: true, log: guardLog, code: CODES.HOST_CALL_FAILED, blockedBy: 'host',
          }), cfg.criteria.agentLoopWaitMs);
          if (fallbackTimer && typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
        } catch (err) {
          warn(host.labels.waitSessionFailed + '：' + String((err && err.message) || err));
        }
        disposers.push(() => {
          disposed = true; // 之后即使 inject 回调才来，也不会再启动一个监控
          if (fallbackTimer !== null) clearTimeout(fallbackTimer);
          try { if (fiber && typeof fiber.dispose === 'function') fiber.dispose(); } catch { /* 释放失败不吞宿主 */ }
          if (monitor) {
            try { monitor.stop(); } catch { /* 卸载期停止失败不反噬宿主 */ }
            monitor = null;
          }
        });
      }

      // ⑤ 启动时如实报告处境：**注册上了几个扩展点、协议写没写进去，绝不假装成功**
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
        '，状态文件=' + (cfg.autoState
          ? (stateRun.ok
            ? (stateRun.wroteState ? '已生成' : '无变化（未写）')
            : (stateRun.skipped ? '跳过（' + stateRun.reason + '）' : (stateRun.firstBoot ? '等清单' : '失败：' + stateRun.reason)))
          : '关') +
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
