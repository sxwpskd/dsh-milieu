// dsh-milieu —— 请求文本拼装（**纯模块** + **配置层**：无宿主依赖、无副作用、双方都能引）
//
// 为什么单独一个文件：这段文本有两个作者——
//   · **客户端**点"重读"时，用 `session/prompt` Remote 把它发进会话；
//   · **宿主**将来若要自己发起（例如建完常驻会话先读一遍），也发同一段。
// 主人 2026-10-13 的澄清正是这个意思：**"重读"与"预加载"是同一件事**。
// 所以拼装只能有一份——放在这里，两个半边都引它。
//
// **它同时决定两件事**（2026-10-14 主人指出的）：
//   ① AI 读到什么任务；
//   ② **会话在列表里叫什么**——平台用"第一条人类消息的前几个词"当会话标题（fallback）。
//   所以：**第一行 = 时间**，用户一眼能看出这条会话是什么时候起的。
//
// 文本内容属**配置层**（主人 2026-10-14 定）：默认值在这里，可在插件的 `Config.texts` 里整体替换。
import { buildChangeIndexPrompt } from './core.js';
import { renderChangeView } from './views.js';
import { DEFAULT_CRITERIA } from './criteria.js';

/** 来源标记：**只给日志与调试用**（进消息的来源字段，不再写进正文——正文会被拿去做标题）。 */
export const PRELOAD_SOURCE = 'dsh-milieu:preload';
export const REREAD_SOURCE = 'dsh-milieu:reread';

export const DEFAULT_LIBS = { review: 'review', tools: 'tools', external: 'external' };

/** 时间：ISO 时刻（可回溯、可被日志重建）。 */
const iso = (now) => new Date(now).toISOString();

/**
 * **两段请求文本的默认模板 = 配置层的默认值。**
 *
 * 主人定的两条（2026-10-14）：
 *   · **时间在最前**——它是会话标题的来源，也是"这次阅读发生在什么时候"的凭据；
 *   · 任务要的是 **AI 自己说出来**（"简单说明自己读到的内容" / "简要说明认识前后的变化"），
 *     **不是写文档**——用户要在这儿直接看到 AI 的粗略认识，方便他后续处理。
 */
export const DEFAULT_TEXTS = {
  preload: ({ libs, stateFile, time }) => [
    '时间：' + time,
    '',
    '读一遍这个工作区，认一下它现在是什么状态，然后**简单说明自己读到的内容**。',
    '',
    '这是插件（dsh-milieu）发起的一次真实阅读，**不是用户的话**；不必写任何文档。',
    '从这一页开始：`' + stateFile + '`。',
    '**认知库（' + libs.review + '/）里的东西要仔细读**；其余库（' + libs.tools + '/、' + libs.external + '/）只看索引，自己决定读不读。',
  ].join('\n'),

  reread: ({ libs, changeIndex, events, activityAt, now, time, criteria = DEFAULT_CRITERIA }) => [
    '时间：' + time,
    '',
    // **两种视图**（2026-10-18）：有事件流就按"这条会话的新旧"决定给什么——
    //   30 天内给"文件名 + 大小变化"；超过 30 天：认知库只给文件名、其它库只给索引文件。
    //   没有事件流（旧数据/离线）就退回原来的路径清单。
    events
      ? renderChangeView({
          events, activityAt, now, libs,
          staleDays: criteria.staleDays,
          staleMaxReview: criteria.staleMaxReview,
        }).text
      : buildChangeIndexPrompt(changeIndex, libs),
    '',
    '请**简要说明认识前后的变化改动**，不必写任何文档。',
  ].join('\n'),
};

const pick = (templates, kind) => (templates && typeof templates[kind] === 'function' ? templates[kind] : DEFAULT_TEXTS[kind]);

/** 渲染一段模板：模板出错**不许把发送整条路带崩**——退回默认模板，并如实说出来。 */
function render(kind, ctx, templates) {
  const fn = pick(templates, kind);
  try {
    return String(fn(ctx));
  } catch (err) {
    if (fn !== DEFAULT_TEXTS[kind]) {
      try { return String(DEFAULT_TEXTS[kind](ctx)); } catch { /* 默认模板也炸：交给下面那句 */ }
    }
    return '[' + kind + '] 文本模板出错：' + String((err && err.message) || err) + '\n时间：' + ctx.time;
  }
}

/** 拼"第一次读工作区"的请求文本（预加载用）。 */
export function buildPreloadText({ libs = DEFAULT_LIBS, stateFileRelPath = 'review/milieu-state.json', now = Date.now(), templates } = {}) {
  return render('preload', { libs, stateFile: stateFileRelPath, time: iso(now) }, templates);
}

/** 拼"再读一遍"的请求文本（重读用）。带上变更视图（按会话新旧）：认知库细读、其余库给索引。 */
export function buildRereadText({ changeIndex, events, activityAt, libs = DEFAULT_LIBS, now = Date.now(), templates, criteria = DEFAULT_CRITERIA } = {}) {
  return render('reread', { libs, changeIndex, events, activityAt, now, time: iso(now), criteria }, templates);
}

/** 按用途选文本（两个半边共用这一个入口）。 */
export function buildReadText(kind, o = {}) {
  return kind === 'reread' ? buildRereadText(o) : buildPreloadText(o);
}
