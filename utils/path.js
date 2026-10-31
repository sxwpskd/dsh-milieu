// dsh-milieu —— 路径归一（纯工具：不读文件、不访问宿主、不改全局状态）

/**
 * 工作区身份：同一个 cwd 就是同一个工作区（插件拿不到 workspaceId，只拿得到 cwd）。
 * @param {string} cwd
 * @returns {string|null} 归一键，拿不到返回 null
 */
export function workspaceKey(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  // 统一分隔符与大小写：Windows 上同一个目录常有不带盘符大小写 / 斜杠方向两种写法
  return cwd.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}
