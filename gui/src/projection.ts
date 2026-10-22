/**
 * 投影同源 re-export（G2 裁定）：gui 直接 import 主仓 TS 源（vite/esbuild 转译，零构建产物耦合）——
 * board/delegation reducer 与 TUI session 同一单点，gui 侧不改写不复制，防形态漂移。
 * boardEventFrom 实时化（G3 Task 2）：事件流翻译单点自 taskboard/translate.ts（纯模块，零 TUI 依赖）
 * 经本单点 re-export——gui 不直引主仓文件，浏览器 bundle 不拉入 TUI 模块图。
 */
export { applyBoardEvent, emptyBoard } from '../../src/taskboard/model';
export { boardEventFrom } from '../../src/taskboard/translate';
export { applyDelegation } from '../../src/delegation/projection';
export type { TaskBoardState, BoardTask, TaskStatus } from '../../src/taskboard/model';
export type { Delegation } from '../../src/delegation/projection';
import type { TodoItem } from '../../src/types';
import type { TaskBoardState } from '../../src/taskboard/model';
import type { Delegation } from '../../src/delegation/projection';

/** G5/G14.137 会话维投影总容器(D34 串态收口,第二十五轮;D42 自 App.tsx 迁入共享——连接装配
 *  回调与壳路由同消费):board/会话待办/委派/team 四件一容器——清零点(onReset/onResetSession/
 *  openSession/backHome)整替一处,人工枚举漏项的开集弱点根除 */
export interface SessionProjection {
  board: TaskBoardState;
  sessionTodos: TodoItem[];
  delegations: Delegation[];
  team: Array<{ name: string; busy: boolean }>;
}
