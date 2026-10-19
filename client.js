// dsh-milieu —— 客户端半边
//
// 它做三件事，而且**只做这三件**：
//   ① 看住"当前是哪条会话"（`retainedBy.mainView` 计数变了就是切换）；
//   ② 切到**我们管的**那条时，用现成的 Remote 读状态文件；
//   ③ 判据说该弹，就把卡片注册进插槽；你点"重读"/"不用"/直接打字，卡片收场。
//
// **判据不在这里**——在 `client-core.js`（纯函数、离线测过 34 项）。
// 这里只负责"接线"：拿数据、喂判据、渲染。
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不需要自己装一份。
//
// 官方 UI 硬规矩（照办）：只用主题 token 上色、不 import 任何 Harness 客户端包、
//   不写 DOM、不动 document.body、注册进插槽而不是自己找位置。

import { shouldShowCard, markShown } from './client-core.js';
import { MilieuReturnCard } from './card.js';
import { promptReadViaRemote } from './actions.js';
import { DEFAULT_TEXTS } from './texts.js';
import { parseState } from './state.js';
import { DEFAULT_CRITERIA, mergeCriteria } from './criteria.js';

/** 状态文件在**认知库**里的相对路径。宿主写、这里读。 */
const STATE_REL_PATH = 'review/milieu-state.json';

/** 我们注册进插槽的卡片 id（同一次会话只应有一个）。 */
const CARD_SLOT_ID = 'dsh-milieu:return-card';

/**
 * 造客户端插件主体。**导出成函数是为了能离线测**：
 * 测试里传一个假的 ctx（假的 slots / remote / sessions），就能验"接线"对不对，
 * 不用真浏览器、不用真宿主。
 *
 * @param {object} deps { React, ctx }
 */
export function createClientPlugin({ React, ctx }) {
  // 客户端自己记的"这条会话弹过了"——只活在页面里，不进工作区。
  let shownMemory = {};
  // **生效判据**：先默认；每次读到状态文件后按文件里的 `criteria` 更新（宿主写的同一份）。
  let effectiveCriteria = mergeCriteria(DEFAULT_CRITERIA);
  // 每次判断的结果（同一次切换不重复算）
  let current = { sessionId: null, decision: { show: false }, state: null, pending: false };
  // 最近一次读状态文件的结果（诊断行用；也帮我们确认签名/路径）
  let lastRead = { ok: false, reason: 'not tried' };

  const log = (level, msg) => {
    const logger = ctx && ctx.logger;
    if (logger && typeof logger[level] === 'function') logger[level]('[milieu] ' + msg);
  };

  /** 取当前会话 id：平台用 `retainedBy.mainView > 0` 表示"主视图正在看它"。 */
  function currentMainSessionId() {
    const sessions = ctx && ctx.sessions;
    const list = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot();
    if (!list || !list.byId) return null;
    // 优先用调用方给的首选 id（插槽 props 里通常有），其次按主视图计数找
    for (const id of list.ids || Object.keys(list.byId)) {
      const row = list.byId[id];
      if (row && (row.retainedBy && row.retainedBy.mainView ? row.retainedBy.mainView : 0) > 0) return id;
    }
    return null;
  }

  /**
   * 取这条会话的**最后活动时间**——判据第 ④ 关的基准。
   * 来源是平台会话列表里的 `updatedAt`（**不另存一份"上次读"**，主人 2026-10-14 定的口径）。
   * 拿不到就返回 null → 判据走"保守提示"。
   */
  function sessionActivityAt(sessionId) {
    const sessions = ctx && ctx.sessions;
    const list = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot();
    const row = list && list.byId && list.byId[sessionId];
    const at = row && (typeof row.updatedAt === 'number' ? row.updatedAt : (typeof row.lastActivityAt === 'number' ? row.lastActivityAt : null));
    return typeof at === 'number' ? at : null;
  }

  /** 读状态文件。读不到 / 超时 / 报错，一律当"没有"——不弹、不崩。 */
  async function readState(sessionId) {
    const remote = ctx && ctx.remote && ctx.remote.workspaceFiles;
    if (!remote || typeof remote.read !== 'function') {
      lastRead = { ok: false, reason: 'no workspaceFiles remote' };
      log('info', '没有 workspaceFiles Remote —— 将不弹卡');
      return null;
    }
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(effectiveCriteria.readTimeoutMs)
      : undefined;
    // 官方文档形状是 `read(path, { offset?, limit? })`；旧代码写的是 `read(sessionId, path, …)`。
    // **两种都试**，谁先成功用谁；失败原因留给诊断行。
    const attempts = [
      ['read(path, opts)', () => remote.read(STATE_REL_PATH, {}, signal)],
      ['read(sessionId, path, opts, signal)', () => remote.read(sessionId, STATE_REL_PATH, {}, signal)],
    ];
    let lastErr = null;
    for (const [label, call] of attempts) {
      try {
        const res = await call();
        // 真机返回的是 **Remote 包装**：{ ok: true, value: { absolutePath, version, text, … } }
        const v = (res && res.ok === true && res.value) ? res.value : res;
        let text = null;
        if (typeof v === 'string') text = v;
        else if (v && v.kind === 'text' && typeof v.text === 'string') text = v.text;
        else if (v && typeof v.text === 'string') text = v.text;
        if (text !== null) { lastRead = { ok: true, via: label }; return text; }
        lastErr = label + ': shape=' + JSON.stringify(res).slice(0, 120);
      } catch (err) {
        lastErr = label + ': ' + String((err && err.message) || err);
      }
    }
    lastRead = { ok: false, reason: lastErr || 'unknown' };
    // 文件不存在是**正常情况**（还没生成），不是错误
    log('info', '读状态文件未成功（通常是没有这个文件）：' + lastRead.reason);
    return null;
  }

  /** 重新判断一次（切换会话或状态变化时调用）。 */
  async function reevaluate(sessionId) {
    if (!sessionId) { current = { sessionId: null, decision: { show: false }, state: null, pending: false }; return; }
    if (current.pending) return;                       // 不并发读同一件事
    current = { ...current, sessionId, pending: true };
    const text = await readState(sessionId);
    const parsed = parseState(text);
    const criteria = mergeCriteria(DEFAULT_CRITERIA, parsed && parsed.criteria);
    effectiveCriteria = criteria;
    const decision = shouldShowCard(sessionId, text, shownMemory, {
      now: Date.now(),
      activityAt: sessionActivityAt(sessionId),
      criteria,
      thresholdMs: criteria.promptThresholdMs,
    });
    current = { sessionId, decision, state: text, criteria, pending: false };
    log('info', '会话 ' + sessionId + ' → ' + (decision.show ? '该弹卡' : '不弹') + '（' + decision.reason + '）');
    bump();                                            // 通知插槽重画
  }

  // ---- 插槽重画：用一个极小的订阅点，避免自己造状态机 ----
  let listeners = new Set();
  const bump = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* 一个订阅者出错不影响别人 */ } } };

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

    // **插槽是 session 作用域**：它直接把当前会话 id 交给我们（`props.sessionId`），
    // 比 `ctx.sessions.list` 里的 `retainedBy.mainView` 可靠。
    // 没有这个 prop 时，才退回原来的“按主视图计数找当前会话”。
    const slotSessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null;

    // 排查用：`criteria.debug` 为真时，在聊天里渲染一行自报状态（平时关）。
    const debug = !!(effectiveCriteria && effectiveCriteria.debug);
    const debugLine = (d0) => React.createElement('div', {
      style: { font: '12px monospace', color: '#c00', border: '1px dashed #c00', padding: '4px', margin: '4px 0' },
    }, '[milieu] client alive | slot=' + String(slotSessionId) + ' | current=' + String(current.sessionId) + ' | show=' + String(!!(d0 && d0.show)) + ' | reason=' + String((d0 && d0.reason) || '') + ' | state=' + (current.state ? 'yes' : 'no') + ' | read=' + (lastRead.ok ? 'ok via ' + lastRead.via : lastRead.reason));

    if (slotSessionId && slotSessionId !== current.sessionId) {
      // 不在渲染里直接做异步副作用：推到微任务；pending 期间不会重复排队。
      Promise.resolve().then(() => {
        if (slotSessionId !== current.sessionId) void reevaluate(slotSessionId);
      });
      return debug ? debugLine(null) : null;
    }

    const d = current.decision;
    if (!d || !d.show) return debug ? debugLine(d) : null;
    const card = MilieuReturnCard(React, {
      changeIndex: d.changeIndex,
      locale: 'zh',
      onReview: () => {
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
        const activityAt = sessionActivityAt(targetId);
        if (typeof onUserChoice === 'function') onUserChoice('review', targetId);
        dismiss('review');
        void sendRead(targetId, changeIndex, events, activityAt);
      },
      onSkip: () => { log('info', '你点了"不用"'); if (typeof onUserChoice === 'function') onUserChoice('skip', current.sessionId); dismiss('skip'); },
      onDismiss: () => { log('info', '你直接开始了（卡片自动关闭）'); dismiss('typed'); },
    });
    return debug ? React.createElement('div', null, debugLine(d), card) : card;
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
    const liveId = currentMainSessionId() || current.sessionId;
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
   */
  async function sendRead(sessionId, changeIndex, events, activityAt) {
    const remote = ctx && ctx.remote && ctx.remote.session;
    // 文本是**配置层**的：客户端拿不到插件的 Config，所以用默认那份；
    // 宿主侧（建预加载会话）走 `sessionController.prompt`，它那份 Config.texts 由 preload-session.js 传。
    // **两种视图**由 events + activityAt 决定（见 views.js）：30 天内给大小变化，超过只给文件名。
    const res = await promptReadViaRemote({ remote, sessionId, kind: 'reread', changeIndex, events, activityAt, templates: DEFAULT_TEXTS, criteria: effectiveCriteria });
    log(res.ok ? 'info' : 'warn', '重读请求：' + res.reason);
    if (typeof onSendResult === 'function') onSendResult(res);
    return res;
  }
  let onSendResult = null;

  return {
    // **依赖声明**（客户端 Cordis 契约）：用到的服务/命名空间必须列全，访问未声明的会抛
    // `cannot get property … without inject`。`sessions` 我们一直在用，之前漏了——
    // 离线假 ctx 不检查这个，真机上才会炸（2026-10-18）。
    inject: ['slots', 'sessions', 'remote', 'remote.workspaceFiles', 'remote.session'],
    apply(pluginCtx) {
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
      const tick = () => {
        const id = currentMainSessionId();
        // **认不出来时不要清空**：`null` 表示“这次没认出来”，不是“切到了空会话”。
        // 当前会话可能是插槽告诉我们的一条，别被这个 null 覆盖掉。
        if (id !== null && id !== current.sessionId) void reevaluate(id);
      };
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

      // ③ 先算一次（页面打开时可能已经在某条会话里）
      void reevaluate(currentMainSessionId());
      // 轮询是主路径，所以让测试能立刻推进一次，不必等 2 秒
      const tickHook = safeGet('__tick');
      if (typeof tickHook === 'function') { try { tickHook(tick); } catch { /* 测试口子出错不影响运行 */ } }

      // ④ 启动时如实报告处境——**注册上了几个扩展点，绝不假装成功**
      log('info', '客户端已启动：' + disposers.length + ' 个扩展点注册成功');

      return () => { for (const d of disposers) { try { d(); } catch { /* 清理失败不吞噬宿主 */ } } };
    },
    // 测试口子：让离线测试能直接驱动判断与收场
    __test: { reevaluate, current: () => current, dismiss, listeners },
  };
}

// ---------------------------------------------------------------------------
// 浏览器模块入口（官方模板的形状）
//
// **守卫 `typeof window`**：Node 里没有 `window`，于是这个文件在离线测试里
// 只导出 `createClientPlugin`，不碰浏览器对象。这样同一份文件既能当浏览器模块，
// 又能被离线测——**不用为了可测而复制一份逻辑**。
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-milieu',
    factory(require) {
      const React = require('react');
      // 浏览器里 `ctx` 由加载器在 apply 时注入；这里先把工厂交出去。
      // 注意：`createClientPlugin` 需要 ctx，所以真正 apply 时再构造。
      return {
        inject: ['slots', 'sessions', 'remote', 'remote.workspaceFiles', 'remote.session'],
        apply(ctx) {
          // 工厂层只负责把 React 与 ctx 交给可测的那个构造器；
          // 注册、订阅、清理**全在构造器返回的 apply 里**（那份代码离线测过）。
          const plugin = createClientPlugin({ React, ctx });
          return plugin.apply(ctx);
        },
      };
    },
  });
}
