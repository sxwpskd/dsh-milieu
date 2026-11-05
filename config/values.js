// dsh-milieu —— **配置值归一**（config 层纯工具：把 Cordis Volatile 引用展开成普通值）
//
// 为什么需要它（SETTINGS-UI-PLAN.md §3.1）：
//   · 声明 `Config` 之后，Loader 交给 `apply(ctx, config)` 的配置里，`.volatile()` 字段不再是普通值，
//     而是**稳定引用**（`Volatile<T>`，用 `.get()` 读快照）；
//   · 我们的规划器/`withDefaults`/child 配置都是按普通数据写的——把引用对象当普通值传进去，
//     JSON 会变成 `{}`、深合并会失真、child 会拿到一个"函数对象"；
//   · 所以启动器与 config 层在**进入规划前**统一展开成普通值；`Config` schema 本身仍保留给设置表单。
//
// 检测方式：Volatile 引用是带 `.get()` 的对象（Schemastery 文档："通过 .get() 读取"）。
//   配置数据（经 schema 校验）不可能是函数/类实例，所以"有 get 方法的对象"就是引用——
//   不需要 import `@deepseek-ai/cosmokit` 的 `isVolatile`（少一个未声明的传递依赖）。

/** 递归展开的最大深度：配置里不会这么深，防坏输入把栈打穿。 */
const MAX_DEPTH = 32;

/**
 * 这个值是不是 Volatile 引用？（对象且带可调用的 `get`）
 * @param {unknown} value
 * @returns {boolean}
 */
export function isVolatileRef(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function';
}

/**
 * 只展开"单个值"：连续 `.get()` 直到拿到普通值（引用套引用也认）。
 * 读失败（引用自己的 get 抛错）→ `undefined`：配置读不出来时按缺省处理，不把异常带进启动。
 * @param {unknown} value
 * @returns {unknown}
 */
export function readValue(value) {
  let current = value;
  let depth = 0;
  while (isVolatileRef(current) && depth < MAX_DEPTH) {
    try {
      current = current.get();
    } catch {
      return undefined;
    }
    depth += 1;
  }
  return current;
}

/**
 * 把整个配置对象展开成**普通数据快照**：Volatile 引用 → `.get()` 的值；数组/普通对象递归复制。
 * 返回的是新对象（不改输入）；函数等非对象值原样保留。
 * @param {unknown} input
 * @returns {unknown}
 */
export function plainConfig(input) {
  return unwrap(input, new Set(), 0);
}

/** 递归实现（`seen` 防环；配置里不该有环，但坏输入不能把规划器卡死）。 */
function unwrap(value, seen, depth) {
  if (depth > MAX_DEPTH) return value;
  if (!value || typeof value !== 'object') return value;
  if (isVolatileRef(value)) {
    try {
      return unwrap(value.get(), seen, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (seen.has(value)) return undefined; // 环：不把环复制进规划/child 配置
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => unwrap(item, seen, depth + 1));
  } else {
    out = {};
    for (const key of Object.keys(value)) out[key] = unwrap(value[key], seen, depth + 1);
  }
  seen.delete(value);
  return out;
}
