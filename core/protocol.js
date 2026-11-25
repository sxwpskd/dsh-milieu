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
//   2. `<root>/.dsh-milieu/` 下的四份协议文件：定义 / 规则 / 建议 / 原因，各带**指纹头**。
//      写哪四份由**配置指向的协议版本**决定（`protocolVersion`；见 PROTOCOL-2.0.md R-01/R-02）。
//
// 分工（ARCHITECTURE.md §6.3）：
//   · 版本、指纹、头部格式、版本计划 → `protocol/version.js`（纯策略）；
//   · 标记常量、版本表、协议文件名 → `constant/protocol.js`；
//   · 文件读写 → 通过参数传入的 `fs` 能力（`adapter/fs.js` 的实现），本文件不 import 'node:fs'。
//
// 纪律：
//   · **幂等**：内容没变就一个字节都不写（指纹与源一致即跳过）；
//   · **失败要报告**：返回 `{ok:false, reason}`，**不做兜底**（主人定的：不搞兜底机制）；
//   · **不删东西**：只创建与更新自己声明的范围（切版本也不删另一版留下的文件）。
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { END, PROTOCOL_FILE_NAMES, DEFAULT_PROTOCOL_VERSION, protocolFiles } from '../constant/protocol.js';
import { beginHeader, protocolHeader, fingerprint, normalizeVersion, findBlocks, markOf } from '../protocol/version.js';
import { fail } from '../exception/result.js';
import { normalizeError } from '../exception/normalize.js';
import { CODES } from '../exception/codes.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';

// **源文件在包内 `protocol/<版本>/`**（定义 / 规则 / 建议 / 原因）。
// 本文件住在 core/ 里——这里**上溯到包根**再拼源路径，
// 否则"读不到协议源文件"，整个协议同步都会失败（重构时最容易静默坏掉的一处）。
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');

/** 1.x 的库只有三个（2.0 才要求六个）。用"版本决定至少哪些库"实现 R-09：装 2.0 不升版本，老工作区一个目录都不多。 */
const LIB_KEYS_V1 = ['review', 'external', 'tools'];

/** 托管段正文里那句"规则在哪"（2.0 才写；v1 的段保持逐字不变，见 R-09）。 */
const RULES_POINTER = '**规则**：协议自带的一条见 `.dsh-milieu/RULES.md`；'
  + '本工作区当前生效的规则见 `rules/INDEX.md`（规则库是当前行动约束的唯一来源）。';

/** 带上指纹头的文件内容：**重复写同一个 pid 时内容逐字节相同**，所以能幂等。 */
export function withFingerprint(text, pid, version = DEFAULT_PROTOCOL_VERSION) {
  return [
    protocolHeader({ version, fp: pid }),
    '',
    text.replace(/\s*$/, ''),
    '',
  ].join('\n');
}

/**
 * 托管段正文：定义原文（逐字）+ 指针。
 *
 * **v1 的产出必须逐字不变**：已有工作区的段是按它算指纹的，改一个字就等于"内容变了"，
 * 会让所有 1.x 工作区在下次开场被重写一遍。v2 才多一句规则入口（PROTOCOL-2.0.md R-06）。
 */
export function composeProtocolBlock(definition, pid, version = DEFAULT_PROTOCOL_VERSION) {
  const v = normalizeVersion(version) || DEFAULT_PROTOCOL_VERSION;
  const lines = [
    beginHeader({ version: v, fp: pid }),
    '## 环境的定义（dsh-milieu 协议 · 不可改）',
    '',
    '以下三条是**定义**，不是建议：它是这套框架的根。它被放在这里，是为了让**读这个工作区的任何 AI** 都看得见。',
    '可调的做法见 `.dsh-milieu/SUGGESTIONS.md`；为什么这么定见 `.dsh-milieu/RATIONALE.md`。',
    '',
  ];
  if (v !== '1') {
    lines.push(RULES_POINTER, '');
  }
  lines.push(definition.replace(/\s*$/, ''), END);
  return lines.join('\n');
}

/**
 * 把托管段**写进**一份 AGENTS.md 文本（纯函数，便于离线测）。
 * @returns {{text:string, changed:boolean, hadBlock:boolean, migrated:boolean}}
 *   · 已有托管段（**任何版本**）→ 整段替换（段外一字不动）
 *   · 没有 → **追加在末尾**（不把用户原来的内容往下挤）
 *   · `migrated` = 原来那段的版本与这次写的不一样（切版本）
 */
export function upsertBlock(fileText, block, version = DEFAULT_PROTOCOL_VERSION) {
  const text = String(fileText ?? '');
  const want = normalizeVersion(version) || DEFAULT_PROTOCOL_VERSION;
  const blocks = findBlocks(text);

  if (blocks.length) {
    const b = blocks[0];
    const old = text.slice(b.start, b.end);
    const migrated = Number(b.version) !== Number(want);
    if (old === block) return { text, changed: false, hadBlock: true, migrated: false };
    return {
      text: text.slice(0, b.start) + block + text.slice(b.end),
      changed: true,
      hadBlock: true,
      migrated,
    };
  }

  // 只有头没有尾：不可信的半截状态 → 从头起整段换掉，并在原地说明
  const beginAt = text.search(/<!--\s*dsh-milieu:begin\s+v\d+/);
  if (beginAt >= 0) {
    return {
      text: text.slice(0, beginAt).replace(/\s*$/, '') + '\n\n' + block + '\n',
      changed: true,
      hadBlock: true,
      migrated: false,
    };
  }

  const sep = text.trim() ? '\n\n' : '';
  return { text: text.replace(/\s*$/, '') + sep + block + '\n', changed: true, hadBlock: false, migrated: false };
}

/**
 * 读插件包内**某一版**的协议源文件；读不到 → 抛出（由调用方转成"说清被什么挡的"）。
 * 返回按**目标文件名**（DEFINITION.md / RULES.md / …）索引。
 * @param {{exists:Function, readText:Function}} fs 文件系统能力（只需要这两项）
 * @param {string} version 版本 id（'1' / '2'）
 */
export function readSources({ exists, readText } = {}, version = DEFAULT_PROTOCOL_VERSION) {
  const files = protocolFiles(version);
  if (!files.length) throw new Error('未知协议版本：' + version + '（包里没有这一版）');
  const sources = {};
  for (const [src, name, what] of files) {
    const path = join(PACKAGE_DIR, src);
    if (!exists(path)) throw new Error('插件包里缺少 ' + src + '（' + what + '）');
    sources[name] = readText(path);
  }
  return sources;
}

/**
 * 把协议同步进工作区，**并保证库目录存在**。**幂等**——没变化就一个字节都不写。
 *
 * @param {object} o
 *   · root            工作区根（已解析过的绝对路径）
 *   · protocolVersion 写哪一版（默认 `'1'`；未知值 → 失败，不兜底）
 *   · libs            库名表（2.0 起六个键；见 config/defaults.js）
 *   · ensureLibs      要不要补全库的**目录**（默认 true，主人的需求 R3）
 *   · fs              文件系统能力（`adapter/fs.js` 的 `createFs()`；本层不 import 'node:fs'）
 *   · now             保留给以后（当前写入内容不依赖时间，保持幂等）
 * @returns {{ok:boolean, reason:string, wrote:string[], changed:boolean, checked:number, libsCreated:string[], version?:string, migrated?:boolean}}
 */
export function syncProtocol(o = {}) {
  const {
    root,
    protocolVersion = DEFAULT_PROTOCOL_VERSION,
    libs = DEFAULT_CONFIG.libs,
    ensureLibs = true,
    fs = null,
  } = o;

  const empty = { wrote: [], changed: false, checked: 0, libsCreated: [] };
  if (!root) return { ...fail('没有工作区根（拿不到 cwd 也没配置 workspaceRoot）', 'config', CODES.CONFIG_INVALID), ...empty };
  if (!fs) return { ...fail('没有文件系统能力（fs），不能同步协议', 'fs', CODES.FS_UNAVAILABLE), ...empty };

  const version = normalizeVersion(protocolVersion);
  if (!version) {
    return {
      ...fail('未知协议版本 protocolVersion=' + JSON.stringify(protocolVersion)
        + '（支持：1 / 2）；没有按默认版本静默处理', 'config', CODES.CONFIG_INVALID),
      ...empty,
    };
  }

  let sources;
  try {
    sources = readSources({ exists: fs.exists, readText: fs.readText }, version);
  } catch (err) {
    // 写入边界（task-5）：异常归一成带错误码的失败结果；**reason 文案不变**。
    const failure = normalizeError(err, { code: CODES.PROTOCOL_SOURCE_MISSING, blockedBy: 'fs' });
    return { ...failure, ...empty };
  }

  const definition = sources['DEFINITION.md'];
  const pid = fingerprint(definition);
  const block = composeProtocolBlock(definition, pid, version);
  const files = protocolFiles(version);
  const wrote = [];
  const libsCreated = [];
  let changed = false;
  let migrated = false;

  try {
    // ① 库目录（**只建目录，不铺任何东西**）——需求 R3："检查是否遵守协议，不出现就补全"
    //    2.0：库从三个扩到六个；**只补缺的**，多出来的目录一律不动（"至少"语义）。
    //    版本决定"至少哪些库"：1.x 只要三个，2.0 才要六个——所以装 2.0 但没升版本时，
    //    老工作区一个目录都不多（R-09：默认什么都不变）。
    const libEntries = Object.entries(libs || {}).filter(([key, name]) => name
      && (String(version) === '1' ? LIB_KEYS_V1.includes(key) : true));
    if (ensureLibs) {
      for (const [key, name] of libEntries) {
        if (!name) continue;
        const abs = join(root, name);
        if (fs.exists(abs)) continue;
        fs.mkdirp(abs);
        wrote.push(name + '/');
        libsCreated.push(key);
        changed = true;
      }
    }

    // ② 协议文件 → <root>/.dsh-milieu/（该版本的四份；别的版本留下的不动）
    const dir = join(root, '.dsh-milieu');
    if (!fs.exists(dir)) fs.mkdirp(dir);
    for (const [, name] of files) {
      const target = join(dir, name);
      const want = withFingerprint(sources[name], pid, version);
      let have = null;
      if (fs.exists(target)) {
        try { have = fs.readText(target); } catch { have = null; }
      }
      if (have === want) continue; // 幂等：一模一样就不写
      fs.writeText(target, want);
      wrote.push('.dsh-milieu/' + name);
      changed = true;
    }

    // ②b 规则库索引：2.0 才有规则库。工作区里没有 <rules>/INDEX.md 时，
    //     把协议自带的 RULES.md **原样复制一份**当作规则库的起点（主人的口径：每个受管工作区
    //     都有 .dsh-milieu/RULES.md，直接复制它就行）。只种一次：之后那份归工作区自己，
    //     改了也不会被插件写回——所以这里不带托管头，也绝不覆盖。
    //     唯一的改写：RULES.md 里指向同目录协议文件的相对链接（如 `RATIONALE.md`），
    //     复制到 <rules>/ 之后要指回 `.dsh-milieu/`，否则成了死链。
    const rulesLib = libEntries.find(([key]) => key === 'rules');
    if (rulesLib && sources['RULES.md'] !== undefined) {
      const rulesDir = join(root, rulesLib[1]);
      const index = join(rulesDir, 'INDEX.md');
      if (!fs.exists(index)) {
        if (!fs.exists(rulesDir)) fs.mkdirp(rulesDir);
        const src = sources['RULES.md']
          .replace(/\]\(((?:DEFINITION|RULES|SUGGESTIONS|RATIONALE)\.md)\)/g, '](../.dsh-milieu/$1)');
        fs.writeText(index, /\n$/.test(src) ? src : src + '\n');
        wrote.push(rulesLib[1] + '/INDEX.md（从协议自带的 RULES.md 复制）');
        changed = true;
      }
    }

    // ③ AGENTS.md 的托管段（任何版本的旧段都会被整段替换，不追加第二段）
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
    const up = upsertBlock(text, block, version);
    migrated = up.migrated;
    if (up.changed) {
      fs.writeText(agents, up.text);
      wrote.push('AGENTS.md' + (up.migrated
        ? '（托管段迁移到 ' + markOf(version) + '）'
        : up.hadBlock ? '（更新托管段）' : '（新增托管段）'));
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
      ? '协议已同步（' + markOf(version) + '，写入 ' + wrote.length + ' 处'
        + (libsCreated.length ? '，补全库目录 ' + libsCreated.join('、') : '') + '）'
      : '协议已是最新（一个字节都没改）',
    wrote,
    changed,
    checked: files.length + 1,
    libsCreated,
    version,
    migrated,
  };
}

/** 只为离线测与报告：托管段现在是不是"最新的那一版"（按当前版本的指纹判）。 */
export function isBlockCurrent(agentsText, definition, version = DEFAULT_PROTOCOL_VERSION) {
  const pid = fingerprint(definition);
  const mark = markOf(version);
  if (!mark) return false;
  return String(agentsText ?? '').includes('<!-- dsh-milieu:begin ' + mark + ' · fp:' + pid + ' -->');
}

export { PROTOCOL_FILE_NAMES };
