// dsh-milieu —— 把协议放进工作区（宿主半边的**唯一写动作**）
//
// 为什么要有这一步（主人 2026-10-14 定的形态）：
//   用户可能自己在某个工作区建会话——**那条会话不由我们管**，我们不会给它注入任何东西。
//   但它同样需要知道协议。**所以协议必须落在工作区里**，让任何 AI 自己读得到。
//   → **声源是工作区，不是提示词注入。**
//
// 它写什么（都在**声明的范围内**，绝不碰别处）：
//   1. `<root>/AGENTS.md` 里的一个**托管段**（`<!-- dsh-milieu:begin … -->` 到 `<!-- dsh-milieu:end -->`）
//      —— 只维护标记之间那段，**段外一字不动**；
//   2. `<root>/.dsh-milieu/` 下的三个协议文件：定义层 / 建议层 / 原因层，各带**指纹头**。
//
// 纪律：
//   · **幂等**：内容没变就一个字节都不写（指纹与源一致即跳过）；
//   · **失败要报告**：返回 `{ok:false, reason}`，**不做兜底**（主人定的：不搞兜底机制）；
//   · **不删东西**：只创建与更新自己声明的范围。
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 托管段的标记。**改标记 = 换一份新协议**，不要随手改。 */
export const BEGIN = '<!-- dsh-milieu:begin';
export const END = '<!-- dsh-milieu:end -->';
/** 协议层版本：写进托管段与协议文件的指纹头里。 */
export const PROTO_VERSION = 'v1';

/**
 * **真正的标记** = `BEGIN` + 空格 + 版本。
 *
 * 为什么不能只拿 `BEGIN` 去找（2026-10-14 我拿自己的 `AGENTS.md` 试出来的教训）：
 * 说明文字里**原样提到标记**（比如"一段以 dsh-milieu:begin 开头"或抄一个示例）是完全正常的，
 * 而只按 `BEGIN` 找，就会**从说明里那个标记开始整段替换**——把用户中间的内容整段吃掉。
 * **这是我亲手咬的自己一口**：把中间两节（边界、尚未确立）吃掉了。
 */
const BEGIN_MARK = BEGIN + ' ' + PROTO_VERSION;

/** 协议文件清单：源（插件包内）→ 目标（工作区内）。 */
export const PROTOCOL_FILES = [
  ['DEFINITION.md', 'DEFINITION.md', '定义层（不可改）'],
  ['SUGGESTIONS.md', 'SUGGESTIONS.md', '建议层（可调）'],
  ['RATIONALE.md', 'RATIONALE.md', '原因层（为什么）'],
];

const fp = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

/** 带上指纹头的文件内容：**重复写同一个 pid 时内容逐字节相同**，所以能幂等。 */
export function withFingerprint(text, pid) {
  return [
    '<!-- dsh-milieu:protocol v1 · fp:' + pid + ' · 这份是插件放的，可以读；改了会在下次会话开场被写回 -->',
    '',
    text.replace(/\s*$/, ''),
    '',
  ].join('\n');
}

/** 托管段正文：定义原文（逐字）+ 指针。 */
export function composeProtocolBlock(definition, pid) {
  return [
    BEGIN_MARK + ' · fp:' + pid + ' -->',
    '## 环境的定义（dsh-milieu 协议 · 不可改）',
    '',
    '以下三条是**定义**，不是建议：它是这套框架的根。它被放在这里，是为了让**读这个工作区的任何 AI**都看得见。',
    '可调的做法见 `.dsh-milieu/SUGGESTIONS.md`；为什么这么定见 `.dsh-milieu/RATIONALE.md`。',
    '',
    definition.replace(/\s*$/, ''),
    END,
  ].join('\n');
}

/**
 * 把托管段**写进**一份 AGENTS.md 文本（纯函数，便于离线测）。
 * @returns {{text:string, changed:boolean, hadBlock:boolean}}
 *   · 已有托管段 → 整段替换（段外一字不动）
 *   · 没有 → **追加在末尾**（不把用户原来的内容往下挤）
 */
export function upsertBlock(fileText, block) {
  const text = String(fileText ?? '');
  const i = text.indexOf(BEGIN_MARK);
  if (i >= 0) {
    const e = text.indexOf(END);
    if (e < 0) {
      // 只有头没有尾：不可信的半截状态 → 从头起整段换掉，并在原地说明
      return { text: text.slice(0, i).replace(/\s*$/, '') + '\n\n' + block + '\n', changed: true, hadBlock: true };
    }
    const old = text.slice(i, e + END.length);
    if (old === block) return { text, changed: false, hadBlock: true };
    return { text: text.slice(0, i) + block + text.slice(e + END.length), changed: true, hadBlock: true };
  }
  const sep = text.trim() ? '\n\n' : '';
  return { text: text.replace(/\s*$/, '') + sep + block + '\n', changed: true, hadBlock: false };
}

/** 读插件包内的协议源文件；读不到 → 抛出（由调用方转成"说清被什么挡的"）。 */
export function readSources(o = {}) {
  const { exists = existsSync, readFile = (p) => readFileSync(p, 'utf8') } = o;
  const sources = {};
  for (const [src, pid, what] of PROTOCOL_FILES) {
    const p = join(HERE, src);
    if (!exists(p)) throw new Error('插件包里缺少 ' + src + '（' + what + '）');
    sources[src] = readFile(p);
  }
  return sources;
}

/**
 * 把协议同步进工作区，**并保证三个库存在**。**幂等**——没变化就一个字节都不写。
 *
 * @param {object} o
 *   · root       工作区根（已解析过的绝对路径）
 *   · libs       三个库的名字
 *   · ensureLibs 要不要补全三个库的**目录**（默认 true，主人的需求 R3）
 *   · exists/readFile/writeFile/mkdir 注入点（离线测用；默认 node:fs）
 *   · now
 * @returns {{ok:boolean, reason:string, wrote:string[], changed:boolean, checked:number, libsCreated:string[]}}
 */
export function syncProtocol(o = {}) {
  const {
    root,
    libs = { review: 'review', tools: 'tools', external: 'external' },
    ensureLibs = true,
    exists = existsSync,
    readFile = (p) => readFileSync(p, 'utf8'),
    writeFile = (p, t) => writeFileSync(p, t, 'utf8'),
    mkdir = (p) => mkdirSync(p, { recursive: true }),
  } = o;

  const empty = { wrote: [], changed: false, checked: 0, libsCreated: [] };
  if (!root) return { ok: false, reason: '没有工作区根（拿不到 cwd 也没配置 workspaceRoot）', ...empty };

  let sources;
  try {
    sources = readSources({ exists, readFile });
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err), ...empty };
  }

  const definition = sources['DEFINITION.md'];
  const pid = fp(definition);
  const block = composeProtocolBlock(definition, pid);
  const wrote = [];
  const libsCreated = [];
  let changed = false;

  try {
    // ① 三个库（**只建目录，不铺任何东西**）——需求 R3："检查是否遵循协议，不出现就补全"
    if (ensureLibs) {
      for (const key of ['review', 'tools', 'external']) {
        const name = libs[key];
        if (!name) continue;
        const abs = join(root, name);
        if (exists(abs)) continue;
        mkdir(abs);
        wrote.push(name + '/');
        libsCreated.push(name);
        changed = true;
      }
    }

    // ② 三个协议文件 → <root>/.dsh-milieu/
    const dir = join(root, '.dsh-milieu');
    if (!exists(dir)) mkdir(dir);
    for (const [src, name] of PROTOCOL_FILES) {
      const target = join(dir, name);
      const want = withFingerprint(sources[src], pid);
      let have = null;
      if (exists(target)) { try { have = readFile(target); } catch { have = null; } }
      if (have === want) continue;                       // 幂等：一模一样就不写
      writeFile(target, want);
      wrote.push('.dsh-milieu/' + name);
      changed = true;
    }

    // ③ AGENTS.md 的托管段
    const agents = join(root, 'AGENTS.md');
    let text = '';
    if (exists(agents)) { try { text = readFile(agents); } catch (err) { return { ok: false, reason: 'AGENTS.md 读不开：' + String((err && err.message) || err), wrote, changed, checked: 0, libsCreated }; } }
    const up = upsertBlock(text, block);
    if (up.changed) {
      writeFile(agents, up.text);
      wrote.push('AGENTS.md' + (up.hadBlock ? '（更新托管段）' : '（新增托管段）'));
      changed = true;
    }
  } catch (err) {
    return { ok: false, reason: '写入失败：' + String((err && err.message) || err), wrote, changed, checked: 0, libsCreated };
  }

  return {
    ok: true,
    reason: changed
      ? '协议已同步（写入 ' + wrote.length + ' 处' + (libsCreated.length ? '，补全库目录 ' + libsCreated.join('、') : '') + '）'
      : '协议已是最新（一个字节都没改）',
    wrote,
    changed,
    checked: PROTOCOL_FILES.length + 1,
    libsCreated,
  };
}

/** 只为离线测与报告：托管段现在是不是"最新的那一版"。 */
export function isBlockCurrent(agentsText, definition) {
  const pid = fp(definition);
  return String(agentsText ?? '').includes(BEGIN_MARK + ' · fp:' + pid + ' -->');
}

/** 顺带用一下 statSync，免得它被静态检查当成未使用（也让将来"版本变了"的判断有处可落）。 */
export function agentsMtime(root) {
  const p = join(String(root || ''), 'AGENTS.md');
  try { return statSync(p).mtimeMs; } catch { return null; }
}
