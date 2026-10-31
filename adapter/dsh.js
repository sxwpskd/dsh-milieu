// dsh-milieu —— DSH 宿主适配层（**唯一允许出现宿主服务名的地方**）
//
// 规则（ARCHITECTURE.md §4.1 / §4.2）：
//   · **只翻译，不决策**：这里没有"该不该建会话 / 等多久 / 建几条 / 要不要重试"的判断；
//     那些在 `core/boot.js` 与 `core/preload.js`。
//   · **服务只从 `ctx.inject` 回调的 ctx 属性上取**：真宿主上 `ctx.get('服务名')` 返回 undefined
//     （2026-10-18 体检单，journal/038）。本文件**不再使用 `ctx.get`**。
//   · **失败返回 `{ok:false, reason, blockedBy}`，不吞错**；平台调用自己抛的错原样往上抛，
//     由核心层包成 reason（"主语落在工具或环境上"）。
//   · 宿主名词、日志文案、失败文案**集中在本文件**：核心层只引用 `host.texts` / `host.labels`，
//     自己一个字都不写——这样边界检查（`plugin/tools/check.mjs`）才能 0 命中。
//
// 真机契约（CONVENTION.md §2）：激活期只做注册 + 只读检查；要等服务用 `ctx.inject`，
//   在回调的 ctx 上访问属性。所以本工厂**取服务全是懒的**（方法被调用时才读属性），
//   创建 adapter 本身不会碰任何未声明的宿主服务。
import { resolve } from 'node:path';
import { fail } from '../exception/result.js';
import { normalizeError } from '../exception/normalize.js';
import { CODES } from '../exception/codes.js';

/**
 * 宿主服务名表。**本文件之外不出现这些名字**——核心层只认 `host.workspace` / `host.session` 这类能力名。
 */
const SERVICE = {
  workspace: 'workspaceRegistry',
  session: 'sessionController',
  agents: 'agents',
  systemPrompt: 'systemPrompt',
};

/** "等这些服务就绪再执行"用的依赖清单（`ctx.inject` 的入参，同样只在这里出现）。 */
const WORKSPACE_DEPENDENCIES = ['workspaceRegistry'];
const PRELOAD_DEPENDENCIES = ['agentLoop', 'sessionController', 'workspaceRegistry'];

/**
 * 宿主文案表：日志前缀与被测试/真机排查依赖的失败文案。
 *
 * 为什么放这里：这些句子里的词（`sessionController`、`workspaceRegistry`、`agentLoop`）
 * 是**宿主服务名**，按分层规则只能出现在 adapter/；核心层引用本表即可，
 * 重构前后的日志与失败 reason 因此**逐字不变**。
 */
export const HOST_TEXTS = {
  /** 正路服务与老路服务都没有 → 建不了会话（原 preload-session.js 的同一句话）。 */
  noSessionNoAgents: '宿主既没有 sessionController，也没有可用的 ctx.agents —— 建不了会话',
  /** 没有 `prompt` 通道：不手写消息（会写坏会话）。 */
  noPrompt: '宿主没有 sessionController.prompt（不手写消息，避免写坏会话）',
  /** 老路建好会话但没 `prompt` 时，补在 reason 里的短句。 */
  noPromptTail: '宿主没有 sessionController.prompt',
  /** 没有取消归档接口。 */
  noUnarchive: '宿主没有 workspaceRegistry.unarchiveSession',
};

/**
 * 宿主日志词（原 index.js 里直接写在日志文本里的宿主词，挪到这里以保持日志逐字一致）。
 */
export const HOST_LABELS = {
  /** "已注册 N 个扩展点（systemPrompt.section）"。 */
  extensionPoints: 'systemPrompt.section',
  /** 根解析时等平台服务失败。 */
  waitWorkspaceFailed: '等 workspaceRegistry 失败',
  /** 预加载时等会话服务失败。 */
  waitSessionFailed: '等待 agentLoop 失败',
  /** 宿主没有 `ctx.inject`（等就绪能力）。 */
  noInject: '宿主没有 ctx.inject —— 走兜底定时尝试',
};

function errorText(err) {
  return String((err && err.message) || err);
}

/**
 * 平台调用抛出的异常 → 统一失败结果（task-5 的适配层边界）。
 * **reason 仍是原来的 message**（`errorText` 的文案不变）；多出来的只是 `code` / `blockedBy`。
 * 不在这里报告：适配层没有日志口，由核心层/入口统一报告一次。
 */
function callFailed(err, code) {
  return normalizeError(err, { code, blockedBy: 'host' });
}

/**
 * 取一个服务：**只做属性访问**（这是真宿主上拿服务的正路）。
 * 真 ctx 是代理：没在 `inject` 里声明就访问会抛错 → 这里翻译成"没有这个服务"。
 */
function service(ctx, name) {
  try {
    const found = ctx ? ctx[name] : undefined;
    return found || null;
  } catch {
    return null;
  }
}

/** 把一个 Workspace 记录归一成绝对路径（宿主字段是 `path`；兼容别的拼法）。 */
function workspacePathOf(workspace) {
  if (!workspace) return null;
  const raw = workspace.path || workspace.root || workspace.cwd || workspace.dir;
  if (!raw) return null;
  try {
    return resolve(String(raw));
  } catch {
    return null;
  }
}

/** 同一个路径的不同拼法（斜杠 / 大小写）算同一个。 */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 造一份宿主能力对象。
 *
 * 一次 `apply` 里会造多次：顶层一次；每个 `ctx.inject` 回调里再用**回调的 ctx** 造一次
 * （只有回调 ctx 上才保证能访问到那些服务）。
 *
 * 能力面（核心层只认这些名字，不认宿主接口名）：
 *   · `logger()` / `cwd()` / `canInject()` / `effect(cb)` / `awaitWorkspace(cb)` / `awaitPreload(cb)`
 *   · `systemPrompt.available()/orderOf()/section()`
 *   · `workspace.available()/listPaths()/resolveId()/unarchive()`
 *   · `session.available()/canPrompt()/canInspect()/create()/inspect()/prompt()`
 *   · `agents.available()/create()`
 *   · `texts` / `labels`（宿主文案，见上）
 *
 * @param {object} ctx Cordis 的 ctx（顶层，或 `ctx.inject` 回调里的子 ctx）
 */
export function createDsh(ctx) {
  return {
    id: 'dsh',
    texts: HOST_TEXTS,
    labels: HOST_LABELS,

    /** 宿主原始 logger（包装成统一接口是 `log/logger.js` 的事，本层只递过去）。 */
    logger() {
      try {
        return (ctx && ctx.logger) || null;
      } catch {
        return null;
      }
    },

    /** 进程当前目录（工作区根的最后兜底；核心层不直接读 process）。 */
    cwd() {
      try {
        return process.cwd();
      } catch {
        return '';
      }
    },

    /** 宿主有没有"等服务就绪"的扩展点（`ctx.inject`）。 */
    canInject() {
      try {
        return typeof (ctx && ctx.inject) === 'function';
      } catch {
        return false;
      }
    },

    /**
     * 注册副作用清理（官方契约 `ctx.effect(callback) => disposer`）。
     * 原样把返回的 disposer 交给调用方，由入口/核心还给框架——**能交给框架管的就不自己管**。
     */
    effect(callback) {
      return ctx.effect(callback);
    },

    /**
     * 等"工作区定位"需要的服务就绪，然后在**回调的 ctx** 上传一份新的能力对象。
     * @returns {object|null} 框架给的 fiber（可 dispose）；宿主不支持时调用方先问 `canInject()`
     */
    awaitWorkspace(callback) {
      return ctx.inject(WORKSPACE_DEPENDENCIES, (sub) => callback(createDsh(sub)));
    },

    /**
     * 等"建预加载会话"需要的服务就绪（`agentLoop` 是工厂注册者的服务，必须等它；
     * 真机事故见 journal/032/033），回调拿到的 ctx 上再建能力对象。
     */
    awaitPreload(callback) {
      return ctx.inject(PRELOAD_DEPENDENCIES, (sub) => callback(createDsh(sub)));
    },

    // ------------------------------------------------------------------
    // 系统提示：注册 section（顺序由官方 `getSectionOrder` 决定，拿不到用兜底值）
    // ------------------------------------------------------------------
    systemPrompt: {
      /** 能不能注册（`systemPrompt` 服务在不在、有没有 `section`）。 */
      available() {
        const sp = service(ctx, SERVICE.systemPrompt);
        return !!(sp && typeof sp.section === 'function');
      },

      /** 问官方要"这个分区该排第几"；API 不在或抛错 → fallbackOrder（官方示例里未必都有）。 */
      orderOf(orderName, fallbackOrder) {
        const sp = service(ctx, SERVICE.systemPrompt);
        let order = fallbackOrder;
        if (sp && orderName && typeof sp.getSectionOrder === 'function') {
          try {
            const found = sp.getSectionOrder(orderName);
            if (typeof found === 'number' && Number.isFinite(found)) order = found;
          } catch { /* 拿不到名分就用兜底 order */ }
        }
        return order;
      },

      /** 注册一段；返回 `{ok:true, value:<原始 disposer>}` 或 fail。 */
      section({ name, order, text }) {
        const sp = service(ctx, SERVICE.systemPrompt);
        if (!sp || typeof sp.section !== 'function') {
          return fail('宿主没有 ' + SERVICE.systemPrompt + '.section', 'host', CODES.HOST_UNAVAILABLE);
        }
        try {
          return { ok: true, value: sp.section({ name, order, text }) };
        } catch (err) {
          const failure = callFailed(err, CODES.HOST_CALL_FAILED);
          return { ...failure, reason: '注册 ' + name + ' 失败：' + failure.reason };
        }
      },
    },

    // ------------------------------------------------------------------
    // 工作区：列表 / 解析 id / 取消归档（**不决定用哪个根**——那是 core/root.js）
    // ------------------------------------------------------------------
    workspace: {
      available() {
        const wr = service(ctx, SERVICE.workspace);
        return !!(wr && typeof wr.list === 'function');
      },

      canUnarchive() {
        const wr = service(ctx, SERVICE.workspace);
        return !!(wr && typeof wr.unarchiveSession === 'function');
      },

      /** 平台工作区表（有序，只给绝对路径）；`list()` 是同步缓存读（官方 workspace 文档）。 */
      listPaths() {
        const wr = service(ctx, SERVICE.workspace);
        if (!wr || typeof wr.list !== 'function') {
          return fail('宿主没有 ' + SERVICE.workspace + '.list', 'host', CODES.HOST_UNAVAILABLE);
        }
        try {
          const rows = wr.list();
          const list = Array.isArray(rows) ? rows : [];
          return { ok: true, value: list.map(workspacePathOf).filter(Boolean) };
        } catch (err) {
          const failure = callFailed(err, CODES.HOST_CALL_FAILED);
          return { ...failure, reason: '读平台工作区列表失败：' + failure.reason };
        }
      },

      /**
       * 拿工作区 id（界面"新建会话"那个流程用的就是它）。
       * 翻译平台两种取法：先 `resolveByPath(root)`；不行再 `list()` 里按路径找
       * （大小写 / 斜杠差异常见，真机踩过）。
       * @returns {Promise<{ok:true, value:string}|{ok:false, reason:string}>}
       */
      async resolveId(root) {
        const wr = service(ctx, SERVICE.workspace);
        if (!wr) return fail('宿主没有 ' + SERVICE.workspace, 'host', CODES.HOST_UNAVAILABLE);
        try {
          if (typeof wr.resolveByPath === 'function') {
            const workspace = await wr.resolveByPath(root);
            if (workspace) {
              const id = workspace.id ?? workspace.workspaceId;
              if (id) return { ok: true, value: id };
            }
          }
        } catch { /* 落到 list 找 */ }
        try {
          const rows = typeof wr.list === 'function' ? await wr.list() : [];
          const hit = (Array.isArray(rows) ? rows : []).find((w) => samePath(workspacePathOf(w), root));
          if (hit) {
            const id = hit.id ?? hit.workspaceId;
            if (id) return { ok: true, value: id };
          }
        } catch { /* 找不到就是找不到 */ }
        return fail('平台里找不到这个工作区 id（resolveByPath 与 list 都没命中）：' + root, 'host', CODES.WORKSPACE_NOT_FOUND);
      },

      /** 确保会话不在归档集合里；失败返回原因，不抛。 */
      async unarchive(sessionId) {
        const wr = service(ctx, SERVICE.workspace);
        if (!wr || typeof wr.unarchiveSession !== 'function') {
          return { ok: false, reason: HOST_TEXTS.noUnarchive };
        }
        try {
          await wr.unarchiveSession(sessionId);
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: errorText(err) };
        }
      },
    },

    // ------------------------------------------------------------------
    // 会话控制器：建 / 查 / 发（**不决定什么时候建**——那是 core/preload.js）
    // ------------------------------------------------------------------
    session: {
      /** 正路可不可用（判据与界面建会话用的是同一个接口）。 */
      available() {
        const sc = service(ctx, SERVICE.session);
        return !!(sc && typeof sc.create === 'function');
      },

      canPrompt() {
        const sc = service(ctx, SERVICE.session);
        return !!(sc && typeof sc.prompt === 'function');
      },

      canInspect() {
        const sc = service(ctx, SERVICE.session);
        return !!(sc && typeof sc.inspect === 'function');
      },

      /** 建（只建会话，不建 agent）。平台自己抛错时**翻成统一失败结果**（不再抛给核心层）。 */
      async create(request) {
        const sc = service(ctx, SERVICE.session);
        if (!sc || typeof sc.create !== 'function') {
          return fail('宿主没有 ' + SERVICE.session + '.create', 'host', CODES.HOST_UNAVAILABLE);
        }
        try {
          return await sc.create(request);
        } catch (err) {
          return callFailed(err, CODES.SESSION_CREATE_FAILED);
        }
      },

      /** 查会话事件（判"空白 / 已被人用过"用）；平台抛错 → 统一失败结果。 */
      async inspect(sessionId) {
        const sc = service(ctx, SERVICE.session);
        if (!sc || typeof sc.inspect !== 'function') {
          return fail('宿主没有 ' + SERVICE.session + '.inspect', 'host', CODES.HOST_UNAVAILABLE);
        }
        try {
          return await sc.inspect(sessionId);
        } catch (err) {
          return callFailed(err, CODES.SESSION_INSPECT_FAILED);
        }
      },

      /** 发一次请求——**唯一发消息通道**（不手写消息，2026-10-18 真机事故）。 */
      async prompt(request, signal) {
        const sc = service(ctx, SERVICE.session);
        if (!sc || typeof sc.prompt !== 'function') {
          return fail(HOST_TEXTS.noPrompt, 'host', CODES.SESSION_PROMPT_FAILED);
        }
        try {
          return await sc.prompt(request, signal);
        } catch (err) {
          return callFailed(err, CODES.SESSION_PROMPT_FAILED);
        }
      },
    },

    // ------------------------------------------------------------------
    // Agent 工厂（回退路；`create` 是 async，必须 await，2026-10-18 踩过）
    // ------------------------------------------------------------------
    agents: {
      available() {
        const agents = service(ctx, SERVICE.agents);
        return !!(agents && typeof agents.create === 'function');
      },

      async create(options) {
        const agents = service(ctx, SERVICE.agents);
        if (!agents || typeof agents.create !== 'function') {
          return fail('宿主没有 ' + SERVICE.agents + '.create', 'host', CODES.HOST_UNAVAILABLE);
        }
        try {
          return await agents.create(options);
        } catch (err) {
          return callFailed(err, CODES.SESSION_CREATE_FAILED);
        }
      },
    },
  };
}
