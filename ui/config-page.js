// dsh-milieu —— 行配置页（界面层：插件管理页里 `dsh-milieu` 行的「配置」页面）
//
// 依据（2026-11-05 从安装版 app.asar 核对，官方 `ui-plugin-manager` / 客户端 ui-settings 实现）：
//   · 注册进 `plugins.row.config`，key = `<包名>#<Loader 行 id>`（我们的包 `dsh-milieu` + 行 `milieu`）；
//   · 页面宿主（插件管理页）在行详情里渲染
//       renderSlot('plugins.row.config', { view: 'page', form }, { entryKey: key })
//     组件收到 props `{ t, view, form }`；package 有 description 时不会走 `view:'summary'`，
//     这里对 `view !== 'page'` 直接返回 null（防御）。
//   · `form.state` = `ConfigFormController.getSnapshot()`：
//       `{ status:'loading'|'ready'|'unavailable', value: 配置对象|undefined,
//          base, user, revision: number|undefined, writable: boolean }`
//     宿主没给该行配置表单时 `form` 是 **undefined**——必须显示降级，不崩。
//   · `form.mutate(ops, expectedRevision)`：ops = `{ op:'set', path:[...], value }` 的数组
//     （数组/嵌套用路径段），返回 `Promise<boolean>`（true=Host 接受、false=被拒并自动重读）。
//     只有保存才写入；页面自己负责草稿与校验提示。
//
// 本步（配置页 2/3）：**只读展示 workspaces[]**（结构性配置，不产生写操作）；
//   即时字段 `preloadSession` / `autoState` / `criteria` 可编辑（只生成 set 操作）；
//   不改宿主 Config 语义、不写 profile 文件、不直接碰 `milieu-state.json`。
//
// 纪律：纯 React（`React` 由调用方传入）、不写 DOM、不 import Harness 客户端包、
//   样式只用 `--dsw-alias-*` 主题 token；本文件不做网络请求、不接触 ctx。

/** 行配置页的插槽名。 */
export const CONFIG_PAGE_SLOT = 'plugins.row.config';

/** 行配置页的 key：`<包名>#<Loader 行 id>`（当前 `cordis.patch.yml` 的行 id 是 `milieu`）。 */
export const CONFIG_PAGE_KEY = 'dsh-milieu#milieu';

/** 是否已保存 / 无变化 / 只读等状态文案（测试按这些字符串断言）。 */
export const CONFIG_PAGE_TEXT = {
  title: 'milieu 配置',
  readonly: '当前只读：宿主报告这份配置不可写',
  loading: '正在读取配置…',
  noForm: '页面宿主没有提供配置表单（form）。可能这一行没有可编辑的 Config 字段，或配置服务还没就绪。',
  unavailable: '配置不可用：这一行在宿主里没有对应的配置命名空间。',
  noWorkspaces: '没有配置工作区列表（使用默认/兼容单工作区）。',
  workspacesNote: '工作区是结构性配置（增删会增减实例），本页只读；改它请编辑 profile patch 后重载。',
  noChanges: '没有需要保存的改动',
  saved: '已保存',
  saving: '保存中…',
  save: '保存',
};

/**
 * 可编辑字段（**只有 volatile 字段**：preloadSession / autoState / criteria 的标量）。
 * 每一项：`key`（草稿键）、`path`（mutate 的 path）、`label`、`kind`（boolean|number）、
 * `integer` / `min` / `max` 是本地校验（Host 仍会校验完整 Config）。
 * `workspaces` **不在这里**：它只读、永不生成写操作。
 */
export const FIELD_GROUPS = [
  {
    title: '预加载',
    fields: [
      { path: ['preloadSession'], label: 'preloadSession（预加载会话）', kind: 'boolean' },
      { path: ['criteria', 'preloadIdleMs'], label: 'preloadIdleMs（空闲多久算用完了）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'preloadPollMs'], label: 'preloadPollMs（对账轮询间隔）', kind: 'number', integer: true, min: 0 },
    ],
  },
  {
    title: '工作区监控',
    fields: [
      { path: ['autoState'], label: 'autoState（自动生成状态文件）', kind: 'boolean' },
      { path: ['criteria', 'workspacePollMs'], label: 'workspacePollMs（工作区扫描间隔）', kind: 'number', integer: true, min: 0 },
    ],
  },
  {
    title: '重读判据',
    fields: [
      { path: ['criteria', 'structuralThreshold'], label: 'structuralThreshold（新增/消失阈值）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'contentThreshold'], label: 'contentThreshold（改动阈值）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'promptThresholdMs'], label: 'promptThresholdMs（距会话活动多久弹卡）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'staleHintDays'], label: 'staleHintDays（多久算陈旧）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'staleDays'], label: 'staleDays（超过只给文件名）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'staleMaxReview'], label: 'staleMaxReview（陈旧视图最多列几条）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'readiness', 'minFiles'], label: 'readiness.minFiles（认知库最少文件数）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'readiness', 'minBytes'], label: 'readiness.minBytes（认知库最少字节数）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'readiness', 'windowMs'], label: 'readiness.windowMs（观察窗）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'readiness', 'maxGrowthRate'], label: 'readiness.maxGrowthRate（窗内新增速度上限）', kind: 'number', min: 0, max: 1 },
      { path: ['criteria', 'readiness', 'maxChangedRatio'], label: 'readiness.maxChangedRatio（窗内变动占比上限）', kind: 'number', min: 0, max: 1 },
      { path: ['criteria', 'fingerprint', 'keepDays'], label: 'fingerprint.keepDays（指纹保留天数）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'fingerprint', 'keepRecent'], label: 'fingerprint.keepRecent（指纹保留最近几条）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'eventKeepDays'], label: 'eventKeepDays（事件流保留天数）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'eventKeepCount'], label: 'eventKeepCount（事件流保留条数）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'clientMemoryLimit'], label: 'clientMemoryLimit（客户端记忆上限）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'pollMs'], label: 'pollMs（客户端轮询间隔）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'readTimeoutMs'], label: 'readTimeoutMs（读状态文件超时）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'agentLoopWaitMs'], label: 'agentLoopWaitMs（等 agentLoop 的兜底）', kind: 'number', integer: true, min: 0 },
      { path: ['criteria', 'debug'], label: 'debug（卡片调试行）', kind: 'boolean' },
    ],
  },
];

/** 所有可编辑字段（拍平）。 */
export const EDITABLE_FIELDS = FIELD_GROUPS.flatMap((group) => group.fields.map((field) => ({
  ...field,
  key: field.path.join('.'),
})));

/** 路径 → 草稿键。 */
export function pathKey(path) {
  return (Array.isArray(path) ? path : []).join('.');
}

/** 按路径取值（读不到返回 undefined）。 */
export function getPathValue(root, path) {
  let current = root;
  for (const key of Array.isArray(path) ? path : []) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/** 从 `form.state.value`（完整配置对象）取可编辑字段的基线值：`{ 草稿键: 值 }`。 */
export function baselineOf(configValue) {
  const out = {};
  for (const field of EDITABLE_FIELDS) out[field.key] = getPathValue(configValue, field.path);
  return out;
}

/** 从基线生成草稿（数字转字符串，布尔原样；页面输入框统一用字符串/布尔）。 */
export function draftOf(baseline) {
  const draft = {};
  for (const field of EDITABLE_FIELDS) {
    const base = baseline ? baseline[field.key] : undefined;
    draft[field.key] = field.kind === 'boolean' ? base === true : (typeof base === 'number' ? String(base) : '');
  }
  return draft;
}

/** 解析一个字段的输入；不合法返回 `{ok:false, reason}`（页面据此显示校验提示、不提交）。 */
export function parseField(field, raw) {
  if (!field || typeof field !== 'object') return { ok: false, reason: '未知字段' };
  if (field.kind === 'boolean') {
    if (raw === true || raw === 'true' || raw === 1) return { ok: true, value: true };
    if (raw === false || raw === 'false' || raw === 0 || raw === '') return { ok: true, value: false };
    return { ok: false, reason: field.label + ' 必须是布尔值' };
  }
  const text = typeof raw === 'number' ? raw : String(raw === undefined || raw === null ? '' : raw).trim();
  if (text === '') return { ok: false, reason: field.label + ' 不能为空' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, reason: field.label + ' 必须是数字' };
  if (field.integer === true && !Number.isInteger(value)) return { ok: false, reason: field.label + ' 必须是整数' };
  if (typeof field.min === 'number' && value < field.min) return { ok: false, reason: field.label + ' 不能小于 ' + field.min };
  if (typeof field.max === 'number' && value > field.max) return { ok: false, reason: field.label + ' 不能大于 ' + field.max };
  return { ok: true, value };
}

/** 值比较（字段值都是标量；String 化比较足够）。 */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Number.isFinite(b) && a === b;
  return String(a) === String(b);
}

/**
 * 草稿 → 变更操作（**只含 volatile 标量，path-addressed**）。
 *   · `workspaces` 不产生任何操作（本页只读）；
 *   · 无变化的字段不出现；
 *   · 无效输入收集到 `invalid`（此时不提交，页面显示原因）。
 * @returns {{ops: object[], invalid: {key:string, reason:string}[], changed: number}}
 */
export function diffDraft(draft, baseline) {
  const ops = [];
  const invalid = [];
  for (const field of EDITABLE_FIELDS) {
    const raw = draft ? draft[field.key] : undefined;
    if (raw === undefined) continue;                       // 没动过这个字段
    const parsed = parseField(field, raw);
    if (!parsed.ok) { invalid.push({ key: field.key, reason: parsed.reason }); continue; }
    if (!sameValue(parsed.value, baseline ? baseline[field.key] : undefined)) {
      ops.push({ op: 'set', path: [...field.path], value: parsed.value });
    }
  }
  return { ops, invalid, changed: ops.length };
}

/** 取页面宿主给的 form 的只读事实（不抛）。 */
export function formFacts(form) {
  if (!form || typeof form !== 'object') {
    return { ok: false, reason: 'no-form', state: null, value: undefined };
  }
  const state = form.state && typeof form.state === 'object' ? form.state : null;
  if (!state) return { ok: false, reason: 'no-state', state: null, value: undefined };
  const ready = state.status === 'ready' && state.value !== null && state.value !== undefined && typeof state.value === 'object';
  return { ok: ready, state, value: ready ? state.value : undefined };
}

/**
 * 保存草稿（**唯一写入口**；不抛，失败保留草稿——本函数不改 draft）。
 * @param {object} form 页面宿主传入的 `form`（state + mutate）
 * @param {object} draft 草稿
 * @param {object} baseline 基线（`baselineOf(form.state.value)`）
 * @returns {Promise<{ok:boolean, skipped:boolean, ops:object[], reason:string}>}
 *   `skipped:true` = 无变化，没有调用 mutate。
 */
export async function saveDraft(form, draft, baseline) {
  const facts = formFacts(form);
  if (!facts.ok) {
    return {
      ok: false, skipped: false, ops: [],
      reason: facts.reason === 'no-form'
        ? '页面宿主没有提供配置表单（form）'
        : '配置还没读好（status=' + (facts.state && facts.state.status) + '）',
    };
  }
  if (facts.state.writable === false) {
    return { ok: false, skipped: false, ops: [], reason: '宿主报告这份配置不可写' };
  }
  const diff = diffDraft(draft, baseline);
  if (diff.invalid.length > 0) {
    return { ok: false, skipped: false, ops: [], reason: '有无效值：' + diff.invalid[0].reason };
  }
  if (diff.ops.length === 0) {
    return { ok: true, skipped: true, ops: [], reason: CONFIG_PAGE_TEXT.noChanges };
  }
  if (typeof form.mutate !== 'function') {
    return { ok: false, skipped: false, ops: diff.ops, reason: '页面宿主没有提供保存通道（form.mutate）' };
  }
  try {
    const accepted = await form.mutate(diff.ops, facts.state.revision);
    if (accepted === false) {
      return { ok: false, skipped: false, ops: diff.ops, reason: '宿主拒绝了这次修改（值无效或已被并发修改）' };
    }
    return { ok: true, skipped: false, ops: diff.ops, reason: CONFIG_PAGE_TEXT.saved };
  } catch (err) {
    return {
      ok: false, skipped: false, ops: diff.ops,
      reason: '保存时抛出异常：' + String((err && err.message) || err),
    };
  }
}

/** 只读工作区列表：`path` + 其余覆盖项摘要（本步不提供增删/编辑控件）。 */
export function workspaceRows(configValue) {
  const list = configValue && Array.isArray(configValue.workspaces) ? configValue.workspaces : [];
  return list.map((item) => {
    const entry = item && typeof item === 'object' ? item : {};
    const overrides = Object.keys(entry)
      .filter((key) => key !== 'path')
      .map((key) => key + '=' + JSON.stringify(entry[key]));
    return { path: typeof entry.path === 'string' ? entry.path : String(entry.path || '（没有 path）'), overrides };
  });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const COLOR_MUTED = 'var(--dsw-alias-label-secondary, #555)';
const COLOR_TERTIARY = 'var(--dsw-alias-label-tertiary, #666)';
const BORDER = '1px solid var(--dsw-alias-border-secondary, #d9d9d9)';

/** 页面根容器样式（只用主题 token）。 */
const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: '10px', font: 'inherit' },
  card: { border: BORDER, borderRadius: 'var(--dsw-radius-md, 8px)', padding: '10px 12px', background: 'var(--dsw-alias-bg-elevated, #fff)' },
  h2: { margin: '0', fontSize: '15px' },
  h3: { margin: '0 0 6px', fontSize: '13px' },
  muted: { color: COLOR_MUTED, fontSize: '12px', margin: '2px 0' },
  tertiary: { color: COLOR_TERTIARY, fontSize: '12px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0' },
  label: { flex: '1', fontSize: '13px' },
  input: { font: 'inherit', padding: '2px 6px', borderRadius: 'var(--dsw-radius-sm, 6px)', border: BORDER, background: 'transparent', color: 'inherit' },
  button: { cursor: 'pointer', padding: '4px 12px', borderRadius: 'var(--dsw-radius-sm, 6px)', border: BORDER, background: 'var(--dsw-alias-bg-accent, #eef4ff)', color: 'inherit', font: 'inherit' },
  noticeOk: { color: 'var(--dsw-alias-label-primary, #111)', fontSize: '12px' },
  noticeErr: { color: '#c00', fontSize: '12px' },
  disable: { opacity: '0.6' },
};

const e = (React, tag, props, ...children) => React.createElement(tag, props, ...children);

/** 渲染一个错误/不可用提示块（页面的 fail-open 落点）。 */
function noticeBlock(React, text, color) {
  return e(React, 'div', { style: { ...styles.card, color: color || COLOR_MUTED } }, text);
}

/** 取某字段当前显示值：优先级 = 外部注入草稿 > 本地草稿 > 基线。 */
function shownValueOf(field, baseline, effectiveDraft) {
  const key = pathKey(field.path);
  const raw = Object.prototype.hasOwnProperty.call(effectiveDraft, key) ? effectiveDraft[key] : undefined;
  if (raw !== undefined && raw !== null) return raw;
  const base = baseline ? baseline[key] : undefined;
  return field.kind === 'boolean' ? base === true : (typeof base === 'number' ? String(base) : '');
}

/** 组件主体：只负责把数据画出来；状态与保存都在 `MilieuConfigPage` 的 hooks 里。 */
function buildPage(React, props) {
  if (props && props.view && props.view !== 'page') return null;   // summary 视图不渲染页面
  const form = props && props.form;
  const facts = props && props.facts ? props.facts : formFacts(form);
  const state = facts.state;
  const writable = !!(state && state.writable === true);
  const baseline = props && props.baseline ? props.baseline : (facts.ok ? baselineOf(facts.value) : {});
  const rows = props && props.rows ? props.rows : (facts.ok ? workspaceRows(facts.value) : []);
  const effectiveDraft = (props && props.__draft) || {};
  const diff = (props && props.__diff) || { ops: [], invalid: [], changed: 0 };
  const saving = !!(props && props.__saving);
  const notice = props && props.__notice;

  const parts = [];
  parts.push(e(React, 'h2', { style: styles.h2 }, CONFIG_PAGE_TEXT.title));
  parts.push(e(React, 'p', { style: styles.muted },
    '只读读取宿主给的 form.state（revision=' + String(state ? state.revision : '—') + '）；保存走 form.mutate，只有保存才写入。'));

  // 没有 form：如实说明（不要假装成功，也不能崩）
  if (!form || !state) {
    parts.push(noticeBlock(React, CONFIG_PAGE_TEXT.noForm));
    return e(React, 'div', { style: styles.root }, ...parts);
  }
  if (state.status === 'unavailable') {
    parts.push(noticeBlock(React, CONFIG_PAGE_TEXT.unavailable));
    return e(React, 'div', { style: styles.root }, ...parts);
  }
  if (state.status !== 'ready' || !facts.ok) {
    parts.push(noticeBlock(React, CONFIG_PAGE_TEXT.loading));
    return e(React, 'div', { style: styles.root }, ...parts);
  }
  if (!writable) parts.push(noticeBlock(React, CONFIG_PAGE_TEXT.readonly));

  // ---- 工作区（只读） ----
  const wsChildren = [e(React, 'h3', { style: styles.h3 }, '工作区（只读）')];
  if (rows.length === 0) {
    wsChildren.push(e(React, 'p', { style: styles.muted }, CONFIG_PAGE_TEXT.noWorkspaces));
  } else {
    for (const row of rows) {
      wsChildren.push(e(React, 'div', { style: styles.row, key: 'ws:' + row.path },
        e(React, 'code', { style: styles.label }, row.path),
        e(React, 'span', { style: styles.tertiary }, row.overrides.length ? row.overrides.join('，') : '（无覆盖项）')));
    }
  }
  wsChildren.push(e(React, 'p', { style: styles.muted }, CONFIG_PAGE_TEXT.workspacesNote));
  parts.push(e(React, 'div', { style: styles.card, key: 'workspaces' }, ...wsChildren));

  // ---- 即时字段（按组；只渲染 volatile 标量） ----
  const onEdit = props && typeof props.onEdit === 'function' ? props.onEdit : null;
  for (const group of FIELD_GROUPS) {
    const children = [e(React, 'h3', { style: styles.h3 }, group.title)];
    for (const field of group.fields) {
      const key = pathKey(field.path);
      const shown = shownValueOf(field, baseline, effectiveDraft);
      const base = baseline[key];
      const invalid = diff.invalid.some((item) => item.key === key);
      const inputProps = field.kind === 'boolean'
        ? { type: 'checkbox', checked: shown === true, onChange: (ev) => onEdit && onEdit(field, !!(ev && ev.target ? ev.target.checked : false)), disabled: !writable }
        : { type: 'number', value: String(shown), onChange: (ev) => onEdit && onEdit(field, ev && ev.target ? ev.target.value : ''), disabled: !writable, style: styles.input };
      children.push(e(React, 'div', { style: styles.row, key: 'f:' + key },
        e(React, 'span', { style: { ...styles.label, color: invalid ? '#c00' : 'inherit' } }, field.label),
        e(React, 'input', inputProps),
        e(React, 'span', { style: styles.tertiary }, '当前：' + String(base === undefined ? '—' : base))));
    }
    parts.push(e(React, 'div', { style: styles.card, key: 'g:' + group.title }, ...children));
  }

  // ---- 保存 ----
  const invalid = diff.invalid;
  const saveDisabled = !writable || saving || diff.changed === 0 || invalid.length > 0;
  const saveLabel = saving ? CONFIG_PAGE_TEXT.saving : CONFIG_PAGE_TEXT.save;
  parts.push(e(React, 'div', { style: styles.row, key: 'actions' },
    e(React, 'button', {
      type: 'button',
      style: { ...styles.button, ...(saveDisabled ? styles.disable : {}) },
      disabled: saveDisabled,
      onClick: props && typeof props.onSave === 'function' ? props.onSave : undefined,
    }, saveLabel),
    e(React, 'span', { style: styles.tertiary },
      invalid.length > 0 ? ('校验失败：' + invalid[0].reason)
        : diff.changed > 0 ? ('待保存 ' + diff.changed + ' 项')
          : CONFIG_PAGE_TEXT.noChanges)));
  if (notice && notice.text) {
    parts.push(e(React, 'div', { key: 'notice', style: notice.ok ? styles.noticeOk : styles.noticeErr }, String(notice.text)));
  }
  return e(React, 'div', { style: styles.root }, ...parts);
}

/**
 * 行配置页组件：本地草稿 + 保存。
 *
 * **React 组件签名是 `(props)`**：`ConfigPageView` 用
 * `React.createElement(MilieuConfigPage, { React, ...props })` 渲染它；React 只传 props。
 * 历史上这里写成 `(React, props)` 工厂签名，真机会把 props 当 React → hooks 全挂
 * （2026-11-07 真机 Console 抓到；离线测试直接调用工厂所以没发现）。
 *
 * @param props.React 浏览器模块表给的 React（离线测试用假 React）
 * @param props.t / props.view / props.form 页面宿主传入
 *   测试口子：`__testDraft`（覆盖草稿值，模拟用户输入）、`__onState`（每次状态变化回调，测试观察）
 */
export function MilieuConfigPage(props) {
  const React = props && props.React;
  if (!React || typeof React.createElement !== 'function' || typeof React.useState !== 'function') return null;

  // hooks 无条件执行（不能在 early return 之后），保证组件多次渲染顺序一致。
  const form = props && props.form;
  const facts = formFacts(form);
  const baseline = facts.ok ? baselineOf(facts.value) : {};
  const revision = facts.state ? facts.state.revision : undefined;
  const [draft, setDraft] = React.useState(() => draftOf(baseline));
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  if (typeof React.useEffect === 'function') {
    // 宿主 revision 变了（保存成功/外部改配置）且没有未保存草稿 → 以新 form.state 为准重填。
    React.useEffect(() => { if (!dirty) setDraft(draftOf(baseline)); }, [facts.ok, revision]);
  }

  const injected = props && props.__testDraft && typeof props.__testDraft === 'object' ? props.__testDraft : null;
  const effectiveDraft = injected ? { ...draft, ...injected } : draft;
  const diff = facts.ok ? diffDraft(effectiveDraft, baseline) : { ops: [], invalid: [], changed: 0 };

  const editField = (field, raw) => {
    if (!facts.ok) return;
    setDraft((prev) => ({ ...(prev || {}), [pathKey(field.path)]: raw }));
    setDirty(true);
    setNotice(null);
  };

  const onSave = () => {
    if (saving) return;
    if (typeof props.__onState === 'function') props.__onState({ phase: 'saving' });
    setSaving(true);
    setNotice(null);
    Promise.resolve(saveDraft(form, effectiveDraft, baseline)).then((result) => {
      setSaving(false);
      if (result.ok && !result.skipped) {
        setDirty(false);
        setNotice({ ok: true, text: result.reason });
      } else if (result.skipped) {
        setNotice({ ok: true, text: result.reason });
      } else {
        // 失败：**保留草稿**，只显示原因（不重置 draft）
        setNotice({ ok: false, text: '保存失败：' + result.reason + '（草稿已保留）' });
      }
      if (typeof props.__onState === 'function') props.__onState({ phase: 'done', result, draft: effectiveDraft });
    }).catch((err) => {
      setSaving(false);
      setNotice({ ok: false, text: '保存失败：' + String((err && err.message) || err) + '（草稿已保留）' });
    });
  };

  try {
    return buildPage(React, {
      ...props,
      facts,
      baseline,
      __draft: effectiveDraft,
      __diff: diff,
      __saving: saving,
      __notice: notice,
      onSave,
      onEdit: editField,
    });
  } catch (err) {
    // fail-open：配置页自己的渲染错误不能把插件管理页搞白
    return noticeBlock(React, '配置页渲染失败（已跳过）：' + String((err && err.message) || err));
  }
}

