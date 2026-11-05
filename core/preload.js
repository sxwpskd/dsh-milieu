// dsh-milieu —— **预加载会话**的动作（核心层；需求 R4）
//
// 它做一件完整的事：**这个工作区恰好有一条我们的预加载会话，并且它已经真读过一次。**
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
// 2026-11 真机 bug 的三处根因（这一版按它们改的）：
//   ① "用过"按**所有** `user/message` 数：插件自己发的预加载阅读请求也在里面，
//      于是只有 1 条人类消息的会话被判成"用过了"，每次启动都毕业、再新建一条。
//      现在只认 `data.source.kind === 'user'`（见 `model/session.js` 的 `isHumanMessage`）。
//   ② 受管表里 `role === 'preload'` **允许有多条**（历史遗留 / 重复启动），老实现只认第一条，
//      后面的永远留着 → 侧栏里冒出多条预加载会话。现在先**对账**：只留一条有效的。
//   ③ 被人用过的会话原来立刻毕业，可那个人可能**还在用它**。现在要**空闲够久**才毕业：
//      `now - updatedAt >= criteria.preloadIdleMs`（与弹卡阈值 `promptThresholdMs` 无关，各自独立）。
//
// 重构后的边界（ARCHITECTURE.md §6.3）：
//   · 宿主服务走参数传入的 `host` 能力（`adapter/dsh.js`）——**不再有 `ctx.get` 回退**，
//     服务只从 `inject` 回调的 ctx 属性取（本文件连 ctx 都拿不到，只拿能力对象）；
//   · 文件读写走参数传入的 `fs` 能力（`adapter/fs.js`）；
//   · 请求 id 从 `model/session.js` 取（`actions.js` 已迁走，core 不 import ui/）。
//
// 纪律：
//   · **失败要报告**（返回 `{ok:false, reason}`），不兜底、不假装成功；
//   · **同一个工作区只留一条**预加载会话（对账依据：受管表 + 会话表里真实存在的那些）；
//   · 只写**我们自己的**状态文件；
//   · **返回形状固定**（见下方 `report`）：监控层按字段判状态，不再解析 reason 文案。
import { join } from 'node:path';
import { STATE_FILE, STATE_VERSION } from '../constant/state.js';
import { normalizeManagedSessions, emptyState } from '../model/state.js';
import {
  mintSessionId, buildAgentCreateOptions, listPreloadSessions,
  isHumanMessage, sessionListIndex, makeRequestId,
} from '../model/session.js';
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

/** 把一条记录合并进受管会话表（同 id 后者覆盖，归一只有一个家）。 */
function withManaged(state, entry) {
  return { ...state, managedSessions: normalizeManagedSessions([...(state.managedSessions || []), entry]) };
}

/** 用一张完整的受管会话表替换（对账要**删**记录，不能只追加）。 */
function setManaged(state, managedSessions) {
  return { ...state, managedSessions: normalizeManagedSessions(managedSessions) };
}

/**
 * 统一的返回形状（**监控日志按字段读**，不再解析 reason 文案）。
 *
 * 缺的字段用 `null` / `false` / `0`，**不用 undefined**——调用方可以无条件读。
 * `skipped` 的五个取值（语义见本文件各分支）：
 *   · `readiness` —— 0 条有效预加载，但认知库还没到门槛（**有意 0，不是失败**，ok:true）
 *   · `idle`      —— 已被人用过，但还没空闲够久（不毕业、不新建）
 *   · `activity`  —— 拿不到活动时间/会话表（保守：不毕业、不新建、不删）
 *   · `clean`     —— 已有一条有效预加载，这次不用建（可能补读了一次）
 *   · `none`      —— 没跳过（新建成功；或失败路径，无意义）
 *
 * `repaired` / `converged` 是**次数**（0 = 没有），不是布尔：监控要能看出"这一轮修了几条"。
 * `kept` = 收尾后受管表里那条 preload 的 id（新建成功时 = 新 id）。
 */
function report(fields = {}) {
  const out = {
    ok: fields.ok === true,
    reason: fields.reason || '',
    sessionId: fields.sessionId ?? null,
    created: fields.created === true,
    didRead: fields.didRead === true,
    graduatedFrom: fields.graduatedFrom ?? null,
    readiness: fields.readiness ?? null,
    skipped: fields.skipped || 'none',
    repaired: Number.isFinite(fields.repaired) ? fields.repaired : 0,
    converged: Number.isFinite(fields.converged) ? fields.converged : 0,
    kept: fields.kept ?? null,
  };
  if (fields.retryable) out.retryable = true;
  if (fields.code) {
    out.code = fields.code;
    out.blockedBy = fields.blockedBy ?? null;
  }
  return out;
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
 *
 * 流程（2026-11 版）：
 *   ⓪ **对账**：受管表里所有 `role==='preload'` 的记录 → 用 `host.session.list()` 看哪些真存在；
 *      只留一条有效的（表序第一条），其余有效的转 `active`、无效的**删掉**。
 *      会话表拿不到 → **什么都不动**（不建、不删、不认领），只报告。
 *   ① 有可保留的会话 → 认领 / 挂载 / 取消归档 → `inspect`：
 *      · 空白（0 条人类消息）→ 补读一次；
 *      · 没用过（恰好 1 条人类消息）→ 收尾（`clean`）；
 *      · 用过（>1 条）→ 看空闲：没空闲够 → `idle`；有空闲 → 转 `active` 再往下建新的。
 *   ② 没有可保留的会话 → 过 `evaluateReadiness`：不达标 → `readiness` 跳过（ok:true）；达标 → 建 + 发。
 *
 * @param {object} o
 *   · host / fs / root / libs / texts / now / criteria / log
 *   · readStateImpl / writeStateImpl / createAgent 注入点（测试与将来复用）
 * @returns {Promise<object>} 固定形状，见 `report`
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

  if (!root) return report({ ok: false, reason: '没有工作区根（拿不到 cwd 也没配置 workspaceRoot）' });
  if (!host) return report({ ok: false, reason: '没有宿主能力对象（host），建不了预加载会话' });
  if (!fs) return report({ ok: false, reason: '没有文件系统能力（fs），建不了预加载会话' });

  let { state } = readStateImpl(root, libs);

  // 对账/毕业的账：`finish` 会自动带上，各分支不用重复写。
  let repaired = 0;
  let converged = 0;
  let graduatedFrom = null;

  /**
   * **把这次尝试写下来**（`.dsh-milieu/preload.json`）。
   * 为什么：真机上插件日志看不到，前几次都在"猜哪一步没生效"。有了它，重启后直接读文件。
   * task-1 起固定记 `skipped` / `repaired` / `converged`（监控与排障按字段读）。
   */
  const diag = (data) => {
    try {
      const dir = join(root, '.dsh-milieu');
      fs.mkdirp(dir);
      fs.writeText(join(dir, 'preload.json'), JSON.stringify({ time: now, root, ...data }, null, 2) + '\n');
    } catch { /* 诊断写不进去不影响主流程 */ }
  };

  /**
   * 收尾：拼固定返回形状 + **写一次**诊断文件（每次尝试一条，故障时能看到这一步停在哪）。
   * `graduatedFrom` / `repaired` / `converged` 自动带上——分支里只写自己特有的。
   */
  const finish = (fields, stage, extra = {}) => {
    const result = report({ graduatedFrom, repaired, converged, ...fields });
    diag({ stage, ...extra, ...result });
    return result;
  };

  /**
   * 生效的 readiness 忽略表（**相对认知库**；默认值只在 `config/criteria.js`，本层不另写一份）。
   * 为什么要有：插件自己每轮都在写 `milieu-state.json` / `STATE.md`，它们不该被算成
   * "认知库还在长"的证据，否则 readiness 永远不达标、预加载永远不建。
   */
  const readinessIgnore = () => {
    const fromCriteria = criteria && criteria.readiness && criteria.readiness.ignore;
    const list = Array.isArray(fromCriteria)
      ? fromCriteria
      : (Array.isArray(DEFAULT_CRITERIA.readiness.ignore) ? DEFAULT_CRITERIA.readiness.ignore : []);
    return list
      .map((s) => String(s || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, ''))
      .filter(Boolean);
  };

  /**
   * 认知库现状快照（给 `evaluateReadiness` 用）：
   *   · `files` / `bytes`：`<认知库>` 整棵现扫，**忽略表里的文件不计数、不读**；
   *   · `addedInWindow` / `changedInWindow`：状态文件事件流里，观察窗内、认知库路径下、
   *     **且不在忽略表里**的事件数（插件自己的写入不算"工作区变了"）。
   * **只读**，不写任何东西。
   */
  const readinessSnapshot = (events) => {
    const ignore = readinessIgnore();
    const agg = subtreeAggregate(join(root, libs.review), fs, { ignore });
    const windowMs = (criteria && criteria.readiness && criteria.readiness.windowMs)
      || DEFAULT_CRITERIA.readiness.windowMs;
    const cutoff = now - windowMs;
    const prefix = String(libs.review).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    const ignored = (rel) => ignore.some((ig) => rel === ig || rel.startsWith(ig + '/'));
    let added = 0;
    let changed = 0;
    for (const e of events || []) {
      if (!e || typeof e.time !== 'number' || e.time < cutoff) continue;
      const p = String(e.path || '').replace(/\\/g, '/');
      if (!p.startsWith(prefix)) continue;
      if (ignored(p.slice(prefix.length))) continue; // 忽略表：不计数（口径与上面对齐）
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
   * 拿**工作区 id**（界面"新建会话"那个流程用的就是它）。
   * 先 `resolveByPath`；不行就 `list()` 里按路径找（大小写/斜杠差异常见）——平台差异由
   * `adapter/dsh.js` 翻译，这里只把失败当"拿不到"。
   */
  const resolveWorkspaceId = async () => {
    if (!host.workspace) return undefined;
    const res = await host.workspace.resolveId(root);
    return res && res.ok ? res.value : undefined;
  };

  /**
   * **读会话表**（存在性 + 活动时间）——这是"恰好 1 条"对账与"空闲够久"的唯一依据。
   *
   * 形状按能力契约：`{ok:true, value:[{id, updatedAt}]}` / `{ok:false, reason}`。
   * 再容忍一次裸数组（旧适配层的形状）——形状差异不该被当成"没有会话"（那会清掉真记录）。
   *
   * @returns {Promise<{ok:boolean, reason?:string, ids?:Set<string>, updatedAt?:Map<string,number>}>}
   */
  const readSessionList = async () => {
    if (!host.session || typeof host.session.list !== 'function') {
      return { ok: false, reason: '宿主的会话能力没有 list（拿不到会话表）' };
    }
    let listed;
    try {
      listed = await host.session.list();
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
    if (Array.isArray(listed)) {
      const idx = sessionListIndex(listed);
      return { ok: true, ids: idx.ids, updatedAt: idx.updatedAt };
    }
    if (!listed || listed.ok === false) {
      return { ok: false, reason: (listed && listed.reason) || '会话列表不可用' };
    }
    const rows = Array.isArray(listed.value) ? listed.value
      : (Array.isArray(listed.items) ? listed.items : []);
    const idx = sessionListIndex(rows);
    return { ok: true, ids: idx.ids, updatedAt: idx.updatedAt };
  };

  /** 空闲阈值：**默认值只有 config/criteria.js 一处**（本层不另写一个数）。拿不到 → null（保守）。 */
  const idleThreshold = () => {
    if (criteria && Number.isFinite(criteria.preloadIdleMs)) return criteria.preloadIdleMs;
    const fallback = DEFAULT_CRITERIA && DEFAULT_CRITERIA.preloadIdleMs;
    return Number.isFinite(fallback) ? fallback : null;
  };

  // ------------------------------------------------------------------
  // ⓪ **对账**：受管表里 `role==='preload'` 可以有多条，但工作区只该有一条。
  //    会话表拿不到时**什么都不动**（不建、不删、不认领，只报告）——见 finish 的 activity 分支。
  // ------------------------------------------------------------------
  const preloadEntries = listPreloadSessions(state.managedSessions);
  const sessionAvailable = host.session.available();

  let sessionIndex = null;
  if (sessionAvailable) {
    const listed = await readSessionList();
    if (!listed.ok) {
      const first = preloadEntries.length ? preloadEntries[0].sessionId : null;
      return finish({
        ok: true, // 拿不到会话表不是失败：是"这次不做决定"，下次挂载再试
        reason: '会话列表不可用（' + listed.reason + '）——保守起见这次不新建、也不删除预加载会话',
        skipped: 'activity',
        sessionId: first,
        kept: first,
      }, 'reconcile', { listError: listed.reason, listUnavailable: true });
    }
    sessionIndex = listed;
  }

  let keptEntry = null;
  if (sessionIndex) {
    const valid = preloadEntries.filter((e) => sessionIndex.ids.has(e.sessionId));
    const invalid = preloadEntries.filter((e) => !sessionIndex.ids.has(e.sessionId));
    if (valid.length === 0) {
      // 全都不存在：清掉无主记录（不是"毕业"——没有真实会话可毕业），再按 readiness 决定建不建。
      if (invalid.length) {
        const invalidIds = new Set(invalid.map((e) => e.sessionId));
        state = setManaged(state, state.managedSessions.filter((e) => !(e.role === 'preload' && invalidIds.has(e.sessionId))));
        try {
          writeStateImpl(root, libs, state);
        } catch (err) {
          return finish({
            ok: false,
            reason: '清掉无效的预加载会话记录失败：' + String((err && err.message) || err),
          }, 'reconcile', { stageError: 'clean-invalid' });
        }
        repaired = invalid.length;
      }
    } else {
      // 表序第一条即保留项（规格：优先受管表第一条）。
      keptEntry = valid[0];
      const keptId = keptEntry.sessionId;
      const duplicateIds = new Set(valid.slice(1).map((e) => e.sessionId));
      const invalidIds = new Set(invalid.map((e) => e.sessionId));
      let changed = false;
      const next = [];
      for (const entry of state.managedSessions) {
        if (entry.role !== 'preload') { next.push(entry); continue; }
        if (entry.sessionId === keptId) { next.push(entry); continue; }
        if (duplicateIds.has(entry.sessionId)) {
          // 多出来的**真实会话**：不删（它是用户可能还会用的历史），改成 active 退出预加载位。
          next.push({ ...entry, role: 'active' });
          converged += 1;
          changed = true;
          continue;
        }
        if (invalidIds.has(entry.sessionId)) { repaired += 1; changed = true; continue; }
        next.push(entry); // 理论不可达：既有效、又不是保留项/重复项；保底留着
      }
      if (changed) {
        state = setManaged(state, next);
        try {
          writeStateImpl(root, libs, state);
        } catch (err) {
          return finish({
            ok: false,
            reason: '对账后写受管会话表失败：' + String((err && err.message) || err),
            sessionId: keptId,
            kept: keptId,
          }, 'reconcile', { stageError: 'reconcile-write' });
        }
      }
    }
  } else if (preloadEntries.length) {
    // 回退环境（没有正路会话服务）：不做对账（"对账只走正路"），按老逻辑认第一条。
    keptEntry = preloadEntries[0];
  }

  // ------------------------------------------------------------------
  // ① 有可保留的预加载会话 → 认领 / 挂载 / 取消归档 / 判断"空不空、用没用"
  // ------------------------------------------------------------------
  if (keptEntry) {
    const existing = keptEntry;
    const workspaceId = await resolveWorkspaceId();
    let step = 'skip';
    let adoptError;
    if (host.session.available()) {
      try {
        const adopted = await host.session.create(workspaceId
          ? { workspaceId, sessionId: existing.sessionId }
          : { cwd: root, sessionId: existing.sessionId });
        if (adopted && adopted.ok === false) throw new Error(adopted.reason);
        step = workspaceId ? 'adopt+attach' : 'adopt(cwd)';
      } catch (err) {
        adoptError = String((err && err.message) || err);
      }
    }
    const un = host.workspace
      ? await host.workspace.unarchive(existing.sessionId)
      : { ok: false, reason: '没有工作区能力对象（workspace）' };

    // **它是空白吗？已经被用了吗？**
    //   预加载那次阅读请求 = 1 条**人**的消息（平台 prompt 的 source.kind 是 user）；
    //   再多，才是人真的在用了。**不能用所有 `user/message` 计数**（2026-11 真机 bug）。
    let blank = null;
    let humanMessages = null;
    let used = null;
    if (!adoptError && host.session.available()) {
      try {
        if (host.session.canInspect()) {
          const insp = await host.session.inspect(existing.sessionId);
          // 适配层把平台异常翻成 `{ok:false}`（不再抛）；这里按"查不到"处理 → 走保守分支。
          if (insp && insp.ok === false) throw new Error(insp.reason);
          const events = insp && Array.isArray(insp.events) ? insp.events : [];
          humanMessages = events.filter(isHumanMessage).length;
          blank = humanMessages === 0;
          used = humanMessages > 1;
        }
      } catch {
        blank = null;
        humanMessages = null;
        used = null;
      }
    }

    if (adoptError) {
      return finish({
        ok: false,
        retryable: /agent factory/i.test(adoptError),
        reason: '认领已有预加载会话失败：' + adoptError,
        sessionId: existing.sessionId,
        kept: existing.sessionId,
        created: false,
        didRead: false,
      }, 'existing', { workspaceId, step, adoptError });
    }

    if (used === true) {
      // **已被人用过 → 先看空闲够不够久**（2026-11 主人定）：人可能还在用这条会话，
      // 立刻毕业会把它从预加载位踢走、再建一条新的——正是"每次启动新建"的另一半原因。
      const updatedAt = sessionIndex ? sessionIndex.updatedAt.get(existing.sessionId) : undefined;
      const idleMs = idleThreshold();
      if (!Number.isFinite(updatedAt) || !Number.isFinite(idleMs) || idleMs <= 0) {
        return finish({
          ok: true,
          reason: '预加载会话已经被用过，但拿不到'
            + (!Number.isFinite(updatedAt) ? '它的最后活动时间' : '空闲阈值（criteria.preloadIdleMs）')
            + '——保守：这次不毕业、不新建',
          skipped: 'activity',
          sessionId: existing.sessionId,
          kept: existing.sessionId,
          created: false,
          didRead: false,
        }, 'existing', { workspaceId, step, unarchive: un, humanMessages, used });
      }
      const elapsed = now - updatedAt;
      if (elapsed < idleMs) {
        return finish({
          ok: true,
          reason: '预加载会话已经被用过，但距最后活动只有 ' + Math.round(elapsed / 1000)
            + ' 秒（< ' + Math.round(idleMs / 1000) + ' 秒）——这次不毕业、不新建',
          skipped: 'idle',
          sessionId: existing.sessionId,
          kept: existing.sessionId,
          created: false,
          didRead: false,
        }, 'existing', { workspaceId, step, unarchive: un, humanMessages, used, elapsedMs: elapsed });
      }
      // **毕业**：它已经是正式会话了，不再占着 "preload" 这个位子。
      state = withManaged(state, { sessionId: existing.sessionId, role: 'active', source: existing.source });
      try {
        writeStateImpl(root, libs, state);
      } catch (err) {
        return finish({
          ok: false,
          reason: '旧的预加载会话已用过、也空闲够了，但转成 active 失败：' + String((err && err.message) || err),
          sessionId: existing.sessionId,
          kept: existing.sessionId,
          created: false,
          didRead: false,
        }, 'existing', { workspaceId, step, unarchive: un, humanMessages, used, graduated: false });
      }
      graduatedFrom = existing.sessionId;
      keptEntry = null;
      // 不 return：往下给这个工作区建一条新的预加载。
    } else {
      // **没被用过**（或拿不到 inspect）→ 认领；空白就补读一次。
      let didRead = false;
      let sendError;
      if (!adoptError && host.session.available() && blank === true) {
        const sent = await promptSession(existing.sessionId);
        didRead = sent.ok;
        if (!sent.ok) sendError = sent.reason;
      }
      if (sendError) {
        // 补读失败 ≠ 稳定态："空白会话侧栏不列"，这次没读成就是**没读成**——
        // 必须报失败（带稳定错误码），否则监控会把一次真失败当成"已经有人读过了"。
        return finish({
          ok: false,
          code: CODES.SESSION_PROMPT_FAILED,
          blockedBy: 'session',
          reason: '认领了预加载会话，但**补读请求没发出去**：' + sendError,
          sessionId: existing.sessionId,
          kept: existing.sessionId,
          created: false,
          didRead: false,
        }, 'existing', { workspaceId, step, unarchive: un, blank, humanMessages, used, sendError });
      }
      return finish({
        ok: true,
        reason: blank === true ? '认领并补读了一次预加载会话' : '这个工作区已经有预加载会话了',
        skipped: 'clean',
        sessionId: existing.sessionId,
        kept: existing.sessionId,
        created: false,
        didRead,
      }, 'existing', { workspaceId, step, unarchive: un, blank, humanMessages, used });
    }
  }

  // ------------------------------------------------------------------
  // ② 没有可保留的会话 → 建一条：id 我们自己 mint（格式照平台），cwd 写工作区根
  // ------------------------------------------------------------------
  const sessionId = mintSessionId();
  const workspaceId = await resolveWorkspaceId();

  // **认知库够不够格？**（2026-10-18 主人定：没到门槛就不建新的预加载会话。
  //   已有的那条不受影响——它是"过去建的"，这里只管"要不要再建一条"。）
  //   不达标是**有意 0，不是失败**：ok:true + skipped:'readiness'，监控据此只记一次 info。
  const readiness = evaluateReadiness(readinessSnapshot(state.events), (criteria && criteria.readiness) || undefined);
  if (!readiness.ready) {
    return finish({
      ok: true,
      reason: '认知库还没到预加载门槛：' + readiness.reasons.join('；'),
      skipped: 'readiness',
      readiness,
      created: false,
      didRead: false,
    }, 'create', { workspaceId, sessionId });
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
    } catch (err) {
      const msg = String((err && err.message) || err);
      return finish({
        ok: false,
        retryable: /agent factory/i.test(msg),
        reason: '建会话失败：' + msg,
        sessionId,
        readiness,
      }, 'create', { workspaceId, error: msg, unarchive: un });
    }
    if (!workspaceId) {
      // **工作区 id 没解析出来**：会话建了也挂不上。如实说，别假装成功。
      return finish({
        ok: false,
        reason: '建了会话，但**没解析到工作区 id**（' + root + '）——挂不上工作区',
        sessionId,
        created: true,
        didRead: false,
        readiness,
      }, 'create', { workspaceId: null, warning: '没有解析到工作区 id（resolveByPath 与 list 都没命中）' });
    }
    // ③ 拿 agent（resume；这一步才真正起 agent）
    //    2026-10-18 起改走 prompt：**不再需要 agent**，由会话控制器自己 resume。
  } else {
    // **回退**：老路。⚠ `host.agents.create` 是 async，必须 await；且调用方要等会话服务就绪。
    // 本刀保留这条回退路径（"used/idle/对账只走正路"，回退环境没有这些信息，按老逻辑建）。
    if (!host.agents.available()) {
      return finish({
        ok: false,
        reason: host.texts.noSessionNoAgents,
        readiness,
      }, 'create', { workspaceId });
    }
    try {
      const res = await createAgent(buildAgentCreateOptions({ sessionId, cwd: root }));
      if (res && res.ok === false) throw new Error(res.reason);
      created = true;
    } catch (err) {
      const msg = String((err && err.message) || err);
      return finish({
        ok: false,
        retryable: /agent factory/i.test(msg),
        reason: '建会话失败：' + msg,
        sessionId,
        readiness,
      }, 'create', { workspaceId, error: msg });
    }
    // **这条环境没有 prompt 通道**：不手写消息（那会把会话写坏，2026-10-18 真机事故）。
    return finish({
      ok: false,
      reason: '会话建好了，但' + host.texts.noPromptTail + ' —— 不手写消息（会写坏会话），这次不读',
      sessionId,
      created: true,
      didRead: false,
      readiness,
    }, 'create', { workspaceId });
  }

  // ③ 登记（**先登记再发**：发送失败也知道这条会话是我们的）
  const state2 = withManaged(state, { sessionId, role: 'preload', source: null });
  try {
    writeStateImpl(root, libs, state2);
  } catch (err) {
    return finish({
      ok: false,
      reason: '会话建好了但登记失败：' + String((err && err.message) || err),
      sessionId,
      created: true,
      didRead: false,
      readiness,
    }, 'create', { workspaceId });
  }

  // ④ **真读一次**（这正是"预加载"与"伪造注入"的分界）
  //    走平台的 `prompt`——平台会补全消息 id 与来源，**不要手写消息**。
  const sent = await promptSession(sessionId);
  if (!sent.ok) {
    return finish({
      ok: false,
      reason: '会话建好、也登记了，但**阅读请求没发出去**：' + sent.reason,
      sessionId,
      created: true,
      didRead: false,
      readiness,
    }, 'create', { workspaceId, sendError: sent.reason });
  }

  return finish({
    ok: true,
    reason: '建了一条预加载会话并让它真读了一次'
      + (graduatedFrom ? '（旧的 ' + graduatedFrom + ' 已转为 active）' : ''),
    skipped: 'none',
    sessionId,
    kept: sessionId,
    created: true,
    didRead: true,
    readiness, // 对账日志要它：这次是过了哪条门槛才建的
  }, 'create', { workspaceId, repaired, converged });
}
