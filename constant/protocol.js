// dsh-milieu —— 协议相关的固定值（不随部署变化；协议正文在包内 protocol/ 的三份 .md 里）
//
// 这些值被 `core/protocol.js`（文本拼装与同步）与 `protocol/version.js`（版本纯策略）共用。
// **改标记 = 换一份新协议**，不要随手改（ARCHITECTURE.md §9 不变契约 2）。

/** 托管段的开头标记（后面还会跟 `· fp:<指纹> -->`）。 */
export const BEGIN = '<!-- dsh-milieu:begin';

/** 托管段的结尾标记。 */
export const END = '<!-- dsh-milieu:end -->';

/** 协议层版本：写进托管段与协议文件的指纹头里（现有格式是 v1，不改）。 */
export const PROTO_VERSION = 'v1';

/**
 * 协议文件清单：源（插件包内 protocol/）→ 目标（工作区 `.dsh-milieu/`）→ 中文说明。
 * 源就是包内 `protocol/` 的三份 .md；`core/protocol.js` 负责按本表读取与写入。
 */
export const PROTOCOL_FILES = [
  ['protocol/DEFINITION.md', 'DEFINITION.md', '定义层（不可改）'],
  ['protocol/SUGGESTIONS.md', 'SUGGESTIONS.md', '建议层（可调）'],
  ['protocol/RATIONALE.md', 'RATIONALE.md', '原因层（为什么）'],
];
