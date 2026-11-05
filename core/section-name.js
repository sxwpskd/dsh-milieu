// dsh-milieu —— **section 归属**（核心层纯策略：section 名唯一化 + 按会话工作区过滤）
//
// 多工作区 A 方案（WORKSPACE-MANAGEMENT.md §4）的两个硬门槛：
//   ① 每个工作区实例的 section 名必须**唯一**（官方 `system-prompt` 文档：重名会抛）；
//   ② 每个实例的注入函数只能给**自己工作区的会话**返回文本——否则多个实例互相注入对方的
//      状态页。过滤依据是 `AssembleContext.agent.session.header.cwd`（平台核查结论 #1）。
//
// 本文件不读文件、不访问宿主：只做路径归一与纯比较，便于离线测。
import { workspaceKey } from '../utils/path.js';

/** section 名前缀（人可读部分；后缀是稳定 hash）。 */
export const SECTION_PREFIX = 'dsh-milieu:workspace-state';

/** FNV-1a 32 位 → 8 位十六进制（稳定、短、只含 [0-9a-f]，可作 section 名后缀）。 */
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 工作区后缀：归一化路径的稳定短指纹；根还没确定（默认实例、空根）时用 `default`。
 * @param {string} root 工作区根
 * @returns {string}
 */
export function workspaceSectionSuffix(root) {
  const key = workspaceKey(root);
  if (!key) return 'default';
  return shortHash(key);
}

/**
 * 这个工作区实例应有的 section 名：`dsh-milieu:workspace-state:<8位hash>`。
 * @param {string} root 工作区根
 * @returns {string}
 */
export function workspaceSectionName(root) {
  return SECTION_PREFIX + ':' + workspaceSectionSuffix(root);
}

/**
 * 从 `AssembleContext` 里取会话工作区 cwd（平台形状：`context.agent.session.header.cwd`）。
 * 取不到 / 类型不对 / 读属性抛错 → null（调用方按"不注入"处理，绝不猜）。
 * @param {unknown} assembleContext
 * @returns {string|null}
 */
export function sessionCwdOf(assembleContext) {
  try {
    const agent = assembleContext && assembleContext.agent;
    const session = agent && agent.session;
    const header = session && session.header;
    const cwd = header && header.cwd;
    return typeof cwd === 'string' && cwd ? cwd : null;
  } catch {
    return null;
  }
}

/**
 * 这条 section 该不该给当前组装上下文注入？**相等才注入**：
 *   · 有 `agent.session.header.cwd` 且与实例 root 归一化后相等 → true；
 *   · 没有 agent / 没有 cwd / 路径不等 → false（裸组装不注入）。
 * @param {unknown} assembleContext
 * @param {string} root 实例工作区根
 * @returns {boolean}
 */
export function sectionMatchesRoot(assembleContext, root) {
  const rootKey = workspaceKey(root);
  if (!rootKey) return false;
  const cwdKey = workspaceKey(sessionCwdOf(assembleContext));
  if (!cwdKey) return false;
  return cwdKey === rootKey;
}
