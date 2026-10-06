/**
 * 投影同源 re-export（G2 裁定）：gui 直接 import 主仓 TS 源（vite/esbuild 转译，零构建产物耦合）——
 * board/delegation reducer 与 TUI session 同一单点，gui 侧不改写不复制，防形态漂移。
 */
export { applyBoardEvent, emptyBoard } from '../../src/taskboard/model';
export { applyDelegation } from '../../src/delegation/projection';
export type { TaskBoardState, BoardTask, TaskStatus } from '../../src/taskboard/model';
export type { Delegation } from '../../src/delegation/projection';
