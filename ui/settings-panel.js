// dsh-milieu —— 配置浮球里的只读面板（纯 React，不判断、不读写）
//
// 为什么是只读（2026-11-02）：
//   · 界面半边只有 `remote.workspaceFiles` **只读**能力，没有写配置的通道；
//   · 真正写回要走 DSH 官方 settings / Config schema（W3），不是读一个 YAML 就能完成；
//   · 所以 W2 先把"宿主写进状态文件的生效判据"如实展示出来，**不假装能保存**。
//
// 纪律同 `ui/card.js`：只 import React（调用方传入）；样式只用 `--dsw-alias-*` / 间距 token；
//   工厂无副作用；不写 DOM、不动 document.body；数据从 props 来。

import { FIELD_LABELS, FIELD_UNITS, formatCurrentValue } from './config-page.js';

/** 浮球面板里的时间显示（宿主写的是 epoch ms）。 */
function formatTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value || '（未记录）');
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(n);
  }
}

/** 嵌套对象拍平成中文行；数组/对象值用 JSON 显示。 */
export function flattenCriteria(criteria) {
  const rows = [];
  const walk = (value, prefix) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) walk(value[key], prefix ? prefix + '.' + key : key);
      return;
    }
    if (typeof value === 'undefined') return;
    const full = 'criteria.' + prefix;
    const label = FIELD_LABELS[full] || FIELD_LABELS[prefix] || prefix;
    const unit = FIELD_UNITS[full] || '';
    const shown = Array.isArray(value)
      ? JSON.stringify(value)
      : formatCurrentValue({ path: prefix.split('.'), unit }, value);
    rows.push([label, shown]);
  };
  walk(criteria || {}, '');
  return rows;
}

/**
 * 只读面板。
 *
 * **React 组件签名是 `(props)`**（同 `settings-ball.js` 的更正在 2026-11-07 一并修掉）：
 * 它由 `React.createElement(MilieuSettingsPanel, { React, … })` 渲染，React 只传 props。
 *
 * @param props.React 浏览器模块表给的 React
 * @param props.data  `{ ok, criteria, generatedAt, workspaceKey, reason }`
 * @param props.loading 是否正在读
 * @param props.onRefresh 重新读
 * @param props.onClose 关闭
 */
export function MilieuSettingsPanel(props) {
  const React = props && props.React;
  if (!React || typeof React.createElement !== 'function') return null;
  const e = React.createElement;
  const { data, loading, onRefresh, onClose } = props || {};
  const ok = !!(data && data.ok);
  const rows = ok ? flattenCriteria(data.criteria) : [];

  return e('div', {
    role: 'dialog',
    'aria-label': 'milieu 配置（只读）',
    style: {
      position: 'fixed',
      right: '24px',
      bottom: '84px',
      width: '360px',
      maxWidth: 'calc(100vw - 48px)',
      maxHeight: '62vh',
      overflow: 'auto',
      zIndex: 2147483000,
      pointerEvents: 'auto',
      border: '1px solid var(--dsw-alias-border-secondary, #d9d9d9)',
      background: 'var(--dsw-alias-bg-elevated, #fff)',
      color: 'var(--dsw-alias-label-primary, #111)',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      padding: '12px 14px',
      font: 'inherit',
      fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    },
  },
  e('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
    e('div', { style: { fontWeight: 600, flex: '1 1 auto' } }, 'milieu 配置（只读）'),
    e('button', {
      type: 'button',
      onClick: () => onRefresh && onRefresh(),
      title: '重新读取状态文件',
      style: buttonStyle(),
    }, loading ? '读取中…' : '刷新'),
    e('button', { type: 'button', onClick: () => onClose && onClose(), title: '关闭', style: buttonStyle() }, '关闭'),
  ),

  e('div', { style: { color: 'var(--dsw-alias-label-tertiary, #666)', marginBottom: '8px' } },
    '数据来自宿主写入的 milieu-state.json；当前只读，写回（W3）要接官方 settings。'),

  !ok
    ? e('div', { style: { color: 'var(--dsw-alias-label-warning, #a15c00)', padding: '6px 0' } },
        '读不到生效判据：' + String((data && data.reason) || (loading ? '读取中…' : '未知原因')))
    : e('div', null,
        e('div', { style: { color: 'var(--dsw-alias-label-tertiary, #666)', marginBottom: '4px' } },
          '工作区 ' + String(data.workspaceKey || '（未记录）') + ' · 生成于 ' + formatTime(data.generatedAt)),
        e('table', { style: { width: '100%', borderCollapse: 'collapse' } },
          e('tbody', null,
            rows.length
              ? rows.map(([key, value]) => e('tr', { key },
                  e('td', { style: cellStyle(true) }, key),
                  e('td', { style: cellStyle(false) }, value)))
              : e('tr', null, e('td', { colSpan: 2, style: cellStyle(false) }, '状态文件里没有 criteria'))),
        ),
      ),
  );
}

function buttonStyle() {
  return {
    cursor: 'pointer',
    padding: '3px 8px',
    borderRadius: 'var(--dsw-radius-sm, 6px)',
    border: '1px solid var(--dsw-alias-border-secondary, #d9d9d9)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    flex: '0 0 auto',
  };
}

function cellStyle(isKey) {
  return {
    padding: '2px 4px',
    verticalAlign: 'top',
    textAlign: 'left',
    borderBottom: '1px solid var(--dsw-alias-border-secondary, #eee)',
    color: isKey ? 'var(--dsw-alias-label-secondary, #555)' : 'inherit',
    overflowWrap: 'anywhere',
    fontSize: '12px',
  };
}
