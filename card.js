// dsh-milieu —— 客户端卡片（纯 React，无副作用）
//
// 它是什么：切进会话时那条"要不要重读"的提示卡。
//   样子参照提权卡：一句话说清 + 两个按钮。
//
// 纪律（官方 UI 规矩 + 我们自己的）：
//   · **只 import react**（来自浏览器模块表）；**绝不 import 任何 Harness 客户端包**；
//   · 样式**只用 `--dsw-alias-*` 主题 token**，不写死颜色（写死的颜色在深色主题下会瞎）；
//   · **工厂无副作用**；资源注册在 apply 里，返回清理；
//   · 文案走字典（先内置中英，后续接 Client locale 服务）。
//
// 它**不做判断**：该不该弹由 core.js 的纯判据决定，能不能读由宿主/接口决定。
// 组件只负责"显示 + 把用户的选择报上去"。

const h = (React) => React.createElement;

export const CARD_TEXT = {
  zh: {
    title: '这个工作区变了',
    body: '你上次用这条会话之后，工作区有改动。要不要我先重读一遍，再接着干？',
    review: '重读',
    skip: '不用，直接继续',
    more: '等 {n} 项',
    reviewHint: '（读完我会把新认识写回认知库）',
  },
  en: {
    title: 'This workspace changed',
    body: 'The workspace changed since you last used this session. Should I re-read it before we continue?',
    review: 'Re-read',
    skip: 'No, continue',
    more: 'and {n} more',
    reviewHint: '(I will write what I learn back into the review library)',
  },
};

/** 把变更索引压成几行人话（最多列 3 条，其余给数量）。 */
export function summarizeChangeIndex(changeIndex, locale = 'zh') {
  const t = CARD_TEXT[locale] || CARD_TEXT.zh;
  const pick = (list, label) => (Array.isArray(list) && list.length ? { label, items: list } : null);
  const groups = [
    pick(changeIndex && changeIndex.reviewAdded, '认知库新增'),
    pick(changeIndex && changeIndex.reviewChanged, '认知库改动'),
    pick(changeIndex && changeIndex.reviewGone, '认知库消失'),
    pick(changeIndex && changeIndex.otherChanged, '其余库改动'),
    pick(changeIndex && changeIndex.otherAdded, '其余库新增'),
    pick(changeIndex && changeIndex.otherGone, '其余库消失'),
  ].filter(Boolean);
  const lines = [];
  for (const g of groups) {
    const shown = g.items.slice(0, 3);
    const rest = g.items.length - shown.length;
    lines.push(g.label + '：' + shown.join('、') + (rest > 0 ? '　' + t.more.replace('{n}', String(rest)) : ''));
  }
  return lines;
}

/**
 * 卡片组件。
 * @param props.changeIndex 变更索引（形状见 summary.js 的产物）
 * @param props.locale 'zh' | 'en'
 * @param props.onReview 点"重读"
 * @param props.onSkip 点"不用"
 * @param props.onDismiss 用户直接发请求 → 自动关闭
 */
export function MilieuReturnCard(React, props) {
  const e = h(React);
  const { changeIndex, locale = 'zh', onReview, onSkip, onDismiss } = props || {};
  const t = CARD_TEXT[locale] || CARD_TEXT.zh;
  const lines = summarizeChangeIndex(changeIndex, locale);

  // 用户直接开始打字 → 卡片自己关掉（"用户直接发请求，就关闭本提示"）
  const onKeyDown = (ev) => {
    if (ev && (ev.key === 'Enter' || ev.key === 'Escape')) onDismiss && onDismiss();
  };

  return e('div', {
    role: 'group',
    'aria-label': t.title,
    onKeyDown,
    style: {
      // 只用主题 token：写死颜色在深色主题下会瞎
      border: '1px solid var(--dsw-alias-border-secondary, #d9d9d9)',
      background: 'var(--dsw-alias-bg-elevated, #fff)',
      color: 'var(--dsw-alias-label-primary, #111)',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      padding: '10px 12px',
      margin: '8px 0',
      font: 'inherit',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    },
  },
    e('div', { style: { fontWeight: 600 } }, t.title),
    e('div', { style: { color: 'var(--dsw-alias-label-secondary, #555)' } }, t.body),
    lines.length
      ? e('ul', { style: { margin: '2px 0 0 18px', color: 'var(--dsw-alias-label-tertiary, #666)', fontSize: 'var(--dsh-content-font-size-secondary, 13px)' } },
          lines.map((l, i) => e('li', { key: i }, l)))
      : null,
    e('div', { style: { display: 'flex', gap: '8px', marginTop: '2px' } },
      e('button', {
        type: 'button',
        onClick: () => onReview && onReview(),
        style: { cursor: 'pointer', padding: '4px 10px', borderRadius: 'var(--dsw-radius-sm, 6px)',
                 border: '1px solid var(--dsw-alias-border-secondary, #d9d9d9)',
                 background: 'var(--dsw-alias-bg-accent, #eef4ff)', color: 'inherit', font: 'inherit' },
      }, t.review),
      e('button', {
        type: 'button',
        onClick: () => onSkip && onSkip(),
        style: { cursor: 'pointer', padding: '4px 10px', borderRadius: 'var(--dsw-radius-sm, 6px)',
                 border: '1px solid var(--dsw-alias-border-secondary, #d9d9d9)',
                 background: 'transparent', color: 'inherit', font: 'inherit' },
      }, t.skip)),
    e('div', { style: { color: 'var(--dsw-alias-label-tertiary, #666)', fontSize: '12px' } }, t.reviewHint));
}
