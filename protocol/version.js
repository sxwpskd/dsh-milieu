// dsh-milieu —— 协议**版本纯策略**（不读写文件、不调用宿主、不决定是否执行）
//
// 分工（ARCHITECTURE.md §6.5）：
//   · 本文件：协议 id / 版本号 / 指纹 / 头部解析 / 版本计划（install / leave / update / migrate / hold）；
//   · `constant/protocol.js`：标记常量与协议文件名；
//   · `core/protocol.js`：文本拼装与同步流程（读源文件、比较、写 `.dsh-milieu/` 与 `AGENTS.md`）。
//
// **不改变现有 v1 标记格式**（ARCHITECTURE.md §9 不变契约 2）：
//   托管段头：`<!-- dsh-milieu:begin v1 · fp:<指纹> -->`
//   协议文件头：`<!-- dsh-milieu:protocol v1 · fp:<指纹> · 这份是插件放的，…… -->`
// 本文件把这两个格式也放在**纯函数**里，`core/protocol.js` 只负责拼正文与落盘；
//   这样"格式错一个字就静默不幂等"的风险集中在一处。
import { fpOf } from '../utils/fingerprint.js';
import { BEGIN, PROTO_VERSION } from '../constant/protocol.js';

/** 协议 id（写进协议文件头；改它 = 换一份新协议）。 */
export const PROTOCOL_ID = 'dsh-milieu';

/** 协议版本号（数值形式，版本计划用；标记里用 `constant/protocol.js` 的 `v1` 字符串）。 */
export const PROTOCOL_VERSION = 1;

/** 定义正文 → 12 位指纹（sha256 前 12 位；"内容变没变"用这个）。 */
export function fingerprint(text) {
  return fpOf(String(text));
}

/** 托管段的"真标记"（`BEGIN` + 空格 + 版本）。只认完整标记、不按前缀（journal/020 教训）。 */
export function beginMark({ version = PROTO_VERSION } = {}) {
  return BEGIN + ' ' + version;
}

/** 托管段头：`<!-- dsh-milieu:begin v1 · fp:… -->`。 */
export function beginHeader({ version = PROTO_VERSION, fp } = {}) {
  if (!fp) throw new Error('beginHeader 缺 fp');
  return beginMark({ version }) + ' · fp:' + fp + ' -->';
}

/**
 * 协议文件头：`<!-- dsh-milieu:protocol v1 · fp:… · 这份是插件放的，可以读；改了会在下次会话开场被写回 -->`。
 * **逐字保持原格式**——它是"内容没变就一个字节都不写"的幂等判据。
 */
export function protocolHeader({ id = PROTOCOL_ID, version = PROTO_VERSION, fp } = {}) {
  if (!fp) throw new Error('protocolHeader 缺 fp');
  return '<!-- ' + id + ':protocol ' + version + ' · fp:' + fp
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
 * 版本计划：拿"已装的"与"源码这份"比，给出该做什么。
 *
 * **当前流程只用"写不写"的判据**（指纹相同就跳过），暂不执行迁移；
 * 这里是给以后升级/降级策略留的纯策略入口（ARCHITECTURE.md §10.1-5）。
 *
 * @param {{installed?:{version:number, fp:string}|null, incoming:{version:number, fp:string}, canMigrate?:boolean}} o
 * @returns {{action:'install'|'leave'|'update'|'migrate'|'hold'|'invalid', reason:string, from?:number, to?:number}}
 */
export function plan({ installed = null, incoming, canMigrate = false } = {}) {
  if (!incoming || !Number.isInteger(incoming.version) || !incoming.fp) {
    return { action: 'invalid', reason: 'incoming 缺版本或指纹' };
  }
  if (!installed) {
    return { action: 'install', reason: '尚未安装' };
  }
  if (installed.version > incoming.version) {
    return {
      action: 'hold',
      reason: '已装版本更高，不降级（' + installed.version + ' > ' + incoming.version + '）',
    };
  }
  if (installed.version === incoming.version) {
    if (installed.fp === incoming.fp) return { action: 'leave', reason: '已是最新' };
    return { action: 'update', reason: '同版本、内容变了' };
  }
  if (!canMigrate) {
    return {
      action: 'hold',
      reason: '版本升级需要迁移函数，未提供（' + installed.version + ' → ' + incoming.version + '）',
    };
  }
  return {
    action: 'migrate',
    reason: '版本升级',
    from: installed.version,
    to: incoming.version,
  };
}
