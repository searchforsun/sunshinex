// boardEventFrom 抽出裁定(G3 Task 2):自 tui/session.ts 逐字迁入的纯翻译单点——gui 投影实时化消费
// (gui/src/projection.ts re-export,板/委派事件流浏览器侧直跑)+ 防浏览器 bundle 拉入 TUI 模块图
// (session.ts 经 runtime/md-stream/terminal-setup 等重依赖面,翻译单点必须可独立引用)。
// 纯模块约束:import 仅类型(types + taskboard/model),零运行时依赖、零 IO——镜像属性测试
// (mirror.test.ts)与 TUI/daemon 影子投影三方同源消费,迁移不改语义(session.board.test 零改动全绿为判据)。
import type { SessionEvent } from '../types';
import type { BoardEvent, TaskStatus } from './model';

/** SessionEvent(task- 前缀事件) → BoardEvent 翻译单点:与 TaskBoard.emit 载荷口径互为镜像
 *  (created/status/unlocked/blocked/dep-added/assigned;success 收口透传 conclusion/tokens/durationMs)。
 *  公开 = 镜像属性测试钉口径(mirror.test.ts)消费 */
export function boardEventFrom(e: SessionEvent): BoardEvent {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const taskId = String(p.taskId ?? '');
  const ts = e.ts;
  switch (e.type) {
    case 'task-created': {
      const retryOf = typeof p.retryOf === 'string' ? p.retryOf : undefined;
      return {
        t: 'task-created', taskId, title: String(p.title ?? ''), spec: String(p.spec ?? ''),
        dependsOn: Array.isArray(p.dependsOn) ? (p.dependsOn as string[]) : [],
        teamId: typeof p.teamId === 'string' ? p.teamId : '',
        ts,
        ...(retryOf !== undefined ? { retryOf } : {}),
      };
    }
    case 'task-dep-added':
      return { t: 'dependency-added', taskId, dependsOn: String(p.dependsOn ?? ''), ts };
    case 'task-assigned':
      return { t: 'assigned', taskId, assignee: String(p.assignee ?? ''), ts };
    case 'task-status-changed':
      return {
        t: 'status-changed',
        taskId,
        from: (p.from as TaskStatus) ?? 'pending',
        to: (p.status as TaskStatus) ?? 'pending',
        ts,
        ...(typeof p.by === 'string' ? { by: p.by } : {}),
        ...(typeof p.conclusion === 'string' ? { conclusion: p.conclusion } : {}),
        ...(typeof p.tokens === 'number' ? { tokens: p.tokens } : {}),
        ...(typeof p.durationMs === 'number' ? { durationMs: p.durationMs } : {}),
      };
    default:
      return { t: 'status-changed', taskId, from: 'pending', to: 'pending', ts }; // task-unlocked/task-blocked:投影无状态变化,reducer 原引用返回
  }
}
