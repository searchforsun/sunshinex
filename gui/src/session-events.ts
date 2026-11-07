/** 会话删除成功的窗口事件(detail=删除时用的 id,运行时 id 或 journalId):浏览器页签池卸载该会话常驻 webview。
 *  独立模块:connection 在测试中被整体 mock,常量放这里两边都可取 */
export const SESSION_DELETED_EVENT = 'sx-session-deleted';
/** 会话归档成功的窗口事件(detail=归档的会话 id,archived 恒 true——撤销归档不发):
 *  2026-11-04 用户裁定「归档/删除当前会话,主对话直接回欢迎页」——归档入口分散(顶栏 ⋯/
 *  侧栏行菜单/命令),App 侧一处监听统一收口 */
export const SESSION_ARCHIVED_EVENT = 'sx-session-archived';
/** 会话归档态变更的窗口事件(双向:归档/撤销都发;detail={id, archived},id=操作时用的运行时 id 或
 *  journalId)。顶栏「已归档」徽标是 Chat 本地态,入口在侧栏/归档层时经此同步(2026-11-07 用户实测
 *  「侧栏撤销归档,顶栏已归档标不消失」) */
export const SESSION_ARCHIVE_CHANGED_EVENT = 'sx-session-archive-changed';
export interface SessionArchiveChange {
  readonly id: string;
  readonly archived: boolean;
}
