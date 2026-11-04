/** 会话删除成功的窗口事件(detail=删除时用的 id,运行时 id 或 journalId):浏览器页签池卸载该会话常驻 webview。
 *  独立模块:connection 在测试中被整体 mock,常量放这里两边都可取 */
export const SESSION_DELETED_EVENT = 'sx-session-deleted';
/** 会话归档成功的窗口事件(detail=归档的会话 id,archived 恒 true——撤销归档不发):
 *  2026-11-04 用户裁定「归档/删除当前会话,主对话直接回欢迎页」——归档入口分散(顶栏 ⋯/
 *  侧栏行菜单/命令),App 侧一处监听统一收口 */
export const SESSION_ARCHIVED_EVENT = 'sx-session-archived';
