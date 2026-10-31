// dsh-milieu —— 工作区根的**选择**（纯策略：不写文件、不建会话、不读配置）
//
// 从 `index.js` 的 `pickWorkspaceRoot` 搬出来（ARCHITECTURE.md §6.3）。
// 输入是**适配层归一后的路径表**（有序）与进程 cwd；输出是选中的那个路径或 null。
//
// 规则（2026-10-19 主人定：工作区定位问平台，简单点）：
//   · 只有一个工作区 → 就用它；
//   · 多个 → 先看 cwd 是否正好命中，否则用平台顺序里的第一个（并写进日志，便于发现）；
//   · 一个都没有 → null，**调用方不写任何文件**（不让插件往应用目录里写）。

/** 同一个路径的不同拼法（斜杠 / 大小写 / 末尾斜杠）算同一个。 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * @param {string[]} workspacePaths 平台工作区路径表（有序；适配层已归一成绝对路径）
 * @param {string} cwd 进程当前目录（根的最后兜底线索）
 * @returns {string|null} 选中的工作区根；一个都没有 → null
 */
export function pickWorkspaceRoot(workspacePaths, cwd) {
  const paths = Array.isArray(workspacePaths)
    ? workspacePaths.filter((p) => typeof p === 'string' && p)
    : [];
  if (paths.length === 1) return paths[0];
  if (paths.length > 1) {
    const hit = paths.find((p) => samePath(p, cwd));
    return hit || paths[0];
  }
  return null;
}
