// dsh-milieu —— **预加载会话**的动作（宿主半边；需求 R4）
//
// 它做一件完整的事：**这个工作区没有我们的预加载会话 → 建一条，并让它真读一次。**
//
// 为什么必须是"真读一次"：**会话跑过一次 agent 任务才持久化**，建个空壳重启就没了。
//
// 契约（2026-10-14 查实，见 DEVELOPMENT.md「M5 的 API 契约」）：
//   · 建：`ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: {} })`
//   · 发：`sessionController.prompt(...)`（平台补 id/来源；**不手写消息**）
//   · 登记：受管会话表写进状态文件（**只记 id 与角色**）
//
// 关于"读过了"（2026-10-16 主人定）：**发请求本身就是记**——那次请求会进会话日志、
//   并更新这条会话自己的活动时间，而判据第 ④ 关用的正是它。所以这里**不写任何"上次读"**。
//
// 纪律：
//   · **失败要报告**（返回 `{ok:false, reason}`），不兜底、不假装成功；
//   · **同一个工作区只建一条**预加载会话（判据：受管会话表里有没有 `role === 'preload'`）；
//   · 只写**我们自己的**状态文件。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_FILE, STATE_VERSION, ROLES, normalizeManagedSessions, emptyState } from './state.js';
import { mintSessionId, buildAgentCreateOptions, findPreloadSession } from './session.js';
import { makeRequestId } from './actions.js';
import { buildReadText } from './texts.js';
import { evaluateReadiness } from './core.js';
import { subtreeAggregate } from './milieu-state.js';
import { DEFAULT_CRITERIA } from './criteria.js';

/** 读状态文件（读不到/版本不认 → 当空的；**不抛**）。 */
function readState(root, libs) {
  const p = join(root, libs.review, STATE_FILE);
  const base = emptyState();
  if (!existsSync(p)) return { path: p, state: base, exists: false };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (!raw || raw.stateVersion !== STATE_VERSION) return { path: p, state: base, exists: false };
    return { path: p, state: { ...base, ...raw, managedSessions: normalizeManagedSessions(raw.managedSessions) }, exists: true };
  } catch {
    return { path: p, state: base, exists: true };
  }
}

/** 写状态文件（受管会话表 + 上次读）。**只碰我们自己的文件。** */
function writeState(root, libs, state) {
  const p = join(root, libs.review, STATE_FILE);
  mkdirSync(join(root, libs.review), { recursive: true });
  const out = { ...state, stateVersion: STATE_VERSION, generatedAt: Date.now(), libs };
  writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return p;
}

/** 把两条记录合并进受管会话表（同 id 后者覆盖，归一只有一个家）。 */
function withManaged(state, entry) {
  return { ...state, managedSessions: normalizeManagedSessions([...(state.managedSessions || []), entry]) };
}

/**
 * 拿一个服务：**先注入后的直接属性，再 `ctx.get`**。
 *
 * 2026-10-18 真机体检单：`ctx.get('sessionController')` / `ctx.get('workspaceRegistry')`
 *   在真宿主上**都返回 undefined**（所以 `step: skip`、`unarchive: 没有 workspaceRegistry.unarchiveSession`）。
 *   正确取法是 **在 `ctx.inject([...], cb)` 的回调 ctx 上直接访问**（和服务声明一致）。
 *   这里两种都试：属性访问在未声明时会抛错 → 包起来。
 */
function getService(ctx, name) {
  try {
    const s = ctx ? ctx[name] : undefined;
    if (s) return s;
  } catch { /* 没声明：抛错，落到 ctx.get */ }
  try {
    if (ctx && typeof ctx.get === 'function') {
      const s = ctx.get(name);
      if (s) return s;
    }
  } catch { /* 没有就算了 */ }
  return null;
}

/** 拿平台的"会话控制器"（界面建会话走的就是它）。 */
function getSessionController(ctx) {
  const sc = getService(ctx, 'sessionController');
  return sc && typeof sc.create === 'function' ? sc : null;
}

/** 拿"工作区注册表"（要有 id 才能把会话挂进工作区）。 */
function getWorkspaceRegistry(ctx) {
  const wr = getService(ctx, 'workspaceRegistry');
  return wr ? wr : null;
}

/**
 * 保证这个工作区有一条**已经读过的**预加载会话。
 *
 * 正路（2026-10-18 读平台实现后定）：
 *   1. `workspaceRegistry.resolveByPath(root)` → 拿到**工作区 id**；
 *   2. `sessionController.create({ workspaceId, sessionId })` → **挂进工作区**（侧栏可见）；
 *      ⚠ 只传 `cwd` 时平台**不会挂**——会话会变成"无主"（真机撞过：进了归档、侧栏看不见）；
 *   3. 建完 `workspaceRegistry.unarchiveSession(sessionId)` → **确保不在归档里**；
 *   4. `sessionController.prompt` 发一次阅读（**不手写消息**，平台自己补 id 与来源）。
 * 回退（没有这些服务）：`ctx.agents.create`（要求调用方已等 agentLoop 就绪）。
 * 已有预加载会话时：有正路服务就**认领 + 挂载 + 取消归档**一次。
 *
 * @param {object} o
 *   · ctx / root / libs / texts / now
 *   · createAgent / send / readStateImpl / writeStateImpl  注入点（测试与将来复用）
 * @returns {{ok:boolean, reason:string, sessionId?:string, created?:boolean, didRead?:boolean}}
 */
export async function preloadSession(o = {}) {
  const {
    ctx, root,
    libs = { review: 'review', tools: 'tools', external: 'external' },
    texts, now = Date.now(),
    criteria,
    readStateImpl = readState,
    writeStateImpl = writeState,
    createAgent = (options) => ctx.agents.create(options),
  } = o;

  if (!root) return { ok: false, reason: '没有工作区根（拿不到 cwd 也没配置 workspaceRoot）' };
  const sc = getSessionController(ctx);
  const wr = getWorkspaceRegistry(ctx);
  let { state } = readStateImpl(root, libs);

  /**
   * 认知库现状快照（给 `evaluateReadiness` 用）：
   *   · `files` / `bytes`：`<认知库>` 整棵现扫；
   *   · `addedInWindow` / `changedInWindow`：状态文件事件流里，观察窗内、认知库路径下的事件数。
   * **只读**，不写任何东西。
   */
  const readinessSnapshot = (events) => {
    const agg = subtreeAggregate(join(root, libs.review));
    const windowMs = (criteria && criteria.readiness && criteria.readiness.windowMs)
      || DEFAULT_CRITERIA.readiness.windowMs;
    const cutoff = now - windowMs;
    const prefix = String(libs.review).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    let added = 0;
    let changed = 0;
    for (const e of events || []) {
      if (!e || typeof e.time !== 'number' || e.time < cutoff) continue;
      const p = String(e.path || '').replace(/\\/g, '/');
      if (!p.startsWith(prefix)) continue;
      if (e.kind === 'created') added += 1;
      else if (e.kind === 'changed') changed += 1;
    }
    return { files: agg.files, bytes: agg.size, addedInWindow: added, changedInWindow: changed };
  };

  /**
   * 发一次阅读请求——**只能走 `sessionController.prompt`**（界面发消息也是它）。
   *
   * 💥 2026-10-18 真机：我们曾手写一条 `{role:'user',content,source}` 直接塞给 `agent.followup`，
   *   结果那条事件**没有消息 id**，把会话写坏（`seq 9 lacks an identified message`）。
   *   平台会自己补全 id / 来源 / 顺序——**不要手写消息**。
   */
  const promptSession = async (sessionId) => {
    if (!sc || typeof sc.prompt !== 'function') {
      return { ok: false, reason: '宿主没有 sessionController.prompt（不手写消息，避免写坏会话）' };
    }
    const text = buildReadText('preload', { libs, now, templates: texts, stateFileRelPath: join(libs.review, STATE_FILE) });
    try {
      await sc.prompt({
        requestId: makeRequestId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, new AbortController().signal);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  };

  /**
   * **把这次尝试写下来**（`.dsh-milieu/preload.json`）。
   * 为什么：真机上插件日志看不到，前几次都在"猜哪一步没生效"。有了它，重启后直接读文件。
   */
  const diag = (data) => {
    try {
      const dir = join(root, '.dsh-milieu');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'preload.json'), JSON.stringify({ time: now, root, ...data }, null, 2) + '\n', 'utf8');
    } catch { /* 诊断写不进去不影响主流程 */ }
  };

  const normPath = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

  /**
   * 拿**工作区 id**（界面"新建会话"那个流程用的就是它）。
   * 先 `resolveByPath`；不行就 `list()` 里按路径找（大小写/斜杠差异常见）。
   */
  const resolveWorkspaceId = async () => {
    if (!wr) return undefined;
    try {
      const ws = await wr.resolveByPath(root);
      if (ws) {
        const id = ws.id ?? ws.workspaceId;
        if (id) return id;
      }
    } catch { /* 落到 list */ }
    try {
      const list = typeof wr.list === 'function' ? await wr.list() : [];
      const hit = (list || []).find((w) => normPath(w && w.path) === normPath(root));
      if (hit) return hit.id ?? hit.workspaceId;
    } catch { /* 没有就算了 */ }
    return undefined;
  };
  /** 确保它不在归档集合里（`unarchiveSession` 对不在集合里的 id 也无害）。 */
  const unarchive = async (id) => {
    if (wr && typeof wr.unarchiveSession === 'function') {
      try { await wr.unarchiveSession(id); return { ok: true }; } catch (err) { return { ok: false, reason: String((err && err.message) || err) }; }
    }
    return { ok: false, reason: '宿主没有 workspaceRegistry.unarchiveSession' };
  };

  // ① 已经有预加载会话？→ 先看它**是不是已经被正式用了**。
  //    2026-10-18 主人定：**预加载会话一旦被使用，就不该再算预加载**——
  //    把它转成 active，再给这个工作区新建一条干净的预加载。
  let graduatedFrom = null;
  const existing = findPreloadSession(state.managedSessions);
  if (existing) {
    const workspaceId = await resolveWorkspaceId();
    let step = 'skip';
    let error;
    if (sc && typeof sc.create === 'function') {
      try {
        await sc.create(workspaceId ? { workspaceId, sessionId: existing.sessionId } : { cwd: root, sessionId: existing.sessionId });
        step = workspaceId ? 'adopt+attach' : 'adopt(cwd)';
      } catch (err) {
        error = String((err && err.message) || err);
      }
    }
    const un = await unarchive(existing.sessionId);
    // **它是空白吗？已经被用了吗？**
    //   第一条 `user/message` 是预加载请求；再有，就是人真的在用了。
    //   空白 → 补读一次；已用过 → 毕业成 active，然后往下建一条新的。
    let blank = null;
    let userMessages = null;
    let used = null;
    if (!error && sc) {
      try {
        if (typeof sc.inspect === 'function') {
          const insp = await sc.inspect(existing.sessionId);
          const events = insp && Array.isArray(insp.events) ? insp.events : [];
          userMessages = events.filter((e) => e && e.type === 'user/message').length;
          blank = userMessages === 0;
          used = userMessages > 1;
        }
      } catch { blank = null; }
    }
    if (used === true) {
      // **毕业**：它已经是正式会话了，不再占着 "preload" 这个位子。
      state = withManaged(state, { sessionId: existing.sessionId, role: 'active', source: existing.source });
      try {
        writeStateImpl(root, libs, state);
      } catch (err) {
        diag({ stage: 'existing', workspaceId, sessionId: existing.sessionId, step, error, unarchive: un, blank, userMessages, used, graduated: false, graduateError: String((err && err.message) || err) });
        return { ok: false, reason: '旧的预加载会话已用过，但转成 active 失败：' + String((err && err.message) || err), sessionId: existing.sessionId, created: false, didRead: false };
      }
      graduatedFrom = existing.sessionId;
      diag({ stage: 'existing', workspaceId, sessionId: existing.sessionId, step, error, unarchive: un, blank, userMessages, used, graduated: true });
      // 不 return：往下走，给工作区建一条新的预加载。
    } else {
      // **没被用过**（或拿不到 inspect）→ 认领；空白就补读一次。
      let didRead = false;
      let sendError;
      if (!error && sc && blank === true) {
        const sent = await promptSession(existing.sessionId);
        didRead = sent.ok;
        if (!sent.ok) sendError = sent.reason;
      }
      diag({ stage: 'existing', workspaceId, sessionId: existing.sessionId, step, error, unarchive: un, blank, userMessages, used, didRead, sendError });
      if (error) return { ok: false, retryable: /agent factory/i.test(error), reason: '认领已有预加载会话失败：' + error, sessionId: existing.sessionId, created: false, didRead: false };
      return { ok: true, reason: blank === true ? '认领并补读了一次预加载会话' : '这个工作区已经有预加载会话了', sessionId: existing.sessionId, created: false, didRead };
    }
  }

  // ② 建一条：id 我们自己 mint（格式照平台），cwd 写工作区根
  const sessionId = mintSessionId();
  const workspaceId = await resolveWorkspaceId();

  // **认知库够不够格？**（2026-10-18 主人定：没到门槛就不建新的预加载会话。
  //   已有的那条不受影响——它是"过去建的"，这里只管"要不要再建一条"。）
  const readiness = evaluateReadiness(readinessSnapshot(state.events), (criteria && criteria.readiness) || undefined);
  if (!readiness.ready) {
    diag({ stage: 'create', workspaceId, sessionId, readiness, skipped: 'readiness' });
    return {
      ok: false,
      reason: '认知库还没到预加载门槛：' + readiness.reasons.join('；'),
      created: false, didRead: false, readiness,
    };
  }

  let created = false;

  if (sc && typeof sc.create === 'function') {
    // **正路**：界面同款接口 + 工作区 id（这样才会挂进工作区）；建完确保不归档。
    let un = { ok: false, reason: '未走到' };
    try {
      await sc.create(workspaceId ? { workspaceId, sessionId } : { cwd: root, sessionId });
      created = true;
      un = await unarchive(sessionId);
      diag({ stage: 'create', workspaceId, sessionId, created, unarchive: un, graduatedFrom });
    } catch (err) {
      const msg = String((err && err.message) || err);
      diag({ stage: 'create', workspaceId, sessionId, error: msg, graduatedFrom });
      return { ok: false, retryable: /agent factory/i.test(msg), reason: '建会话失败：' + msg };
    }
    if (!workspaceId) {
      // **工作区 id 没解析出来**：会话建了也挂不上。如实说，别假装成功。
      diag({ stage: 'create', workspaceId: null, sessionId, graduatedFrom, warning: '没有解析到工作区 id（resolveByPath 与 list 都没命中）' });
      return { ok: false, reason: '建了会话，但**没解析到工作区 id**（' + root + '）——挂不上工作区', sessionId, created: true, didRead: false };
    }
    // ③ 拿 agent（resume；这一步才真正起 agent）
    //    2026-10-18 起改走 prompt：**不再需要 agent**，由 sessionController 自己 resume。
  } else {
    // **回退**：老路。⚠ `ctx.agents.create` 是 async，必须 await；且调用方要等 agentLoop 就绪。
    if (!ctx || !ctx.agents || typeof ctx.agents.create !== 'function') {
      return { ok: false, reason: '宿主既没有 sessionController，也没有可用的 ctx.agents —— 建不了会话' };
    }
    try {
      await createAgent(buildAgentCreateOptions({ sessionId, cwd: root }));
      created = true;
    } catch (err) {
      const msg = String((err && err.message) || err);
      return { ok: false, retryable: /agent factory/i.test(msg), reason: '建会话失败：' + msg };
    }
    // **这条环境没有 prompt 通道**：不手写消息（那会把会话写坏，2026-10-18 真机事故）。
    return { ok: false, reason: '会话建好了，但宿主没有 sessionController.prompt —— 不手写消息（会写坏会话），这次不读', sessionId, created: true, didRead: false };
  }

  // ③ 登记（**先登记再发**：发送失败也知道这条会话是我们的）
  const state2 = withManaged(state, { sessionId, role: 'preload', source: null });
  try {
    writeStateImpl(root, libs, state2);
  } catch (err) {
    return { ok: false, reason: '会话建好了但登记失败：' + String((err && err.message) || err), sessionId, created: true, didRead: false };
  }

  // ④ **真读一次**（这正是"预加载"与"伪造注入"的分界）
  //    走 `sessionController.prompt`——平台会补全消息 id 与来源，**不要手写消息**。
  const sent = await promptSession(sessionId);
  diag({ stage: 'create', workspaceId, sessionId, created, didRead: sent.ok, graduatedFrom, sendError: sent.ok ? undefined : sent.reason });
  if (!sent.ok) {
    return { ok: false, reason: '会话建好、也登记了，但**阅读请求没发出去**：' + sent.reason, sessionId, created: true, didRead: false };
  }

  return {
    ok: true,
    reason: '建了一条预加载会话并让它真读了一次' + (graduatedFrom ? '（旧的 ' + graduatedFrom + ' 已转为 active）' : ''),
    sessionId, created: true, didRead: true, graduatedFrom,
  };
}

/** 文本长度预检用的：把预加载那段拼出来（只为日志/报告，不发送）。 */
export function preloadText(o = {}) {
  const { libs, texts, now = Date.now(), stateFileRelPath = 'review/milieu-state.json' } = o;
  return buildReadText('preload', { libs, now, templates: texts, stateFileRelPath });
}

export { ROLES };
