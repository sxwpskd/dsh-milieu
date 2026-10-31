// dsh-milieu —— 卡片渲染错误边界（界面层：卡片坏了只跳过，不把 slot 整块搞白）
//
// 为什么要有它（task-5）：卡片是**装饰**。装饰崩了正确行为是"这次不显示"，
//   而不是把异常抛进插槽、让整块聊天尾巴白掉（甚至影响宿主渲染）。
//   策略：**fail-open**——渲染 null，失败经 `onError` 报一次，不重新抛。
//
// 为什么是工厂而不是直接一个类：界面层只从浏览器模块表拿到 `React`（`require('react')`），
//   不能 `import react`；所以类必须在拿到 React 之后才造得出来。
//   离线假 React（测试里只有 `createElement`）没有 `Component` → 退化成**直通组件**，
//   让同一份边界代码在真浏览器与离线测试里都不炸（真 React 一定有 Component）。
import { normalizeError } from '../exception/normalize.js';
import { CODES } from '../exception/codes.js';

/**
 * 造一个错误边界组件。
 * @param {object} React 浏览器模块表给的 React（或测试里的假 React）
 * @param {{onError?: (failure: object) => void}} [options]
 *   `onError` 收到的是归一后的失败结果（`{ok:false, code, reason, blockedBy, cause}`），
 *   由调用方决定怎么报（本文件不直接写日志：界面层没有 logger，也不该知道日志长什么样）。
 * @returns {Function|class} 可以直接给 `React.createElement` 用的组件
 */
export function createErrorBoundary(React, options = {}) {
  const onError = options && typeof options.onError === 'function' ? options.onError : null;
  const Base = React && (typeof React.Component === 'function'
    ? React.Component
    : (typeof React.PureComponent === 'function' ? React.PureComponent : null));

  // 没有类组件（离线假 React）：退化成直通组件。真实浏览器里不会走到这条。
  if (!Base) {
    return function MilieuErrorBoundaryPassthrough(props) {
      return props && props.children !== undefined ? props.children : null;
    };
  }

  class MilieuErrorBoundary extends Base {
    constructor(props) {
      super(props);
      this.state = { crashed: false };
    }

    /** React 16+ 的"渲染出错"钩子：切到"已崩"状态，下一次 render 返回 null。 */
    static getDerivedStateFromError() {
      return { crashed: true };
    }

    /** 出错后的报告：只报一次；`onError` 自己坏了也不能再抛（边界不能二次崩溃）。 */
    componentDidCatch(error) {
      if (!onError) return;
      try {
        onError(normalizeError(error, { code: CODES.UI_RENDER_FAILED, blockedBy: 'ui' }));
      } catch {
        /* 报告口自己坏了：这里再抛就绕过边界了，只能吞掉 */
      }
    }

    render() {
      if (this.state && this.state.crashed) return null;
      return this.props ? this.props.children : null;
    }
  }

  return MilieuErrorBoundary;
}
