// dsh-milieu —— 默认配置与归并（config 层：不 import core/、model/、ui/，不访问宿主）
//
// 为什么把默认值从 `index.js` 搬到这里（ARCHITECTURE.md §6.5 / §10.1-4）：
//   · 入口只做装配，不该背着"默认值表"；
//   · **`texts` 不在这里**：它是函数（`core/texts.js` 的 `DEFAULT_TEXTS`），由 `core/boot.js`
//     在装配时合并——`config/` 依赖 `core/` 会形成反向依赖。
//   · `criteria` 的默认值与合并只有一处（`config/criteria.js`），这里只引用。
import { DEFAULT_CRITERIA, mergeCriteria } from './criteria.js';

/**
 * 默认配置（**除 `texts` 外**）。
 *
 * 字段与 `cordis.patch.yml` 补丁层一一对应；发布默认值刻意保守：
 *   · `workspaceRoot` 留空 = 问平台要工作区（别人机器上没有本机路径）；
 *   · `preloadSession` 默认关 = 它会真跑一次 agent（花钱、动会话列表），本机验证时才开。
 */
export const DEFAULT_CONFIG = {
  libs: { review: 'review', tools: 'tools', external: 'external' },
  statePath: 'STATE.md',
  injectState: true,
  injectBudgetKiB: 128,
  // 把协议写进工作区（AGENTS.md 托管段 + `.dsh-milieu/` 三份文件）。**默认开**。
  // 这是"让后续 AI 看得到协议"那一条的实现；写失败只报告，不兜底。
  writeProtocol: true,
  // 检查三个库在不在，**不在就补全目录**（需求 R3）。默认开。**只建目录，不铺内容**。
  ensureLibs: true,
  // **预加载会话**（需求 R4 / M5）：工作区没有我们的预加载会话就建一条，并让它真读一次。
  // **默认关**：它要建 agent、会真跑一次任务（花钱、动会话列表）。
  preloadSession: false,
  // **自动生成状态文件**（需求 R5 的地基）：会话开场扫一次工作区、产出事件流。
  // 默认开——它只做"只读扫描 + 写我们自己的状态文件"。
  autoState: true,
  // 工作区根。空 = 问平台要工作区表（只有一个就用；多个用平台顺序第一个；一个都没有就不写）。
  workspaceRoot: '',
  // **判据与显示阈值**：默认值在 `config/criteria.js`；这里给的是可被补丁层覆盖的那一份。
  // 宿主把**生效值**写进 `milieu-state.json` 的 `criteria`，客户端读同一份（两半不许各写一份）。
  criteria: DEFAULT_CRITERIA,
};

/**
 * 配置归一：把补丁层给的那一份叠到默认值上。
 *
 * 注意：
 *   · `libs` **浅合并**（只补缺的库名）；
 *   · `criteria` **深合并**（`readiness` / `fingerprint` 是嵌套对象，不能被浅覆盖掉）；
 *   · `0` / `false` / `''` 都是合法值——不能被 `||` 吃掉（journal/044 踩过）。
 *
 * `texts` 不在这里合并：`core/boot.js` 拿 `DEFAULT_TEXTS` 兜底（本层不依赖 core/）。
 *
 * @param {object} [config] 补丁层给的那一份（可能缺字段）
 * @returns {object} 归一后的配置
 */
export function withDefaults(config) {
  const patch = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  return {
    ...DEFAULT_CONFIG,
    ...patch,
    libs: { ...DEFAULT_CONFIG.libs, ...(patch.libs || {}) },
    criteria: mergeCriteria(DEFAULT_CRITERIA, patch.criteria),
  };
}
