// dsh-milieu —— 状态文件的固定值（不随部署变化；可调阈值在 config/criteria.js）
//
// 位置：<认知库>/milieu-state.json

/** 状态文件名（宿主写、客户端读的**唯一一份材料**）。 */
export const STATE_FILE = 'milieu-state.json';

/** 状态文件版本：形状变了就升；客户端的 parseState 只认这个版本。 */
export const STATE_VERSION = 3;

/** 受管会话的角色（先留这两种；将来有别的再加）。 */
export const ROLES = ['preload', 'active'];
