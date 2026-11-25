// dsh-milieu —— 协议**版本纯策略**（不读写文件、不调用宿主、不决定是否执行）
//
// 分工（ARCHITECTURE.md §6.5）：
//   · 本文件：协议 id / 版本号 / 指纹 / 头部解析 / 版本计划（install / leave / update / switch / hold）；
//   · `constant/protocol.js`：标记常量、版本表、协议文件名；
//   · `core/protocol.js`：文本拼装与同步流程（读源文件、比较、写 `.dsh-milieu/` 与 `AGENTS.md`）。
//
// **标记格式**（ARCHITECTURE.md §9 不变契约 2；2.0 只多了一种版本，格式本身没变）：
//   托管段头：`<!-- dsh-milieu:begin v<版本> · fp:<指纹> -->`
//   协议文件头：`<!-- dsh-milieu:protocol v<版本> · fp:<指纹> · 这份是插件放的，…… -->`
// 本文件把这两个格式也放在**纯函数**里，`core/protocol.js` 只负责拼正文与落盘；
//   这样"格式错一个字就静默不幂等"的风险集中在一处。
import { fpOf } from '../utils/fingerprint.js';
import { BEGIN, DEFAULT_PROTOCOL_VERSION, END, PROTO_VERSIONS } from '../constant/protocol.js';

/** 协议 id（写进协议文件头；改它 = 换一份新协议）。 */
export const PROTOCOL_ID = 'dsh-milieu';

/** 默认协议版本号（数值形式；标记里用 `constant/protocol.js` 的 `v1` 字符串）。 */
export const PROTOCOL_VERSION = Number(DEFAULT_PROTOCOL_VERSION);

/** 定义正文 → 12 位指纹（sha256 前 12 位；"内容变没变"用这个）。 */
export function fingerprint(text) {
  return fpOf(String(text));
}

/**
 * 配置里的版本写法 → 版本 id（`'2'` / `2` / `'v2'` 都认）；不认识 → `null`。
 * 认不出来**不兜底**：调用方要如实报告，而不是悄悄按默认版本写。
 */
export function normalizeVersion(version) {
  const s = String(version ?? '').trim().replace(/^v/i, '');
  return Object.prototype.hasOwnProperty.call(PROTO_VERSIONS, s) ? s : null;
}

/** 版本 id → 托管段里的标记写法（`'2'` → `'v2'`）。 */
export function markOf(version) {
  const v = normalizeVersion(version);
  return v ? PROTO_VERSIONS[v].mark : null;
}

/** 托管段的"真标记"（`BEGIN` + 空格 + 版本）。只认完整标记、不按前缀（journal/020 教训）。 */
export function beginMark({ version = DEFAULT_PROTOCOL_VERSION } = {}) {
  const mark = markOf(version);
  if (!mark) throw new Error('未知协议版本：' + version);
  return BEGIN + ' ' + mark;
}

/** 托管段头：`<!-- dsh-milieu:begin v1 · fp:… -->`。 */
export function beginHeader({ version = DEFAULT_PROTOCOL_VERSION, fp } = {}) {
  if (!fp) throw new Error('beginHeader 缺 fp');
  return beginMark({ version }) + ' · fp:' + fp + ' -->';
}

/**
 * 协议文件头：`<!-- dsh-milieu:protocol v1 · fp:… · 这份是插件放的，可以读；改了会在下次会话开场被写回 -->`。
 * **逐字保持原格式**——它是"内容没变就一个字节都不写"的幂等判据。
 */
export function protocolHeader({ id = PROTOCOL_ID, version = DEFAULT_PROTOCOL_VERSION, fp } = {}) {
  if (!fp) throw new Error('protocolHeader 缺 fp');
  const mark = markOf(version);
  if (!mark) throw new Error('未知协议版本：' + version);
  return '<!-- ' + id + ':protocol ' + mark + ' · fp:' + fp
    + ' · 这份是插件放的，可以读；改了会在下次会话开场被写回 -->';
}

/** 解析协议文件头；不是我们的头 → null。 */
export function parseHeader(text) {
  const match = String(text || '').match(/<!--\s*([\w-]+):protocol\s+v(\d+)\s*·\s*fp:([0-9a-f]{12})/);
  if (!match) return null;
  return { id: match[1], version: Number(match[2]), fp: match[3] };
}

/** 解析托管段头；不是我们的头 → null。 */
export function parseBeginHeader(text) {
  const match = String(text || '').match(/<!--\s*dsh-milieu:begin\s+(v\d+)\s*·\s*fp:([0-9a-f]{12})\s*-->/);
  if (!match) return null;
  return { id: PROTOCOL_ID, version: Number(match[1].slice(1)), fp: match[2] };
}

/**
 * 找出文本里**所有**托管段（不限版本）。
 *
 * 2.0 的关键点：切版本时工作区里躺着的是**别的版本**的段，只按当前版本的完整标记去找
 * 会找不到，然后追加出第二段。所以"定位"必须与"当前版本"解耦。
 *
 * @returns {Array<{version:number, fp:string, start:number, end:number}>}
 */
export function findBlocks(text) {
  const s = String(text ?? '');
  // 指纹放宽到"任意字母数字"：真产物永远是 12 位 hex，但**定位**不该因为夹具里的短指纹就失灵
  // （2026-04 教训的反面：幂等靠的是"找到同一段"，不是"校验指纹格式"）。
  const re = /<!--\s*dsh-milieu:begin\s+v(\d+)\s*·\s*fp:([0-9A-Za-z]+)\s*-->/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const end = s.indexOf(END, m.index);
    if (end < 0) continue; // 只有头没有尾：交给调用方按"半截状态"处理
    out.push({ version: Number(m[1]), fp: m[2], start: m.index, end: end + END.length });
  }
  return out;
}

/** 工作区里**已装**的是哪一版（第一个托管段）；没有 → null。 */
export function detect(agentsText) {
  const [first] = findBlocks(agentsText);
  return first ? { version: first.version, fp: first.fp } : null;
}

/**
 * 版本计划：拿"已装的"与"源码这份"比，给出该做什么。
 *
 * 2.0 起**降级也是合法的切换**（用户可以随时切回 1.x），所以版本不同时不再一律 `hold`：
 *   · 有迁移函数（这里=调用方愿意整份替换）→ `switch`；
 *   · 没有 → `hold` 并说清被什么挡的。
 *
 * @param {{installed?:{version:number, fp:string}|null, incoming:{version:number, fp:string}, canMigrate?:boolean}} o
 * @returns {{action:'install'|'leave'|'update'|'switch'|'hold'|'invalid', reason:string, from?:number, to?:number}}
 */
export function plan({ installed = null, incoming, canMigrate = false } = {}) {
  if (!incoming || !Number.isInteger(incoming.version) || !incoming.fp) {
    return { action: 'invalid', reason: 'incoming 缺版本或指纹' };
  }
  if (!installed) {
    return { action: 'install', reason: '尚未安装' };
  }
  if (installed.version === incoming.version) {
    if (installed.fp === incoming.fp) return { action: 'leave', reason: '已是最新' };
    return { action: 'update', reason: '同版本、内容变了' };
  }
  if (!canMigrate) {
    return {
      action: 'hold',
      reason: '版本切换需要迁移函数，未提供（' + installed.version + ' → ' + incoming.version + '）',
    };
  }
  return {
    action: 'switch',
    reason: installed.version < incoming.version ? '版本升级' : '版本降级',
    from: installed.version,
    to: incoming.version,
  };
}
