// dsh-milieu —— 协议相关的固定值（不随部署变化；协议正文在包内 `protocol/<版本>/` 里）
//
// 这些值被 `core/protocol.js`（文本拼装与同步）与 `protocol/version.js`（版本纯策略）共用。
// **改标记 = 换一份新协议**，不要随手改（ARCHITECTURE.md §9 不变契约 2）。
//
// 2.0 起包内按**版本目录**存放协议：`protocol/1.0/`、`protocol/2.0/`，每个版本是
// **一份完整的四文件集合**（DEFINITION / RULES / SUGGESTIONS / RATIONALE）。
// 没有"公共文件"这种特例：RULES.md 与版本无关，所以每个版本目录里各放一份完整副本。

/** 托管段的开头标记（后面还会跟 ` <mark> · fp:<指纹> -->`）。 */
export const BEGIN = '<!-- dsh-milieu:begin';

/** 托管段的结尾标记。 */
export const END = '<!-- dsh-milieu:end -->';

/** 协议文件清单：**每个版本都必须提供这四份**（顺序即写入顺序）。 */
export const PROTOCOL_FILE_NAMES = Object.freeze(['DEFINITION.md', 'RULES.md', 'SUGGESTIONS.md', 'RATIONALE.md']);

/** 每份文件的中文说明（缺文件时报错用）。 */
export const PROTOCOL_FILE_WHAT = Object.freeze({
  'DEFINITION.md': '定义层（不可改）',
  'RULES.md': '规则层（协议自带）',
  'SUGGESTIONS.md': '建议层（可调）',
  'RATIONALE.md': '原因层（为什么）',
});

/**
 * 协议版本表：配置值 → 包内源目录 + 托管段里的标记写法。
 * **加一个版本 = 加一段配置 + 一个目录**，不要改别的版本的目录。
 */
export const PROTO_VERSIONS = Object.freeze({
  '1': { dir: 'protocol/1.0', mark: 'v1' },
  '2': { dir: 'protocol/2.0', mark: 'v2' },
});

/** 配置没写 `protocolVersion` 时用哪一版：**v1**（不打扰已有工作区，R-09）。 */
export const DEFAULT_PROTOCOL_VERSION = '1';

/** 所有已知版本 id（升序）。 */
export const PROTOCOL_VERSION_IDS = Object.freeze(Object.keys(PROTO_VERSIONS).sort());

/** 某版本的源文件表：`[[包内相对路径, 工作区文件名, 中文说明], …]`。 */
export function protocolFiles(version = DEFAULT_PROTOCOL_VERSION) {
  const v = PROTO_VERSIONS[version];
  if (!v) return [];
  return PROTOCOL_FILE_NAMES.map((name) => [v.dir + '/' + name, name, PROTOCOL_FILE_WHAT[name]]);
}

/**
 * 兼容旧的单版本引用（1.x 的代码/测试可能还在用这两个名字）。
 * 新代码请用 `protocolFiles(version)`。
 */
export const PROTO_VERSION = PROTO_VERSIONS[DEFAULT_PROTOCOL_VERSION].mark; // 'v1'
export const PROTOCOL_FILES = Object.freeze(protocolFiles(DEFAULT_PROTOCOL_VERSION));
