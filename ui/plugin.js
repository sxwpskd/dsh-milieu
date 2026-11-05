// dsh-milieu —— 客户端装配（界面层：注册插槽、盯当前会话、喂判据、处理收场）
//
// 它做四件事，而且**只做这四件**：
//   ① 看住"当前是哪条会话"（`retainedBy.mainView` 计数变了就是切换；插槽也会直接把 sessionId 交进来）；
//   ② 切到**我们管的**那条时，读状态文件、喂判据；
//   ③ 判据说该弹，就把卡片注册进插槽；你点"重读"/"不用"/直接打字，卡片收场；
//   ④ 在 root 的 `shell.overlay` 挂**只读配置浮球**（读状态文件里的生效 criteria，不写配置）。
//
// 分层的落点（ARCHITECTURE.md 工作包 C）——这里只负责"接线"，其余各归各处：
//   · 判据 → `ui/card-criteria.js`（纯函数）；卡片 → `ui/card.js`（只渲染、不读数据）；
//   · 读文件 → `ui/state-reader.js`；当前会话/活动时间 → `ui/activity.js`；发请求 → `ui/remote.js`；
//   · 日志 → `log/logger.js` + `log/memory-sink.js`（客户端只进内存环形缓冲，见 LOG-SCHEMA §6.2）；
//   · **本文件是 UI 层唯一直接接触 `ctx.slots` / `ctx.sessions` 的地方**（remote 也由这里取好传给别的文件）。
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不需要自己装一份。
//
// 官方 UI 硬规矩（照办）：只用主题 token 上色、不 import 任何 Harness 客户端包、
//   不写 DOM、不动 document.body、注册进插槽而不是自己找位置。

import { shouldShowCard, markShown } from './card-criteria.js';
import { MilieuReturnCard } from './card.js';
import { MilieuSettingsBall } from './settings-ball.js';
import { MilieuConfigPage, CONFIG_PAGE_KEY } from './config-page.js';
import { promptReadViaRemote } from './remote.js';
import { createStateReader } from './state-reader.js';
import { currentMainSessionId, sessionActivityAt } from './activity.js';
import { createErrorBoundary } from './error-boundary.js';
import { createLogger } from '../log/logger.js';
import { createMemorySink } from '../log/memory-sink.js';
import { BOOT_ID_RE } from '../log/schema.js';
import { DEFAULT_TEXTS } from '../core/texts.js';
import { parseState } from '../core/state.js';
import { DEFAULT_CRITERIA, mergeCriteria } from '../config/criteria.js';
import { guardSync, guardAsync } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';

/** 我们注册进插槽的卡片 id（同一次会话只应有一个）。 */
const CARD_SLOT_ID = 'dsh-milieu:return-card';

/** 配置浮球的插槽 id（`shell.overlay` 是 root 作用域的页面浮层，不是桌面级窗口）。 */
const SETTINGS_SLOT_ID = 'dsh-milieu:settings-ball';

/**
 * **依赖声明**（客户端 Cordis 契约）：用到的服务/命名空间必须列全，访问未声明的会抛
 * `cannot get property … without inject`。`sessions` 我们一直在用，之前漏了——
 * 离线假 ctx 不检查这个，真机上才会炸（2026-10-18）。
 * 入口（`client.js`）与这里共用同一份，不各写一份。
 */
export const CLIENT_INJECT = ['slots', 'sessions', 'remote', 'remote.workspaceFiles', 'remote.session'];

/**
 * 造客户端插件主体。**导出成函数是为了能离线测**：
 * 测试里传一个假的 ctx（假的 slots / remote / sessions），就能验"接线"对不对，
 * 不用真浏览器、不用真宿主。
 *
 * @param {object} deps { React, ctx, bootId? }
 *   · `bootId` 可选：客户端一般拿不到宿主 bootId；给了合法的（8 位小写字母/数字）就带进日志。
 */
export function createClientPlugin({ React, ctx, bootId }) {
  // 客户端自己记的"这条会话弹过了"——只活在页面里，不进工作区。
  let shownMemory = {};
  // **生效判据**：先默认；每次读到状态文件后按文件里的 `criteria` 更新（宿主写的同一份）。
  let effectiveCriteria = mergeCriteria(DEFAULT_CRITERIA);
  // 每次判断的结果（同一次切换不重复算）
  let current = { sessionId: null, decision: { show: false }, state: null, pending: false };

  // ---- 客户端日志（LOG-SCHEMA §6.2）：只进**内存环形缓冲**（200 条），不写文件、不写工作区 ----
  //   · `side:"client"`；`bootId` 可选（非法形状当没给，免得整条记录校验失败）；
  //   · 旧 `log(level, msg)` 兼容 `info/warn/error`（→ `log.message` 事件），
  //     并**保持原有宿主 logger 输出**（既有可见行为不变）；
  //   · 关键事件（card.* / ui.read.failed / error.caught）走结构化 `clientLogger.event`。
  const memorySink = createMemorySink();
  const clientLogger = createLogger({
    side: 'client',
    bootId: typeof bootId === 'string' && BOOT_ID_RE.test(bootId) ? bootId : undefined,
    module: 'ui.plugin',
    sinks: [memorySink],
  });

  const log = (level, msg) => {
    try {
      const logger = ctx && ctx.logger;
      if (logger && typeof logger[level] === 'function') logger[level]('[milieu] ' + msg);
    } catch {
      /* 宿主 logger 自己坏了：界面不能因为写日志而崩 */
    }
    // 同一句也进客户端内存日志（结构化 `log.message`）；日志层自己保证不抛。
    try {
      if (typeof clientLogger[level] === 'function') clientLogger[level](msg);
    } catch {
      /* 日志不能反噬主流程 */
    }
  };

  /** 结构化事件：只进客户端内存日志（不写工作区、不额外刷宿主日志）。 */
  const logEvent = (name, message, fields) => {
    try { clientLogger.event(name, message, fields); } catch { /* 同上 */ }
  };

  /**
   * guard 用的日志口：guard 的文案不带前缀，由 `log` 补 `[milieu] `。
   * `log` 是 `(level, message)` 函数形状 → guard 支持函数形状的 log 口。
   */
  const guardLog = (level, message) => log(level, message);

  /**
   * 卡片错误边界（fail-open）：卡片渲染崩了只吞掉卡片本身，**不把异常抛进 slot**。
   * 假 React（离线测试）没有 `Component` 时，工厂会退化成直通组件（见 ui/error-boundary.js）。
   */
  const CardBoundary = createErrorBoundary(React, {
    onError: (failure) => log('warn', '卡片渲染失败（已跳过）：' + failure.reason),
  });

  /**
   * 配置浮球的错误边界：浮球/面板渲染崩了只吞掉浮球，**不能把异常抛进 root slot**
   * （root slot 坏了会影响整页，比卡片更严重）。
   */
  const SettingsBoundary = createErrorBoundary(React, {
    onError: (failure) => log('warn', '配置浮球渲染失败（已跳过）：' + failure.reason),
  });

  /**
   * 行配置页的错误边界：配置页是插件管理页里的可选内容，渲染失败只吞页面本体，
   * **不能把插件管理页整块搞白**（fail-open，与浮球同理）。
   */
  const ConfigBoundary = createErrorBoundary(React, {
    onError: (failure) => log('warn', '配置页渲染失败（已跳过）：' + failure.reason),
  });

  /**
   * 取平台会话列表（当前会话 id 与最后活动时间都从它算）。
   * **真环境的 ctx 是代理：读未声明的属性会抛错**，所以包起来读——也不让坏 ctx 把界面搞崩。
   */
  const sessionsOf = () => {
    try { return ctx ? ctx.sessions : undefined; } catch { return undefined; }
  };

  /**
   * 读状态文件：两种签名、`{ok,value}` 拆包、超时都在 state-reader 里；
   * 这里只拿文本，并把"生效判据"交进去（读超时也走判据）。
   */
  const stateReader = createStateReader({
    getRemote: () => { try { return ctx ? ctx.remote : undefined; } catch { return undefined; } },
    getTimeoutMs: () => effectiveCriteria.readTimeoutMs,
    log,
    event: logEvent,
  });

  /**
   * 读状态文件里的**生效判据**，给只读配置浮球用。
   *
   * 为什么读 state 而不是 `cordis.patch.yml`：patch 只是默认/部署层，本机 profile 还有覆盖；
   *   `milieu-state.json.criteria` 才是宿主写出的生效值（客户端卡片也读它）。
   * 只读：这里没有写回通道；写回要接官方 settings / Config schema（W3）。
   */
  async function readSettingsState() {
    const text = await stateReader.read(null);
    if (!text) return { ok: false, reason: '读不到状态文件（宿主可能还没生成）' };
    const parsed = parseState(text);
    if (!parsed) return { ok: false, reason: '状态文件解析失败（内容不是合法的 milieu-state）' };
    return {
      ok: true,
      criteria: mergeCriteria(DEFAULT_CRITERIA, parsed.criteria),
      generatedAt: parsed.generatedAt,
      workspaceKey: parsed.workspaceKey,
      counts: parsed.counts,
    };
  }

  /** 配置浮球视图：数据/错误边界都在这里，slot 只负责挂载。 */
  function SettingsBallView() {
    return React.createElement(SettingsBoundary, null,
      React.createElement(MilieuSettingsBall, { React, readState: readSettingsState }));
  }

  /**
   * 行配置页视图（`plugins.row.config`）：页面宿主传入 `{ t, view, form }`，这里原样转发。
   * 错误边界只包页面本体——配置页坏了不影响插件管理页的其它部分。
   */
  function ConfigPageView(props) {
    return React.createElement(ConfigBoundary, null,
      React.createElement(MilieuConfigPage, { React, ...props }));
  }

  /**
   * 重新判断一次（切换会话或状态变化时调用）。
   *
   * 异常边界（task-5）：判据/读文件是**可选装饰**（fails-open）——意料之外的 throw 归一、
   *   记一条 info、把 `pending` 复位并保持"不弹"，**不让 Promise 拒绝泄漏成 unhandledRejection**。
   */
  async function reevaluate(sessionId) {
    const guarded = await guardAsync('判断是否弹卡', () => reevaluateOnce(sessionId), {
      optional: true,
      log: guardLog,
      code: CODES.UI_READ_FAILED,
      blockedBy: 'ui',
    });
    if (guarded && guarded.ok === false) {
      current = {
        sessionId: sessionId === undefined ? current.sessionId : sessionId,
        decision: { show: false, reason: '判断失败（已跳过）：' + guarded.reason },
        state: current.state,
        pending: false,
      };
      return current;
    }
    return current;
  }

  /** 判断的内部实现（失败分支都返回，不抛）。 */
  async function reevaluateOnce(sessionId) {
    if (!sessionId) { current = { sessionId: null, decision: { show: false }, state: null, pending: false }; return; }
    if (current.pending) return;                       // 不并发读同一件事
    current = { ...current, sessionId, pending: true };
    const text = await stateReader.read(sessionId);
    const parsed = parseState(text);
    const criteria = mergeCriteria(DEFAULT_CRITERIA, parsed && parsed.criteria);
    effectiveCriteria = criteria;
    const decision = shouldShowCard(sessionId, text, shownMemory, {
      now: Date.now(),
      activityAt: sessionActivityAt(sessionsOf(), sessionId),
      criteria,
      thresholdMs: criteria.promptThresholdMs,
    });
    current = { sessionId, decision, state: text, criteria, pending: false };
    log('info', '会话 ' + sessionId + ' → ' + (decision.show ? '该弹卡' : '不弹') + '（' + decision.reason + '）');
    // 结构化事件：卡片出现（LOG-SCHEMA `card.show`）。只进内存日志，不影响判据/渲染。
    if (decision.show) {
      logEvent('card.show', '重读卡片出现', {
        ok: true,
        sessionId,
        data: decision.totals ? { total: decision.totals.total } : undefined,
      });
    }
    bump();                                            // 通知插槽重画
  }

  // ---- 插槽重画：用一个极小的订阅点，避免自己造状态机 ----
  let listeners = new Set();
  /**
   * 插槽重画（异常边界：fail-open）。一个订阅者抛错只跳过它，绝不让异常漏进 React/slot；
   * 可选装饰的失败只记 info（guard 的 optional 模式）。
   */
  const bump = () => {
    for (const fn of [...listeners]) {
      guardSync('插槽重画订阅者', fn, {
        optional: true, log: guardLog, code: CODES.UI_RENDER_FAILED, blockedBy: 'ui',
      });
    }
  };

  /** 卡片组件：插槽渲染它；它**只读**当前判断结果（不写任何状态，保持纯净）。 */
  function ReturnCardView(props) {
    // **订阅 `bump`**：异步 `reevaluate` 完成后要能触发本组件重画；
    // 否则第一次渲染返回 null 之后就再也不会更新（卡片永远不出现）。
    const [, forceRender] = React.useState(0);
    React.useEffect(() => {
      const rerender = () => forceRender((v) => v + 1);
      listeners.add(rerender);
      return () => { listeners.delete(rerender); };
    }, []);

    // 渲染边界（task-5）：整个渲染体里的意外 throw 都**不能漏进 slot**——
    //   归一、记一条 info（可选装饰，fail-open）、这次渲染 null；卡片元素还会再套一层 class 边界。
    const rendered = guardSync('渲染卡片视图', () => renderCardBody(props), {
      optional: true, log: guardLog, code: CODES.UI_RENDER_FAILED, blockedBy: 'ui',
    });
    if (rendered && rendered.ok === false) return null;
    return rendered === undefined ? null : rendered;
  }

  /** ReturnCardView 的渲染体（拆出来是为了整体包边界；返回元素树或 null，不抛）。 */
  function renderCardBody(props) {
    // **插槽是 session 作用域**：它直接把当前会话 id 交给我们（`props.sessionId`），
    // 比 `ctx.sessions.list` 里的 `retainedBy.mainView` 可靠。
    // 没有这个 prop 时，才退回原来的“按主视图计数找当前会话”。
    const slotSessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null;

    // 排查用：`criteria.debug` 为真时，在聊天里渲染一行自报状态（平时关）。
    const debug = !!(effectiveCriteria && effectiveCriteria.debug);
    const debugLine = (d0) => {
      const lr = stateReader.last();
      return React.createElement('div', {
        style: { font: '12px monospace', color: '#c00', border: '1px dashed #c00', padding: '4px', margin: '4px 0' },
      }, '[milieu] client alive | slot=' + String(slotSessionId) + ' | current=' + String(current.sessionId) + ' | show=' + String(!!(d0 && d0.show)) + ' | reason=' + String((d0 && d0.reason) || '') + ' | state=' + (current.state ? 'yes' : 'no') + ' | read=' + (lr.ok ? 'ok via ' + lr.via : lr.reason));
    };

    if (slotSessionId && slotSessionId !== current.sessionId) {
      // 不在渲染里直接做异步副作用：推到微任务；pending 期间不会重复排队。
      // 这个微任务也要有边界：再抛出去就是 unhandledRejection（界面层没有进程级兜底）。
      Promise.resolve().then(() => {
        guardSync('插槽会话切换', () => {
          if (slotSessionId !== current.sessionId) void reevaluate(slotSessionId);
        }, { optional: true, log: guardLog, code: CODES.UI_READ_FAILED, blockedBy: 'ui' });
      });
      return debug ? debugLine(null) : null;
    }

    const d = current.decision;
    if (!d || !d.show) return debug ? debugLine(d) : null;
    /**
     * 卡片本体（task-5 边界）：
     *   ① 先在 `guardSync` 里**造**元素——卡片构造抛错时渲染 null，不把 slot 搞白；
     *   ② 再套一层 React 错误边界——真跑渲染时更深处的错也被接住（class 边界见 ui/error-boundary.js）。
     */
    const card = guardSync('渲染卡片', () => MilieuReturnCard(React, {
      changeIndex: d.changeIndex,
      locale: 'zh',
      onReview: () => guardSync('处理「重读」选择', () => {
        log('info', '你点了"重读"');
        // **点"重读" = 发一次请求**（与用户发请求等价，主人 2026-10-13 定的）。
        // 走**现成的 `session/prompt` Remote**——不用自建 Remote、不用代码生成。
        // 先把要带的东西取下来（收场之后 current 就变了），再异步发：
        //   · changeIndex —— 兜底用的路径清单；
        //   · events      —— **事件流**（两种视图由它算：大小变化 / 只给文件名）；
        //   · activityAt  —— 这条会话的最后活动时间（决定视图 A 还是 B）。
        const changeIndex = d.changeIndex;
        const targetId = current.sessionId;
        const parsed = parseState(current.state);
        const events = parsed ? parsed.events : null;
        const activityAt = sessionActivityAt(sessionsOf(), targetId);
        logEvent('card.review', '用户点了「重读」', { ok: true, sessionId: targetId });
        if (typeof onUserChoice === 'function') onUserChoice('review', targetId);
        dismiss('review');
        void sendRead(targetId, changeIndex, events, activityAt);
      }, { optional: true, log: guardLog, code: CODES.UI_SEND_FAILED, blockedBy: 'ui' }),
      onSkip: () => guardSync('处理「不用」选择', () => {
        log('info', '你点了"不用"');
        logEvent('card.skip', '用户点了「不用」', { ok: true, sessionId: current.sessionId });
        if (typeof onUserChoice === 'function') onUserChoice('skip', current.sessionId);
        dismiss('skip');
      }, { optional: true, log: guardLog, code: CODES.UI_INIT_FAILED, blockedBy: 'ui' }),
      onDismiss: () => guardSync('处理卡片自动关闭', () => {
        log('info', '你直接开始了（卡片自动关闭）');
        logEvent('card.skip', '用户直接开始（卡片自动关闭）', { ok: true, sessionId: current.sessionId });
        dismiss('typed');
      }, { optional: true, log: guardLog, code: CODES.UI_INIT_FAILED, blockedBy: 'ui' }),
    }), { optional: true, log: guardLog, code: CODES.UI_RENDER_FAILED, blockedBy: 'ui' });
    // 卡片构造失败：这次不显示（fail-open），异常已被报告过 → 渲染 null。
    if (card && card.ok === false) return null;
    const bounded = React.createElement(CardBoundary, null, card);
    return debug ? React.createElement('div', null, debugLine(d), bounded) : bounded;
  }

  /**
   * 卡片收场：三种收场（重读 / 不用 / 直接打字）**都要记进"弹过了"**。
   *
   * 两个踩过的坑，都记在这：
   *   ① 只在渲染时记 → "先弹、再收场、再轮询一次"时卡片又回来了；
   *   ② 记在 `current.sessionId` 名下 → 若用户在此期间切过会话，那个 id 已经过期，
   *      于是会记错人、卡片照样回来。**收场是对"用户此刻看的那条"表态**，
   *      所以要按**当下主视图**记（算不出就退回 current）。
   */
  function dismiss(how) {
    const liveId = currentMainSessionId(sessionsOf()) || current.sessionId;
    if (liveId) shownMemory = markShown(shownMemory, liveId, Date.now(), effectiveCriteria.clientMemoryLimit);
    current = { ...current, sessionId: liveId, decision: { show: false, reason: '已收场：' + how } };
    bump();
  }

  // 由 apply 注入的回调（放外面便于测试替换）
  let onUserChoice = null;

  /**
   * 真正发出去：走现成的 `session/prompt` Remote。
   * 这是**最后一段线**——在此之前只把决定报出去、没人发；现在接上了。
   * 失败不静默：写日志，并通过 `onSendResult` 让界面/测试能知道。
   *
   * 异常边界（task-5）：发送是**用户动作**（不是装饰）——意外 throw 归一后**必须**回报
   *   （日志 + onSendResult），不静默、也不抛到点击回调里。
   */
  async function sendRead(sessionId, changeIndex, events, activityAt) {
    const guarded = await guardAsync('发送重读请求', () => sendReadOnce(sessionId, changeIndex, events, activityAt), {
      optional: false,
      log: guardLog,
      code: CODES.UI_SEND_FAILED,
      blockedBy: 'ui',
    });
    if (guarded && guarded.ok === false && guarded.code) {
      // guard 捕获的意外异常：边界已经报过一次；这里只把结果回报给界面/测试，不重复写日志。
      if (typeof onSendResult === 'function') onSendResult(guarded);
    }
    return guarded;
  }

  /** 发送的内部实现（已知失败返回报告，由这里统一写日志 + 回调）。 */
  async function sendReadOnce(sessionId, changeIndex, events, activityAt) {
    const remote = ctx && ctx.remote && ctx.remote.session;
    // 文本是**配置层**的：客户端拿不到插件的 Config，所以用默认那份；
    // 宿主侧（建预加载会话）走平台自己的 prompt 通道，它那份 Config.texts 由 core/preload.js 传。
    // **两种视图**由 events + activityAt 决定（见 core/views.js）：30 天内给大小变化，超过只给文件名。
    const res = await promptReadViaRemote({
      remote, sessionId, kind: 'reread', changeIndex, events, activityAt,
      templates: DEFAULT_TEXTS, criteria: effectiveCriteria, log: guardLog, event: logEvent,
    });
    log(res.ok ? 'info' : 'warn', '重读请求：' + res.reason);
    if (typeof onSendResult === 'function') onSendResult(res);
    return res;
  }
  let onSendResult = null;

  /**
   * 客户端启动的内部实现（注册插槽、起轮询、先判一次；返回清理函数）。
   * `apply` 只做一层边界：启动抛错 → 归一、报一次、返回空清理函数（不把异常抛给界面加载器）。
   */
  function applyInner(pluginCtx) {
      const disposers = [];
      // 允许测试传入自己的动作回调。**真环境的 ctx 是代理：读未声明的属性会抛错**，所以包起来读。
      try { if (pluginCtx && typeof pluginCtx.__onUserChoice === 'function') onUserChoice = pluginCtx.__onUserChoice; } catch { /* 没有就没有 */ }
      try { if (pluginCtx && typeof pluginCtx.__onSendResult === 'function') onSendResult = pluginCtx.__onSendResult; } catch { /* 同上 */ }

      // ① 盯住"当前是哪条会话"。
      //
      //     踩过的坑：一开始只订阅了**当前那条**会话的保留计数——于是用户切到**别人那条**时，
      //     通知发在新会话上，**我们根本收不到**（接线测试当场抓出来）。
      //     可靠的做法是**定期问一次"现在主视图在看谁"**：简单、不漏，代价是一点点轮询。
      //     如果宿主提供了更精确的订阅点，也可以在这里接（`sessions.list.subscribe`）。
      // 轮询间隔也走 criteria；启动时先按默认/上次读到的值，之后改配置会在下次页面加载生效。
      const pollMs = effectiveCriteria.pollMs;
      const sessions = pluginCtx && pluginCtx.sessions;
      // **测试友好**：把定时器与清理交给注入的口子，测试就不必等真实 2 秒，
      //   也不会留下一个跑不停的定时器把断言搅乱（踩过一次）。
      //   ⚠ 真环境的 ctx 是**代理**：读未声明的属性会抛错 → 所有"测试口子"都要**包起来读**。
      const safeGet = (k) => { try { return pluginCtx ? pluginCtx[k] : undefined; } catch { return undefined; } };
      const setTimer = safeGet('__setTimer') || ((fn, ms) => setInterval(fn, ms));
      const clearTimer = safeGet('__clearTimer') || ((t) => clearInterval(t));
      const tick = () => guardSync('轮询当前会话', () => {
        const id = currentMainSessionId(sessionsOf());
        // **认不出来时不要清空**：`null` 表示“这次没认出来”，不是“切到了空会话”。
        // 当前会话可能是插槽告诉我们的一条，别被这个 null 覆盖掉。
        if (id !== null && id !== current.sessionId) void reevaluate(id);
      }, { optional: true, log: guardLog, code: CODES.UI_READ_FAILED, blockedBy: 'ui' });
      let timer = null;
      if (typeof setTimer === 'function') {
        timer = setTimer(tick, pollMs);
        disposers.push(() => { if (timer !== null && typeof clearTimer === 'function') clearTimer(timer); });
      }
      // 若宿主给了列表订阅，就顺手接上（有则更快，没有也不影响）
      const listSub = sessions && sessions.list && sessions.list.subscribe;
      if (typeof listSub === 'function') {
        try {
          const unsub = sessions.list.subscribe(tick);
          if (typeof unsub === 'function') disposers.push(unsub);
        } catch { /* 订阅不到就只靠轮询 */ }
      }

      // ② 挂卡片。用 `slots.inject` 等插槽声明，声明没了自动摘掉。
      const slots = pluginCtx && pluginCtx.slots;
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        try {
          // `inject: (sessionId) => …` 是 **session 作用域 list slot** 的官方用法：
          // 插槽把当前会话 id 交给每个条目，条目再把它作为 prop 交给组件。
          const d = slots.inject('conversation.chat.turnTail', () => slots.register(
            { name: 'conversation.chat.turnTail', id: CARD_SLOT_ID, order: 50, inject: (sessionId) => ({ sessionId }) },
            ReturnCardView,
          ));
          if (typeof d === 'function') disposers.push(d);
        } catch (err) {
          log('warn', '挂卡片失败：' + String((err && err.message) || err));
        }
      }

      // ②b 配置浮球（只读）。`shell.overlay` 是 root 作用域的页面浮层；**不是桌面级窗口**。
      //     注册失败不影响卡片：浮球是可选装饰，卡片是主功能。
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        try {
          const d = slots.inject('shell.overlay', () => slots.register(
            { name: 'shell.overlay', id: SETTINGS_SLOT_ID, order: 60 },
            SettingsBallView,
          ));
          if (typeof d === 'function') disposers.push(d);
        } catch (err) {
          log('warn', '挂配置浮球失败：' + String((err && err.message) || err));
        }
      }

      // ②c 行配置页（`plugins.row.config`，key = `<包名>#<Loader 行 id>`）。
      //     只出现在插件管理页的 `dsh-milieu` 行详情里（`view:'page'`）；与卡片、`shell.overlay`
      //     浮球**互相独立**：注册失败只 warn，不影响另外两个，也不让插件页整块崩。
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        try {
          const d = slots.inject('plugins.row.config', () => slots.register(
            { name: 'plugins.row.config', key: CONFIG_PAGE_KEY },
            ConfigPageView,
          ));
          if (typeof d === 'function') disposers.push(d);
        } catch (err) {
          log('warn', '挂配置页失败：' + String((err && err.message) || err));
        }
      }

      // ③ 先算一次（页面打开时可能已经在某条会话里）
      void reevaluate(currentMainSessionId(sessionsOf()));
      // 轮询是主路径，所以让测试能立刻推进一次，不必等 2 秒
      const tickHook = safeGet('__tick');
      if (typeof tickHook === 'function') { try { tickHook(tick); } catch { /* 测试口子出错不影响运行 */ } }

      // ④ 启动时如实报告处境——**注册上了几个扩展点，绝不假装成功**
      log('info', '客户端已启动：' + disposers.length + ' 个扩展点注册成功');

      return () => {
        for (const d of disposers) {
          guardSync('清理客户端资源', d, {
            optional: true, log: guardLog, code: CODES.UI_INIT_FAILED, blockedBy: 'ui',
          });
        }
      };
  }

  return {
    inject: CLIENT_INJECT,
    apply(pluginCtx) {
      // 启动边界：接线期抛错不能变成"界面加载失败"（那会连累整块 slot 宿主页面）。
      const started = guardSync('客户端启动', () => applyInner(pluginCtx), {
        optional: false,
        log: guardLog,
        code: CODES.UI_INIT_FAILED,
        blockedBy: 'ui',
      });
      return typeof started === 'function' ? started : () => {};
    },
    // 测试口子：让离线测试能直接驱动判断与收场；`logs()` 读客户端内存日志（LOG-SCHEMA §6.2）
    __test: {
      reevaluate,
      current: () => current,
      dismiss,
      listeners,
      readSettingsState,
      logs: () => memorySink.list(),
      logSnapshot: () => memorySink.snapshot(),
    },
  };
}
