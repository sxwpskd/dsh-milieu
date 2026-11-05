// dsh-milieu —— 配置浮球（界面层：一个浮在 DSH 页面右下角的只读入口）
//
// 它是什么（2026-11-02）：主人要的"配置控制面板"的 A 版第一步——
//   · 在 DSH 窗口里浮一个球，点开一个小面板；
//   · **只读**展示状态文件里的生效 `criteria`（宿主写、客户端读）；
//   · 不写配置：写回要接 DSH 官方 settings / Config schema，另开 W3。
//
// 不是桌面级悬浮窗：DSH 插件没有创建系统级置顶窗口的 API；这是 `shell.overlay` 里的页面浮层，
//   只浮在 DSH 页面内，不会浮在别的应用程序上面（2026-11-02 已和主人确认）。
//
// 纪律：只 import React（调用方传入）；样式只用 `--dsw-alias-*` token；工厂无副作用；
//   不写 DOM、不动 document.body；数据从 props 来；不直接访问 ctx/remote。
import { MilieuSettingsPanel } from './settings-panel.js';

const FALLBACK_READ = '这个浮球没有拿到读状态文件的函数（接线问题），暂时只能显示错误。';

/**
 * 浮球 + 面板。
 * @param props.readState 异步函数 → `{ ok, criteria, generatedAt, workspaceKey, reason }`
 */
export function MilieuSettingsBall(React, props) {
  const e = React.createElement;
  const readState = props && props.readState;
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [data, setData] = React.useState(null);

  async function refresh() {
    if (typeof readState !== 'function') {
      setData({ ok: false, reason: FALLBACK_READ });
      return;
    }
    setLoading(true);
    try {
      const next = await readState();
      setData(next || { ok: false, reason: '读状态文件没有返回结果' });
    } catch (err) {
      setData({ ok: false, reason: String((err && err.message) || err || '未知错误') });
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void refresh();
  }

  return e('div', {
    style: {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      zIndex: 2147483000,
      pointerEvents: 'none',
    },
  },
  e('button', {
    type: 'button',
    onClick: toggle,
    title: 'milieu 配置（只读）',
    'aria-label': 'milieu 配置（只读）',
    'aria-expanded': open,
    style: {
      pointerEvents: 'auto',
      width: '48px',
      height: '48px',
      borderRadius: '50%',
      border: '1px solid var(--dsw-alias-border-secondary, #d9d9d9)',
      background: 'var(--dsw-alias-bg-elevated, #fff)',
      color: 'var(--dsw-alias-label-primary, #111)',
      boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '20px',
      lineHeight: '46px',
      padding: 0,
    },
  }, '⚙'),
  open
    ? e(MilieuSettingsPanel, {
        React,
        data,
        loading,
        onRefresh: () => { void refresh(); },
        onClose: () => setOpen(false),
      })
    : null,
  );
}
