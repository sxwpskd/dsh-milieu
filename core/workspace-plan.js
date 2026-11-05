// dsh-milieu —— **工作区配置规划**（核心层纯策略：读 `config.workspaces` → child 配置列表）
//
// A 方案（WORKSPACE-MANAGEMENT.md §3）：一个 Loader 行里为每个工作区挂一个 child fiber。
// 本文件只回答"该挂几个实例、每个实例的配置是什么"，**不挂 fiber、不读写文件、不访问宿主**。
//
// 规则（契约）：
//   · `workspaces` 缺省 / 空数组 → **单工作区兼容**：一个默认实例，root 仍按 `workspaceRoot` / 平台解析；
//   · `workspaces` 非空 → **每项一个实例**；顶层 `workspaceRoot` 不再作为额外实例；
//   · 每项 `path` 必须是非空**绝对路径**；同一路径（归一化后）只允许出现一次——**重复即拒绝**，
//     不静默去重（宁可一个都不挂，也不把两个实例指到同一个工作区互相踩）；
//   · child 配置 = 顶层默认 < 该项覆盖；`libs` / `criteria` 嵌套深合并；child 配置**不递归 workspaces**；
//   · 所有项都合法才返回 `ok:true`；任何一项非法 → `ok:false`、`children:[]`、`errors:[人话]`。
import { isAbsolute, resolve } from 'node:path';
import { withDefaults } from '../config/defaults.js';
import { mergeCriteria } from '../config/criteria.js';
import { plainConfig } from '../config/values.js';
import { workspaceKey } from '../utils/path.js';

/** 普通对象（配置补丁的形状）。 */
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** 去掉 `workspaces` 键（child 配置不递归）。 */
function withoutWorkspaces(config) {
  const out = { ...config };
  delete out.workspaces;
  return out;
}

/**
 * 归一成 child 的生效配置：补默认值，并**去掉 `workspaces`**（child 配置不递归；
 * `withDefaults` 会从默认值里带出空数组，这里删掉以明确"child 不再有列表语义"）。
 */
function finalizeChildConfig(patch) {
  const config = withDefaults(patch);
  delete config.workspaces;
  return config;
}

/**
 * 一个 child 的生效配置。
 * @param {object} top 顶层配置（已去掉 workspaces）
 * @param {object} overrides 该项覆盖（已去掉 path）
 * @param {string} resolvedPath 该项的绝对路径
 */
function childConfigOf(top, overrides, resolvedPath) {
  const patch = {
    ...top,
    ...overrides,
    // 该项 path 是 root 的唯一来源；顶层 `workspaceRoot` 只用于单工作区兼容。
    workspaceRoot: resolvedPath,
  };
  delete patch.workspaces;
  delete patch.path;

  // `libs` / `criteria` 深合并（其余键浅覆盖：显式写了就替换）。
  const topLibs = isPlainObject(top.libs) ? top.libs : {};
  const wsLibs = isPlainObject(overrides.libs) ? overrides.libs : {};
  if (Object.keys(topLibs).length || Object.keys(wsLibs).length) {
    patch.libs = { ...topLibs, ...wsLibs };
  }
  const topCriteria = isPlainObject(top.criteria) ? top.criteria : {};
  const wsCriteria = isPlainObject(overrides.criteria) ? overrides.criteria : {};
  if (Object.keys(topCriteria).length || Object.keys(wsCriteria).length) {
    patch.criteria = mergeCriteria(topCriteria, wsCriteria);
  }
  return finalizeChildConfig(patch);
}

/**
 * 把补丁层配置规划成 child 实例列表。
 *
 * @param {object} [rawConfig] 补丁层给的配置（可能缺字段 / 不是对象）
 * @returns {{ok:boolean, mode:'single'|'workspaces'|'invalid', children:Array<{path:string|null, index:number|null, config:object}>, errors:string[]}}
 *   · `mode:'single'`     —— `workspaces` 空/缺省，挂一个默认实例（`path:null`）
 *   · `mode:'workspaces'` —— 每个合法项一个实例（`path` 归一的绝对路径）
 *   · `mode:'invalid'`    —— 配置非法，`children` 为空、`errors` 说明原因（启动器据此拒绝启动并报告）
 */
export function planWorkspaces(rawConfig) {
  // **Volatile 引用先展开**（task-12）：配置可能来自 Cordis Loader，即时字段是引用对象；
  // 规划器只处理普通数据，不能把引用对象当数组/对象用。
  const plainInput = plainConfig(rawConfig);
  const raw = isPlainObject(plainInput) ? plainInput : {};
  const top = withoutWorkspaces(raw);
  const list = raw.workspaces;

  // ① 单工作区兼容：没有列表 / 空列表 → 一个默认实例（root 仍按顶层 workspaceRoot / 平台解析）。
  if (list === undefined || list === null || (Array.isArray(list) && list.length === 0)) {
    return {
      ok: true,
      mode: 'single',
      children: [{ path: null, index: null, config: finalizeChildConfig(top) }],
      errors: [],
    };
  }

  if (!Array.isArray(list)) {
    return {
      ok: false,
      mode: 'invalid',
      children: [],
      errors: ['workspaces 必须是对象数组（当前是 ' + (list === null ? 'null' : typeof list) + '）'],
    };
  }

  // ② 多工作区：逐项校验；任一项非法 → 全部拒绝（不半挂载）。
  const errors = [];
  const seen = new Map();
  const children = [];
  list.forEach((entry, index) => {
    const where = 'workspaces[' + index + ']';
    if (!isPlainObject(entry)) {
      errors.push(where + ' 必须是对象，且含 path');
      return;
    }
    const rawPath = entry.path;
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      errors.push(where + '.path 必须是非空字符串');
      return;
    }
    if (!isAbsolute(rawPath)) {
      errors.push(where + '.path 必须是绝对路径：' + rawPath);
      return;
    }
    let resolvedPath;
    try {
      resolvedPath = resolve(rawPath);
    } catch {
      errors.push(where + '.path 解析失败：' + rawPath);
      return;
    }
    const key = workspaceKey(resolvedPath);
    if (seen.has(key)) {
      errors.push(where + ' 与 workspaces[' + seen.get(key) + '] 路径重复：' + resolvedPath);
      return;
    }
    seen.set(key, index);
    const overrides = withoutWorkspaces(entry);
    delete overrides.path;
    children.push({ path: resolvedPath, index, config: childConfigOf(top, overrides, resolvedPath) });
  });

  if (errors.length) {
    return { ok: false, mode: 'invalid', children: [], errors };
  }
  return { ok: true, mode: 'workspaces', children, errors: [] };
}
