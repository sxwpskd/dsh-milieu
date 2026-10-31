// dsh-milieu —— **预加载会话**的动作（核心层；需求 R4）
//
// 它做一件完整的事：**这个工作区没有我们的预加载会话 → 建一条，并让它真读一次。**
//
// 为什么必须是"真读一次"：**会话跑过一次 agent 任务才持久化**，建个空壳重启就没了。
//
// 契约（2026-10-14 查实，见 DEVELOPMENT.md「M5 的 API 契约」）：
//   · 建：`host.session.create({ workspaceId, sessionId })`（**传 id 才挂工作区**）
//   · 发：`prompt(...)`（平台补 id/来源；**不手写消息**）
//   · 登记：受管会话表写进状态文件（**只记 id 与角色**）
//
// 关于"读过了"（2026-10-16 主人定）：**发请求本身就是记**——那次请求会进会话日志、
//   并更新这条会话自己的活动时间，而判据第 ④ 关用的正是它。所以这里**不写任何"上次读"**。
//
// 重构后的边界（ARCHITECTURE.md §6.3）：
//   · 宿主服务走参数传入的 `host` 能力（`adapter/dsh.js`）——**不再有 `ctx.get` 回退**，
//     服务只从 `inject` 回调的 ctx 属性取（本文件连 ctx 都拿不到，只拿能力对象）；
//   · 文件读写走参数传入的 `fs` 能力（`adapter/fs.js`）；
//   · 请求 id 从 `model/session.js` 取（`actions.js` 已迁走，core 不 import ui/）。
//
// 纪律：
//   · **失败要报告**（返回 `{ok:false, reason}`），不兜底、不假装成功；
//   · **同一个工作区只建一条**预加载会话（判据：受管会话表里有没有 `role === 'preload'`）；
//   · 只写**我们自己的**状态文件。
import { join } from 'node:path';
import { STATE_FILE, STATE_VERSION } from '../constant/state.js';
import { normalizeManagedSessions, emptyState } from '../model/state.js';
import { mintSessionId, buildAgentCreateOptions, findPreloadSession, makeRequestId } from '../model/session.js';
import { buildReadText } from './texts.js';
import { evaluateReadiness } from './criteria.js';
import { subtreeAggregate } from './state-generator.js';
import { DEFAULT_CRITERIA, mergeCriteria } from '../config/criteria.js';
import { guardAsync } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';

/** 读状态文件（读不到/版本不认 → 当空的；**不抛**）。 */
function readState(root, libs, fs) {
  const path = join(root, libs.review, STATE_FILE);
  const base = emptyState(Date.now(), mergeCriteria(DEFAULT_CRITERIA));
  if (!fs.exists(path)) return { path, state: base, exists: false };
  try {
    const raw = JSON.parse(fs.readText(path));
    if (!raw || raw.stateVersion !== STATE_VERSION) return { path, state: base, exists: false };
    return { path, state: { ...base, ...raw, managedSessions: normalizeManagedSessions(raw.managedSessions) }, exists: true };
  } catch {
    return { path, state: base, exists: true };
  }
}

/** 写状态文件（受管会话表 + 上次读）。**只碰我们自己的文件。** */
function writeState(root, libs, state, fs) {
  const path = join(root, libs.review, STATE_FILE);
  fs.mkdirp(join(root, libs.review));
  const out = { ...state, stateVersion: STATE_VERSION, generatedAt: Date.now(), libs };
  fs.writeText(path, JSON.stringify(out, null, 2) + '\n');
  return path;
}

/** 把两条记录合并进受管会话表（同 id 后者覆盖，归一只有一个家）。 */
function withManaged(state, entry) {
  return { ...state, managedSessions: normalizeManagedSessions([...(state.managedSessions || []), entry]) };
}

/**
 * 保证这个工作区有一条**已经读过的**预加载会话（对外入口，**永不 reject**）。
 *
 * 异常边界（task-5）：整条异步流程包在 `guardAsync` 里——
 *   · 正常的失败（返回 `{ok:false, reason}`）原样返回，**文案不变**；
 *   · 意料之外的 throw / Promise 拒绝 → 归一成 `{ok:false, code, reason, blockedBy}` 并报一次，
 *     **不把异常抛给宿主**（宿主是定时器/effect 回调，抛出去就是加载失败）。
 *
 * @param {object} o 见 `preloadSessionInner`
 */
export function preloadSession(o = {}) {
  return guardAsync('预加载会话', () => preloadSessionInner(o), {
    optional: false,
    log: o && o.log ? o.log : null,
    code: CODES.SESSION_CREATE_FAILED,
    blockedBy: 'host',
  });
}

/**
 * 预加载会话的内部实现（失败都返回报告，不抛）。
 *
 * 正路（2026-10-18 读平台实现后定）：
 *   1. `host.workspace.resolveId(root)` → 拿到**工作区 id**；
 *   2. `host.session.create({ workspaceId, sessionId })` → **挂进工作区**（侧栏可见）；
 *      ⚠ 只传 `cwd` 时平台**不会挂**——会话会变成"无主"（真机撞过：进了归档、侧栏看不见）；
 *   3. 建完 `host.workspace.unarchive(sessionId)` → **确保不在归档里**；
 *   4. `host.session.prompt` 发一次阅读（**不手写消息**，平台自己补 id 与来源）。
 * 回退（没有这些服务）：`host.agents.create`（要求调用方已等会话服务就绪）。
 * 已有预加载会话时：有正路服务就**认领 + 挂载 + 取消归档**一次。
 *
 * @param {object} o
 *   · host / fs / root / libs / texts / now / criteria / log
 *   · readStateImpl / writeStateImpl / createAgent 注入点（测试与将来复用）
 * @returns {Promise<{ok:boolean, reason:string, sessionId?:string, created?:boolean, didRead?:boolean}>}
 */
async function preloadSessionInner(o = {}) {
  const {
    host, fs, root,
    libs = { review: 'review', tools: 'tools', external: 'external' },
    texts, now = Date.now(),
    criteria,
    readStateImpl = (r, l) => readState(r, l, fs),
    writeStateImpl = (r, l, s) => writeState(r, l, s, fs),
    createAgent = (options) => host.agents.create(options),
  } = o;

  if (!root) return { ok: false, reason: '没有工作区根（拿不到 cwd 也没配置 workspaceRoot）' };
  if (!host) return { ok: false, reason: '没有宿主能力对象（host），建不了预加载会话' };
  if (!fs) return { ok: false, reason: '没有文件系统能力（fs），建不了预加载会话' };

  let { state } = readStateImpl(root, libs);

  /**
   * 认知库现状快照（给 `evaluateReadiness` 用）：
   *   · `files` / `bytes`：`<认知库>` 整棵现扫；
   *   · `addedInWindow` / `changedInWindow`：状态文件事件流里，观察窗内、认知库路径下的事件数。
   * **只读**，不写任何东西。
   */
  const readinessSnapshot = (events) => {
    const agg = subtreeAggregate(join(root, libs.review), fs);
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
   * 发一次阅读请求——**只能走平台的 `prompt`**（界面发消息也是它）。
   *
   * 💥 2026-10-18 真机：我们曾手写一条 `{role:'user',content,source}` 直接塞给 `agent.followup`，
   *   结果那条事件**没有消息 id**，把会话写坏（`seq 9 lacks an identified message`）。
   *   平台会自己补全 id / 来源 / 顺序——**不要手写消息**。
   */
  const promptSession = async (sessionId) => {
    if (!host.session.canPrompt()) {
      return { ok: false, reason: host.texts.noPrompt };
    }
    const text = buildReadText('preload', { libs, now, templates: texts, stateFileRelPath: join(libs.review, STATE_FILE) });
    try {
      const res = await host.session.prompt({
        requestId: makeRequestId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, new AbortController().signal);
      if (res && res.ok === false) return { ok: false, reason: res.reason || '发请求失败' };
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
      fs.mkdirp(dir);
      fs.writeText(join(dir, 'preload.json'), JSON.stringify({ time: now, root, ...data }, null, 2) + '\n');
    } catch { /* 诊断写不进去不影响主流程 */ }
  };

  /**
   * 拿**工作区 id**（界面"新建会话"那个流程用的就是它）。
   * 先 `resolveByPath`；不行就 `list()` 里按路径找（大小写/斜杠差异常见）——平台差异由
   * `adapter/dsh.js` 翻译，这里只把失败当"拿不到"。
   */
  const resolveWorkspaceId = async () => {
    if (!host.workspace) return undefined;
    const res = await host.workspace.resolveId(root);
    return res && res.ok ? res.value : undefined;
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
    if (host.session.available()) {
      try {
        const adopted = await host.session.create(workspaceId
          ? { workspaceId, sessionId: existing.sessionId }
          : { cwd: root, sessionId: existing.sessionId });
        if (adopted && adopted.ok === false) throw new Error(adopted.reason);
        step = workspaceId ? 'adopt+attach' : 'adopt(cwd)';
      } catch (err) {
        error = String((err && err.message) || err);
      }
    }
    const un = await host.workspace.unarchive(existing.sessionId);
    // **它是空白吗？已经被用了吗？**
    //   第一条 `user/message` 是预加载请求；再有，就是人真的在用了。
    //   空白 → 补读一次；已用过 → 毕业成 active，然后往下建一条新的。
    let blank = null;
    let userMessages = null;
    let used = null;
    if (!error && host.session.available()) {
      try {
        if (host.session.canInspect()) {
          const insp = await host.session.inspect(existing.sessionId);
          // 适配层把平台异常翻成 `{ok:false}`（不再抛）；这里按"查不到"处理 → 走保守分支。
          if (insp && insp.ok === false) throw new Error(insp.reason);
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
      if (!error && host.session.available() && blank === true) {
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

  if (host.session.available()) {
    // **正路**：界面同款接口 + 工作区 id（这样才会挂进工作区）；建完确保不归档。
    let un = { ok: false, reason: '未走到' };
    try {
      // 适配层把平台异常翻成 `{ok:false}`（不再抛）；失败就按建会话失败处理。
      const createdResult = await host.session.create(workspaceId ? { workspaceId, sessionId } : { cwd: root, sessionId });
      if (createdResult && createdResult.ok === false) throw new Error(createdResult.reason);
      created = true;
      un = await host.workspace.unarchive(sessionId);
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
    //    2026-10-18 起改走 prompt：**不再需要 agent**，由会话控制器自己 resume。
  } else {
    // **回退**：老路。⚠ `host.agents.create` 是 async，必须 await；且调用方要等会话服务就绪。
    if (!host.agents.available()) {
      return { ok: false, reason: host.texts.noSessionNoAgents };
    }
    try {
      const res = await createAgent(buildAgentCreateOptions({ sessionId, cwd: root }));
      if (res && res.ok === false) throw new Error(res.reason);
      created = true;
    } catch (err) {
      const msg = String((err && err.message) || err);
      return { ok: false, retryable: /agent factory/i.test(msg), reason: '建会话失败：' + msg };
    }
    // **这条环境没有 prompt 通道**：不手写消息（那会把会话写坏，2026-10-18 真机事故）。
    return { ok: false, reason: '会话建好了，但' + host.texts.noPromptTail + ' —— 不手写消息（会写坏会话），这次不读', sessionId, created: true, didRead: false };
  }

  // ③ 登记（**先登记再发**：发送失败也知道这条会话是我们的）
  const state2 = withManaged(state, { sessionId, role: 'preload', source: null });
  try {
    writeStateImpl(root, libs, state2);
  } catch (err) {
    return { ok: false, reason: '会话建好了但登记失败：' + String((err && err.message) || err), sessionId, created: true, didRead: false };
  }

  // ④ **真读一次**（这正是"预加载"与"伪造注入"的分界）
  //    走平台的 `prompt`——平台会补全消息 id 与来源，**不要手写消息**。
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
