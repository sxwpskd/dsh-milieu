// dsh-milieu —— 宿主半边
//
// 它做两件事：
//   ① **把协议写进工作区**（`AGENTS.md` 的托管段 + `.dsh-milieu/` 三份文件）——**唯一的写动作**；
//   ② 在会话开场，把工作区的"一页状态"作为一段提示注入。
//
// **定义层不再注入**（2026-10-14 主人定）：声源是**工作区文件**，不是提示词。
// 理由：用户可能自己建会话，那条会话不归我们管、我们不会给它注入任何东西，
// 但它同样需要知道协议——写进 `AGENTS.md`，任何读这个工作区的 AI 都看得见。
//
// 扩展点的**真实签名**（2026-10-13 从 app.asar 实测，不是猜的）：
//   ctx.systemPrompt.section({ name, order: ctx.systemPrompt.getSectionOrder("NAME"), text })
//   text 可以是字符串，也可以是函数（官方自己就有 `text: () => …` 的写法）。
//   官方示例里 `getSectionOrder` 未必都在，所以这里**有就用、没有就退到固定 order**。
//
// 设计纪律（框架 + 官方规范）：
//   · 纯 ESM、零依赖、无构建；
//   · 注册放进 `apply`，用 `ctx.effect` 并返回清理函数；
//   · 会随部署变化的值一律走 `Config`，代码里不写死路径；
//   · **不假设 API 存在**：查不到就静默跳过，绝不抛错影响宿主启动；
//   · **内容没变不重发 / 不重写**（指纹），省 token、少动用户文件；
//   · 超预算**跳过**，不静默截断；
//   · 写入**失败就报告**（不搞兜底机制）。
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { syncProtocol } from './protocol.js';
import { DEFAULT_TEXTS } from './texts.js';
import { preloadSession } from './preload-session.js';
import { generateState, writeStateFile, summarize } from './milieu-state.js';
import { refreshStatePage, ensureStatePage } from './state-page.js';
import { DEFAULT_CRITERIA, mergeCriteria } from './criteria.js';

/**
 * **依赖声明**（Cordis 契约）：要访问某个服务，必须先在 `inject` 里声明它。
 * 不声明就访问 → `cannot get property "systemPrompt" without inject`（2026-10-18 真机踩到）。
 *   · `systemPrompt` —— 注入状态页要用；
 *   · `agents`     —— 建预加载会话要用（`preloadSession` 开着时）。
 * `logger` / `effect` 是 ctx 上的直接属性，不需要声明。
 */
export const inject = ['systemPrompt', 'agents'];

/** 兜底 order：拿不到官方分区顺序时用（数值只求稳定，不求精确）。 */
const FALLBACK_ORDER = 500;

/** 状态页的 order（定义已经在工作区的 AGENTS.md 里，不在这里排）。 */
const ORDER_STATE = 500;

export const DEFAULT_CONFIG = {
  libs: { review: 'review', tools: 'tools', external: 'external' },
  statePath: 'STATE.md',
  injectState: true,
  injectBudgetKiB: 128,
  // 把协议写进工作区（AGENTS.md 托管段 + `.dsh-milieu/` 三份文件）。**默认开**。
  // 这是"让后续 AI 看得到协议"那一条的实现；写失败只报告，不兜底。
  writeProtocol: true,
  // 检查三个库在不在，**不在就补全目录**（需求 R3）。默认开。**只建目录，不铺内容**。
  ensureLibs: true,
  // **两段请求文本**（预加载 / 重读）——**配置层**（主人 2026-10-14 定）。
  // 默认值在 `texts.js` 的 `DEFAULT_TEXTS`；这里给的是"可在配置里整体替换"的那一份。
  // 注意：`texts` 里的函数**不能经 Config 的 JSON 传**，所以校验只管"是不是对象"；
  //       真正的覆盖走宿主侧注入（将来接会话创建那一段时接上）。
  texts: DEFAULT_TEXTS,
  // **预加载会话**（需求 R4 / M5）：工作区没有我们的预加载会话就建一条，并让它真读一次。
  // **默认关**：它要建 agent、会真跑一次任务（花钱、动会话列表）——**等装上真机验过一次再默认开**。
  preloadSession: false,
  // **自动生成状态文件**（需求 R5 的地基）：会话开场扫一次工作区、产出事件流，客户端才有的读。
  // 默认开——它只做"只读扫描 + 写我们自己的状态文件"，不需要批准。
  autoState: true,
  // 工作区根。空 = 按进程 cwd 推断（约定大于配置：没有配置就用推断出来的那一个）。
  workspaceRoot: '',
  // **判据与显示阈值**：默认值在 `criteria.js`；这里给的是可被补丁层覆盖的那一份。
  // 宿主把**生效值**写进 `milieu-state.json` 的 `criteria`，客户端读同一份（两半不许各写一份）。
  criteria: DEFAULT_CRITERIA,
};

/** 配置归一（把补丁层给的那一份叠到默认值上）。 */
function withDefaults(config) {
  const c = config || {};
  return {
    ...DEFAULT_CONFIG,
    ...c,
    libs: { ...DEFAULT_CONFIG.libs, ...(c.libs || {}) },
    // **深合并** criteria（readiness / fingerprint 是嵌套对象，不能被浅覆盖掉）
    criteria: mergeCriteria(DEFAULT_CRITERIA, c.criteria),
  };
}

/**
 * 把一个 Workspace 记录归一成路径（官方字段是 `path`；兼容别的拼法）。
 * 来源：docs/subsystems/workspace.md「interface Workspace { readonly path: string }」。
 */
function workspacePathOf(w) {
  if (!w) return null;
  const p = w.path || w.root || w.cwd || w.dir;
  return p ? resolve(String(p)) : null;
}

/** 同一个路径的不同拼法（斜杠 / 大小写）算同一个。 */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * **问平台要工作区根**（2026-10-19 主人定：工作区定位问平台，简单点）。
 *
 * `WorkspaceRegistry.list()` 是**同步缓存读**（官方 workspace 子系统文档），返回有序的 `Workspace[]`。
 * 规则：**只有一个就用它；多个时先看 cwd 是否正好命中，否则用平台顺序里的第一个**（并写进日志，便于发现）。
 * 不猜的边界：**一个工作区都没有** → 返回 null，调用方不写任何文件（不让插件往应用目录里写）。
 * @param {object|null} reg `ctx.workspaceRegistry`
 * @param {string} cwd 进程当前目录
 * @returns {string|null}
 */
export function pickWorkspaceRoot(reg, cwd) {
  try {
    const list = reg && typeof reg.list === 'function' ? reg.list() : [];
    const arr = Array.isArray(list) ? list : [];
    if (arr.length === 1) return workspacePathOf(arr[0]);
    if (arr.length > 1) {
      const hit = arr.find((w) => samePath(workspacePathOf(w), cwd));
      return hit ? workspacePathOf(hit) : workspacePathOf(arr[0]);
    }
  } catch { /* 读失败 = 说不清 */ }
  return null;
}


/** 取要注入的**状态页**文本；返回 '' 表示"这次不注入（没页 / 没变 / 根还没解析出来）"。 */
function composeSection(cfg, lastSent, root) {
  if (!cfg.injectState) return '';
  if (!root) return ''; // 根还没解析出来：不按 cwd 瞎猜，这一轮不注入
  const file = join(root, cfg.libs.review, cfg.statePath);

  let st;
  try {
    st = statSync(file);
  } catch {
    return ''; // 没有那一页：不是错误，是尚未生成
  }
  const budget = cfg.injectBudgetKiB * 1024;
  if (st.size > budget) return ''; // 超预算跳过，不截断

  const fp = st.mtimeMs + ':' + st.size;
  if (lastSent.get(file) === fp) return ''; // 内容没变 → 不重发
  lastSent.set(file, fp);

  let text;
  try {
    text = readFileSync(file, 'utf8');
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

/** 读一个文件并按 mtime+size 去重；返回 null = 这次不注入（没变 / 读不到）。 */
function readOnce(file, lastSent, budget) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null; // 文件不存在：不是错误
  }
  if (budget > 0 && st.size > budget) return null; // 超预算跳过，不截断
  const fp = st.mtimeMs + ':' + st.size;
  if (lastSent.get(file) === fp) return null; // 没变 → 不重发
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null; // 读失败**不记指纹**：下次还会试（记了就等于"发过了"）
  }
  lastSent.set(file, fp);
  return text;
}

/**
 * 把协议**写进工作区**（宿主半边的唯一写动作），失败如实报告。
 *
 * 形态由主人 2026-10-14 定：**声源是工作区，不是提示词注入**——
 * 因为用户可能自己建会话，那条会话不归我们管，我们不会给它注入任何东西；
 * 但它同样需要知道协议。写到 `AGENTS.md` 里，任何读这个工作区的 AI 都看得见。
 */
function syncProtocolToWorkspace(ctx, cfg, root) {
  try {
    if (!root) return { ok: false, reason: '没有工作区根', wrote: [], changed: false };
    const res = syncProtocol({ root, libs: cfg.libs, ensureLibs: cfg.ensureLibs !== false });
    if (!res.ok) {
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('[milieu] 协议没能写进工作区：' + res.reason);
      }
    } else if (res.changed) {
      if (ctx.logger && typeof ctx.logger.info === 'function') {
        ctx.logger.info('[milieu] 协议已写进工作区：' + res.wrote.join('、'));
      }
    }
    return res;
  } catch (err) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('[milieu] 协议同步抛错：' + String((err && err.message) || err));
    }
    return { ok: false, reason: String((err && err.message) || err), wrote: [], changed: false };
  }
}

/**
 * **自动生成状态文件**（需求 R5 的地基；2026-10-16 加）。
 *
 * 为什么必须有这一步：客户端判"工作区变没变"读的是状态文件，**它太旧就永远不提示**。
 * 所以会话开场扫一次：工作区真变了 → 重算、写状态文件；没变 → 不写。
 *
 * 怎么跑：**用包里的实现**（`./milieu-state.js`）——宿主不能假设用户工作区里有 `tools/`。
 *   工具区那份 `milieu-state.mjs` 是同一个实现的开发入口（一份实现，两个入口）。
 *   **失败只报告，不兜底、不炸宿主**（清单还没跑过是常见情形，不是错误）。
 */
function refreshStateFile(ctx, cfg, root) {
  try {
    if (!root) return { ok: false, reason: '没有工作区根' };
    const report = generateState({ root, now: Date.now(), criteria: cfg.criteria });
    if (!report.ok) {
      const log = ctx.logger;
      // **清单还没跑过**是装机后第一次的正常状态，不是错误 → 记 info；其余才算 warn。
      const isFirstBoot = String(report.reason || '').includes('清单不存在');
      if (log) {
        if (isFirstBoot && typeof log.info === 'function') log.info('[milieu] 状态文件先不生成（' + report.reason + '）');
        else if (typeof log.warn === 'function') log.warn('[milieu] 状态文件没能生成：' + report.reason);
      }
      return { ok: false, reason: report.reason, firstBoot: isFirstBoot };
    }
    const w = writeStateFile(report);
    if (!w.ok) {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[milieu] 状态文件写入失败：' + w.reason);
      return { ok: false, reason: w.reason };
    }
    return { ok: true, reason: summarize(report), state: report.state };
  } catch (err) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('[milieu] 状态文件生成抛错：' + String((err && err.message) || err));
    }
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

/**
 * **刷新注入页的材料段**（需求 R5 的"让 AI 每轮看到当前状态"；2026-10-18 主人要求）。
 *
 * 为什么：注入的那一页（`STATE.md`）以前只有**手动跑 summary.js** 才更新，注入的永远是旧内容，
 *   看起来像插件没工作。这里让启动时顺手刷新——**只动标记以下**，判断段一字不动。
 * 失败只报告（页面没有标记就跳过，不碰别人的页面）。
 */
function refreshPage(ctx, cfg, stateRun, root) {
  try {
    if (!root) return { ok: false, changed: false, reason: '没有工作区根' };
    // `ensureLibs=false` 时不许为了建骨架去造库目录（R3 的配置边界）。
    if (!existsSync(join(root, cfg.libs.review))) return { ok: false, changed: false, reason: '认知库目录不在（ensureLibs=false）' };
    const statePath = join(cfg.libs.review, cfg.statePath);
    // **首装没有这一页就建骨架**：否则状态页注入在全新工作区里永远不工作。
    if (cfg.injectState) {
      const ens = ensureStatePage({ root, statePath });
      if (ens.created && ctx.logger && typeof ctx.logger.info === 'function') {
        ctx.logger.info('[milieu] 注入页骨架已建：' + statePath);
      }
    }
    return refreshStatePage({
      root,
      libs: cfg.libs,
      statePath,
      state: (stateRun && stateRun.state) || null,
      now: Date.now(),
    });
  } catch (err) {
    return { ok: false, changed: false, reason: String((err && err.message) || err) };
  }
}

export function apply(ctx, rawConfig) {
  const cfg = withDefaults(rawConfig);
  const lastSent = new Map();

  // 官方契约（app.asar 实测）：`ctx.effect(callback, label?) => () => void`
  //   它**自己交还一个 disposer**；body 若返回函数，那是另一条路（Effect body result）。
  //   所以这里 body 收集自己注册的那几个 disposer，再交还给框架——
  //   **能交给框架管的，就不自己管**（少一条可能出错的路）。
  ctx.effect(() => {
    const sysPrompt = ctx.systemPrompt;
    const disposers = [];
    let registered = 0;

    /**
     * 注册一个 section。**注册不上不许掀翻宿主**：如实报告，继续。
     * `orderName` 是问官方要"这个分区该排第几"用的名字；拿不到就用兜底 order。
     */
    const registerSection = (name, orderName, fallbackOrder, compose) => {
      let order = fallbackOrder;
      if (typeof sysPrompt.getSectionOrder === 'function') {
        try {
          const o = sysPrompt.getSectionOrder(orderName);
          if (typeof o === 'number' && Number.isFinite(o)) order = o;
        } catch {
          /* 拿不到名分就用兜底 order */
        }
      }
      const d = sysPrompt.section({ name, order, text: compose });
      // 官方 JSDoc 说可能是函数，也可能是 undefined（没挂 systemPrompt 服务时）
      if (typeof d === 'function') disposers.push(d);
      else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose());
      registered += 1;
    };

    // 工作区根：**配置 > 平台（workspaceRegistry）> cwd**。
    // 别人机器上没有 `D:\DSH`；空根时由平台告诉我们它管的工作区。
    let root = cfg.workspaceRoot ? resolve(cfg.workspaceRoot) : '';
    let rootSource = cfg.workspaceRoot ? 'config' : '';
    let decided = !!root;
    let started = false;
    const warn = (msg) => { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[milieu] ' + msg); };

    // 状态页**先注册**（同步；compose 惰性读 `root`）。定义层不再注入——它已经在工作区的 AGENTS.md 里了。
    if (sysPrompt && typeof sysPrompt.section === 'function') {
      try {
        registerSection('dsh-milieu:workspace-state', 'MILIEU_WORKSPACE_STATE', ORDER_STATE,
          () => composeSection(cfg, lastSent, root));
      } catch (err) {
        warn('状态页注册失败：' + String((err && err.message) || err));
      }
    }

    /** 一切**依赖工作区根**的动作（协议 / 状态账 / 注入页 / 预加载）都在根确定后开始。 */
    const start = () => {
      if (started) return;
      started = true;

      // ① **先把协议写进工作区**（声源在这里；写失败就报告，不兜底）。
      const proto = cfg.writeProtocol ? syncProtocolToWorkspace(ctx, cfg, root) : { ok: true, changed: false, reason: '配置里关了（writeProtocol=false）', wrote: [] };

      // ② **自动生成状态文件**（会话开场扫一次）——客户端判"变没变"读的就是它。
      //    失败只报告（清单还没跑过是常见情形，不是错误）。
      const stateRun = cfg.autoState ? refreshStateFile(ctx, cfg, root) : { ok: true, reason: '配置里关了（autoState=false）' };

      // ②b **顺手刷新注入页的材料段**（首装还会先建骨架）。
      //    只动 `<!-- judgement -->` 以下；判断段一字不动；没标记的页面不碰。
      const pageRun = cfg.autoState ? refreshPage(ctx, cfg, stateRun, root) : { ok: false, changed: false, reason: '配置里关了（autoState=false）' };
      if (pageRun.ok && pageRun.changed && ctx.logger && typeof ctx.logger.info === 'function') {
        ctx.logger.info('[milieu] 注入页材料段已刷新：' + cfg.libs.review + '/' + cfg.statePath);
      }

      // ③ 保证这个工作区**有一条已经读过的预加载会话**（需求 R4 / M5）。
    //
    // 💥 2026-10-18 真机事故：启动期直接 `ctx.agents.create` → 宿主崩
    //    （`no agent factory registered (load an agent-loop plugin)` → `fatal load failure`）。
    //    根因：Agent 创建由 `dsh-agent-loop` 的 **AgentLoop 服务**提供，工厂在它的**构造函数**里注册；
    //    我们这一行比它早就绪时，工厂还不存在。
    //
    // ✅ 正解（2026-10-18 查 Cordis 源码后定）：用 **`ctx.inject(['agentLoop'], cb)`**——
    //    "等服务就绪后再执行"。cb 跑的时候 AgentLoop 已经构造过 → 工厂一定在 → 建会话必然可用。
    //    **自动**：一次配置，之后每次启动都自己检查（已有就不再建）。
    if (cfg.preloadSession) {
      let handle = null;
      let cancelled = false;
      let ran = false;
      const warn = (msg) => { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[milieu] ' + msg); };
      const run = (sub) => {
        if (cancelled || ran) return;
        ran = true;
        try {
          Promise.resolve(preloadSession({
            ctx: sub, root, libs: cfg.libs, texts: cfg.texts, criteria: cfg.criteria,
            createAgent: (options) => sub.agents.create(options),
          })).then((res) => {
            if (cancelled) return;
            if (res && res.handle) handle = res.handle;
            if (res && res.ok) {
              if (ctx.logger && typeof ctx.logger.info === 'function') {
                ctx.logger.info('[milieu] ' + res.reason + '：' + (res.sessionId || '（没有 id）'));
              }
            } else {
              warn('预加载会话没能建起来：' + String((res && res.reason) || '未知原因'));
            }
          }).catch((err) => warn('预加载会话抛错：' + String((err && err.message) || err)));
        } catch (err) {
          warn('预加载会话调度失败：' + String((err && err.message) || err));
        }
      };
      let fiber = null;
      let fallbackTimer = null;
      try {
        if (typeof ctx.inject === 'function') {
          // 等这三个服务都就绪，**在回调的 ctx 上直接访问它们**（这是真宿主上拿服务的正路；
          //   2026-10-18 体检单证明 `ctx.get('…')` 在真宿主上拿不到）。
          fiber = ctx.inject(['agentLoop', 'sessionController', 'workspaceRegistry'], (sub) => run(sub));
        } else {
          warn('宿主没有 ctx.inject —— 走兜底定时尝试');
        }
        // **兜底**：若服务始终没就绪（某些组合里 agentLoop 是懒实例化的），
        //   10 秒后用父 ctx 再试一次——attach/unarchive 不依赖工厂，只有起 agent 才需要。
        //   失败只会写进 `.dsh-milieu/preload.json`，不会崩（定时器回调里，不在加载期）。
        fallbackTimer = setTimeout(() => { if (!ran) run(ctx); }, cfg.criteria.agentLoopWaitMs);
      } catch (err) {
        warn('等待 agentLoop 失败：' + String((err && err.message) || err));
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
    if (ctx.logger && typeof ctx.logger.info === 'function') {
      const where = registered > 0
        ? '已注册 ' + registered + ' 个扩展点（systemPrompt.section）'
        : '没有任何扩展点可用（将不注入状态页）';
      ctx.logger.info(
        '[milieu] 工作区=' + root + '（' + rootSource + '），三库=' + cfg.libs.review + '/' + cfg.libs.tools + '/' + cfg.libs.external +
        '，状态文件=' + cfg.statePath +
        '，协议写入工作区=' + (cfg.writeProtocol ? (proto.ok ? (proto.changed ? '已同步' : '已是最新') : '失败：' + proto.reason) : '关') +
        '，状态文件=' + (cfg.autoState ? (stateRun.ok ? '已生成' : (stateRun.firstBoot ? '等清单' : '失败：' + stateRun.reason)) : '关') +
        '，注入页=' + (pageRun.ok ? (pageRun.changed ? '已刷新' : '已是最新') : '未动（' + pageRun.reason + '）') +
        '，预加载会话=' + (cfg.preloadSession ? '开' : '关') +
        '，' + where
      );
    }
    };

    // 根从哪来：配置直接有 → 同步做；没有 → 问平台（`WorkspaceRegistry.list()` 是同步缓存读）。
    if (root) {
      start();
    } else {
      let fiber = null;
      let timer = null;
      const settle = (p, source) => {
        if (decided) return;
        decided = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (p) { root = p; rootSource = source; start(); }
        else warn('无法确定工作区：平台里没有工作区（或读不到）；请在配置里设置 workspaceRoot（本次不写任何文件）');
      };
      try {
        if (typeof ctx.inject === 'function') {
          fiber = ctx.inject(['workspaceRegistry'], (sub) => {
            settle(pickWorkspaceRoot(sub && sub.workspaceRegistry, process.cwd()), 'registry');
          });
        }
      } catch (err) {
        warn('等 workspaceRegistry 失败：' + String((err && err.message) || err));
      }
      // 平台没有这个服务（例如 headless）→ 2 秒后按 cwd；registry 已说“说不清”时不会走到这里。
      timer = setTimeout(() => { timer = null; settle(resolve(process.cwd()), 'cwd'); }, 2000);
      if (timer && typeof timer.unref === 'function') timer.unref();
      disposers.push(() => {
        if (timer) clearTimeout(timer);
        try { if (fiber && typeof fiber.dispose === 'function') fiber.dispose(); } catch { /* 释放失败不吞宿主 */ }
      });
    }

    return () => { for (const d of disposers) { try { d(); } catch { /* 清理失败不吞宿主 */ } } };
  });
}
