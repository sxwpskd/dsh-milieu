// dsh-milieu —— 稳定错误码（纯常量层：不 import 任何层、不放业务判断）
//
// 为什么要有它（task-5）：失败路径如果只带一句人话 `reason`，调用方就没法稳定地区分
//   "是宿主服务没了"还是"写文件被拒"。错误码是**机器可判**的那一半，`reason` 是**人可读**的那一半。
//
// 纪律：**码值一旦发布就不改，只增**（日志/诊断/测试可能拿它做判据）。
//   码值用小写短横线；`unknown` 是兜底，不许拿它当"分类"用。

/** 全部稳定错误码。 */
export const CODES = Object.freeze({
  // ---- 宿主 / 平台服务（adapter/dsh.js 的翻译结果） ----
  HOST_UNAVAILABLE: 'host-unavailable',        // 宿主没有这个服务/接口
  HOST_CALL_FAILED: 'host-call-failed',        // 宿主接口调用了，但抛错/拒绝
  WORKSPACE_NOT_FOUND: 'workspace-not-found',  // 平台里找不到对应工作区 id

  // ---- 文件系统（adapter/fs.js / 核心层写入边界） ----
  FS_UNAVAILABLE: 'fs-unavailable',            // 没有文件系统能力对象
  FS_READ_FAILED: 'fs-read-failed',            // 读文件失败（含源文件缺失）
  FS_WRITE_FAILED: 'fs-write-failed',          // 写文件 / 建目录失败

  // ---- 配置 ----
  CONFIG_INVALID: 'config-invalid',            // 配置缺失或形状不可用

  // ---- 协议 ----
  PROTOCOL_SOURCE_MISSING: 'protocol-source-missing', // 插件包里的协议源文件读不到
  PROTOCOL_WRITE_FAILED: 'protocol-write-failed',     // 写工作区协议失败

  // ---- 会话 ----
  SESSION_CREATE_FAILED: 'session-create-failed', // 建会话 / 建 agent 失败
  SESSION_INSPECT_FAILED: 'session-inspect-failed', // 查会话状态失败
  SESSION_LIST_FAILED: 'session-list-failed',   // 读会话列表失败（事件监听之外的另一条宿主能力）
  SESSION_PROMPT_FAILED: 'session-prompt-failed', // 发请求失败

  // ---- 状态账 / 注入页 ----
  STATE_PARSE_FAILED: 'state-parse-failed',   // 状态文件解析失败（客户端读坏文件）
  STATE_SCAN_FAILED: 'state-scan-failed',     // 扫描工作区失败
  STATE_WRITE_FAILED: 'state-write-failed',   // 写状态文件 / 基准失败
  STATE_INJECT_FAILED: 'state-inject-failed', // 刷新/拼装注入页失败（装饰，fail-open）

  // ---- 界面 ----
  UI_INIT_FAILED: 'ui-init-failed',     // 客户端启动/接线失败
  UI_READ_FAILED: 'ui-read-failed',     // 读状态文件失败
  UI_SEND_FAILED: 'ui-send-failed',     // 发重读请求失败
  UI_RENDER_FAILED: 'ui-render-failed', // 卡片渲染失败

  // ---- 兜底 ----
  UNKNOWN: 'unknown',
});

/**
 * 每一层（ARCHITECTURE.md 的层名）的**默认错误码**：`normalize` 没拿到更具体的码时用它。
 * 只覆盖本插件实际会出现的层；`unknown` 是兜底。
 */
export const LAYER_CODES = Object.freeze({
  host: CODES.HOST_CALL_FAILED,
  fs: CODES.FS_WRITE_FAILED,        // 默认按写入（读失败由调用方显式给 FS_READ_FAILED）
  config: CODES.CONFIG_INVALID,
  protocol: CODES.PROTOCOL_WRITE_FAILED,
  session: CODES.SESSION_CREATE_FAILED,
  state: CODES.STATE_SCAN_FAILED,
  ui: CODES.UI_READ_FAILED,
  unknown: CODES.UNKNOWN,
});

/** 已知层名（供测试与 normalize 校验；顺序即上表顺序）。 */
export const LAYERS = Object.freeze(Object.keys(LAYER_CODES));

/** 这一层的默认错误码；不认识的层 → `unknown`。 */
export function codeForLayer(layer) {
  if (typeof layer !== 'string') return CODES.UNKNOWN;
  return LAYER_CODES[layer] || CODES.UNKNOWN;
}

/** 是不是一个稳定错误码（防止把平台自己的 `ENOENT` / `EACCES` 混进来当分类）。 */
export function isKnownCode(code) {
  if (typeof code !== 'string') return false;
  for (const value of Object.values(CODES)) if (value === code) return true;
  return false;
}
