/** 会话删除成功的窗口事件(detail=删除时用的 id,运行时 id 或 journalId):浏览器页签池卸载该会话常驻 webview。
 *  独立模块:connection 在测试中被整体 mock,常量放这里两边都可取 */
export const SESSION_DELETED_EVENT = 'sx-session-deleted';
