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
