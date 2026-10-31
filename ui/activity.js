// dsh-milieu —— 当前会话与最后活动时间（界面层工具：无副作用、不碰 ctx）
//
// 两件事：
//   ① 当前主视图在看哪条会话（平台用 `retainedBy.mainView > 0` 表示）；
//   ② 这条会话的**最后活动时间**——判据最后一关的基准。
//
// 为什么不自己记"上次读"（2026-10-16 主人定的口径）：
//   平台会话列表里本来就有 `updatedAt`；我们另记一份 = 同一件事两个版本，一旦不一致不报错。
//   **只在用会话，改动基本可以忽略**；会话搁置了才需要提醒"变了，要不要重读"。
//
// 责任边界（ARCHITECTURE.md 工作包 C）：这里只处理数据形状；`ctx` 的扩展点由
//   `ui/plugin.js` 取好再传进来（调用方传 `ctx.sessions`），本文件不直接碰 ctx。

/**
 * 取当前会话 id：平台用 `retainedBy.mainView > 0` 表示"主视图正在看它"。
 * 认不出来返回 null（**null 表示"这次没认出来"，不是"切到了空会话"**——调用方别拿它清空状态）。
 * @param {object} sessions `ctx.sessions`（可能没有）
 */
export function currentMainSessionId(sessions) {
  const list = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot();
  if (!list || !list.byId) return null;
  // 优先用调用方给的首选 id（插槽 props 里通常有），其次按主视图计数找
  for (const id of list.ids || Object.keys(list.byId)) {
    const row = list.byId[id];
    if (row && (row.retainedBy && row.retainedBy.mainView ? row.retainedBy.mainView : 0) > 0) return id;
  }
  return null;
}

/**
 * 取这条会话的**最后活动时间**——判据第 ④ 关的基准。
 * 来源是平台会话列表里的 `updatedAt`（不另存一份"上次读"）。
 * 拿不到就返回 null → 判据走"保守提示"。
 * @param {object} sessions `ctx.sessions`（可能没有）
 * @param {string} sessionId
 */
export function sessionActivityAt(sessions, sessionId) {
  const list = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot();
  const row = list && list.byId && list.byId[sessionId];
  const at = row && (typeof row.updatedAt === 'number' ? row.updatedAt : (typeof row.lastActivityAt === 'number' ? row.lastActivityAt : null));
  return typeof at === 'number' ? at : null;
}
