// dsh-milieu —— 协议文本与同步流程（核心层：不 import 'node:fs'，读写走能力对象）
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
// 分工（ARCHITECTURE.md §6.3）：
//   · 版本、指纹、头部格式 → `protocol/version.js`（纯策略）；
//   · 标记常量、协议文件名 → `constant/protocol.js`；
//   · 文件读写 → 通过参数传入的 `fs` 能力（`adapter/fs.js` 的实现），本文件不 import 'node:fs'。
//
// 纪律：
//   · **幂等**：内容没变就一个字节都不写（指纹与源一致即跳过）；
//   · **失败要报告**：返回 `{ok:false, reason}`，**不做兜底**（主人定的：不搞兜底机制）；
//   · **不删东西**：只创建与更新自己声明的范围。
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { END, PROTO_VERSION, PROTOCOL_FILES } from '../constant/protocol.js';
import { beginMark, beginHeader, protocolHeader, fingerprint } from '../protocol/version.js';
import { fail } from '../exception/result.js';
import { normalizeError } from '../exception/normalize.js';
import { CODES } from '../exception/codes.js';

// **源文件在包根**（DEFINITION.md / SUGGESTIONS.md / RATIONALE.md）。
// 本文件原来住在包根，搬进 core/ 后 HERE 少了一层——这里**上溯到包根**再拼源路径，
// 否则"读不到协议源文件"，整个协议同步都会失败（重构时最容易静默坏掉的一处）。
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');

/**
 * **真正的标记** = `BEGIN` + 空格 + 版本（`constant` 与 `version` 各管一半，这里合成一处）。
 * 为什么不能只拿 `BEGIN` 去找（2026-10-14 我拿自己的 `AGENTS.md` 试出来的教训）：
 *   说明文字里**原样提到标记**是完全正常的；只按 `BEGIN` 找，就会从说明里那个标记开始整段替换，
 *   把用户中间的内容整段吃掉。所以只认"完整标记 + 版本"。
 */
const BEGIN_MARK = beginMark({ version: PROTO_VERSION });

/** 带上指纹头的文件内容：**重复写同一个 pid 时内容逐字节相同**，所以能幂等。 */
export function withFingerprint(text, pid) {
  return [
    protocolHeader({ fp: pid }),
    '',
    text.replace(/\s*$/, ''),
    '',
  ].join('\n');
}

/** 托管段正文：定义原文（逐字）+ 指针。 */
export function composeProtocolBlock(definition, pid) {
  return [
    beginHeader({ version: PROTO_VERSION, fp: pid }),
    '## 环境的定义（dsh-milieu 协议 · 不可改）',
    '',
    '以下三条是**定义**，不是建议：它是这套框架的根。它被放在这里，是为了让**读这个工作区的任何 AI** 都看得见。',
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
  const begin = text.indexOf(BEGIN_MARK);
  if (begin >= 0) {
    const end = text.indexOf(END);
    if (end < 0) {
      // 只有头没有尾：不可信的半截状态 → 从头起整段换掉，并在原地说明
      return { text: text.slice(0, begin).replace(/\s*$/, '') + '\n\n' + block + '\n', changed: true, hadBlock: true };
    }
    const old = text.slice(begin, end + END.length);
    if (old === block) return { text, changed: false, hadBlock: true };
    return { text: text.slice(0, begin) + block + text.slice(end + END.length), changed: true, hadBlock: true };
  }
  const sep = text.trim() ? '\n\n' : '';
  return { text: text.replace(/\s*$/, '') + sep + block + '\n', changed: true, hadBlock: false };
}

/**
 * 读插件包内的协议源文件；读不到 → 抛出（由调用方转成"说清被什么挡的"）。
 * @param {{exists:Function, readText:Function}} fs 文件系统能力（只需要这两项）
 */
export function readSources({ exists, readText } = {}) {
  const sources = {};
  for (const [src, , what] of PROTOCOL_FILES) {
    const path = join(PACKAGE_DIR, src);
    if (!exists(path)) throw new Error('插件包里缺少 ' + src + '（' + what + '）');
    sources[src] = readText(path);
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
 *   · fs         文件系统能力（`adapter/fs.js` 的 `createFs()`；本层不 import 'node:fs'）
 *   · now        保留给以后（当前写入内容不依赖时间，保持幂等）
 * @returns {{ok:boolean, reason:string, wrote:string[], changed:boolean, checked:number, libsCreated:string[]}}
 */
export function syncProtocol(o = {}) {
  const {
    root,
    libs = { review: 'review', tools: 'tools', external: 'external' },
    ensureLibs = true,
    fs = null,
  } = o;

  const empty = { wrote: [], changed: false, checked: 0, libsCreated: [] };
  if (!root) return { ...fail('没有工作区根（拿不到 cwd 也没配置 workspaceRoot）', 'config', CODES.CONFIG_INVALID), ...empty };
  if (!fs) return { ...fail('没有文件系统能力（fs），不能同步协议', 'fs', CODES.FS_UNAVAILABLE), ...empty };

  let sources;
  try {
    sources = readSources({ exists: fs.exists, readText: fs.readText });
  } catch (err) {
    // 写入边界（task-5）：异常归一成带错误码的失败结果；**reason 文案不变**。
    const failure = normalizeError(err, { code: CODES.PROTOCOL_SOURCE_MISSING, blockedBy: 'fs' });
    return { ...failure, ...empty };
  }

  const definition = sources['DEFINITION.md'];
  const pid = fingerprint(definition);
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
        if (fs.exists(abs)) continue;
        fs.mkdirp(abs);
        wrote.push(name + '/');
        libsCreated.push(name);
        changed = true;
      }
    }

    // ② 三个协议文件 → <root>/.dsh-milieu/
    const dir = join(root, '.dsh-milieu');
    if (!fs.exists(dir)) fs.mkdirp(dir);
    for (const [src, name] of PROTOCOL_FILES) {
      const target = join(dir, name);
      const want = withFingerprint(sources[src], pid);
      let have = null;
      if (fs.exists(target)) {
        try { have = fs.readText(target); } catch { have = null; }
      }
      if (have === want) continue; // 幂等：一模一样就不写
      fs.writeText(target, want);
      wrote.push('.dsh-milieu/' + name);
      changed = true;
    }

    // ③ AGENTS.md 的托管段
    const agents = join(root, 'AGENTS.md');
    let text = '';
    if (fs.exists(agents)) {
      try {
        text = fs.readText(agents);
      } catch (err) {
        const failure = normalizeError(err, { code: CODES.FS_READ_FAILED, blockedBy: 'fs' });
        return { ...failure, reason: 'AGENTS.md 读不开：' + failure.reason, wrote, changed, checked: 0, libsCreated };
      }
    }
    const up = upsertBlock(text, block);
    if (up.changed) {
      fs.writeText(agents, up.text);
      wrote.push('AGENTS.md' + (up.hadBlock ? '（更新托管段）' : '（新增托管段）'));
      changed = true;
    }
  } catch (err) {
    // 写入边界（task-5）：失败带稳定错误码；**reason 文案不变**。
    const failure = normalizeError(err, { code: CODES.PROTOCOL_WRITE_FAILED, blockedBy: 'fs' });
    return { ...failure, reason: '写入失败：' + failure.reason, wrote, changed, checked: 0, libsCreated };
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
  const pid = fingerprint(definition);
  return String(agentsText ?? '').includes(BEGIN_MARK + ' · fp:' + pid + ' -->');
}
