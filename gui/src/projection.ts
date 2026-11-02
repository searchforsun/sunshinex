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
import type { SessionEvent, TodoItem } from '../../src/types';
import type { TaskBoardState } from '../../src/taskboard/model';
import type { Delegation } from '../../src/delegation/projection';

/** 任务板卡头团队引用（快照 teams / team-created / task-created.teamName 同源） */
export interface BoardTeamRef {
  teamId: string;
  name: string;
  createdAt: number;
}

/** G5/G14.137 会话维投影总容器(D34 串态收口,第二十五轮;D42 自 App.tsx 迁入共享——连接装配
 *  回调与壳路由同消费):board/会话待办/委派/team 四件一容器——清零点(onReset/onResetSession/
 *  openSession/backHome)整替一处,人工枚举漏项的开集弱点根除 */
export interface SessionProjection {
  board: TaskBoardState;
  sessionTodos: TodoItem[];
  delegations: Delegation[];
  team: Array<{ name: string; busy: boolean; teamId?: string; createdAt?: number }>;
  /** 快照 teams：智能体团队一队一卡的标题 */
  teams: BoardTeamRef[];
}

/** 队名 upsert：同 teamId 已在则以新非空名覆盖；缺席则追加。供 team-created / task-created 直播。 */
export function upsertBoardTeam(teams: readonly BoardTeamRef[], next: BoardTeamRef): BoardTeamRef[] {
  if (next.teamId === '' || next.name === '') return teams as BoardTeamRef[];
  const idx = teams.findIndex((t) => t.teamId === next.teamId);
  if (idx < 0) return [...teams, next];
  if (teams[idx]!.name === next.name && teams[idx]!.createdAt === next.createdAt) return teams as BoardTeamRef[];
  const out = [...teams];
  out[idx] = { ...out[idx]!, name: next.name, createdAt: next.createdAt || out[idx]!.createdAt };
  return out;
}

/** 从 SessionEvent 抽取队名并 upsert：team-created 全量；task-created 读 teamName/teamCreatedAt。 */
export function applyTeamNameEvent(teams: readonly BoardTeamRef[], e: SessionEvent): BoardTeamRef[] {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.type === 'team-created') {
    const teamId = typeof p.teamId === 'string' ? p.teamId : '';
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const createdAt = typeof p.createdAt === 'number' ? p.createdAt : e.ts;
    return upsertBoardTeam(teams, { teamId, name, createdAt });
  }
  if (e.type === 'task-created') {
    const teamId = typeof p.teamId === 'string' ? p.teamId : '';
    const name = typeof p.teamName === 'string' ? p.teamName.trim() : '';
    const createdAt = typeof p.teamCreatedAt === 'number' ? p.teamCreatedAt : e.ts;
    return upsertBoardTeam(teams, { teamId, name, createdAt });
  }
  return teams as BoardTeamRef[];
}

export type TeamMemberRef = { name: string; busy: boolean; teamId?: string; createdAt?: number };

/** 后台任务账本行(与 connection SessionTaskRow 对齐;live 事件无 outputTail,保留既有尾) */
export type BgTaskRow = {
  id: string;
  kind: string;
  label: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  outputTail?: string;
  outputTruncated?: boolean;
};

/** bg-task 事件 upsert:只收 exec/subagent;保留既有 outputTail(终态全文仍靠手动/开签 GET) */
export function applyBgTaskEvent(rows: readonly BgTaskRow[], e: SessionEvent): BgTaskRow[] {
  if (e.type !== 'bg-task') return rows as BgTaskRow[];
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id : '';
  const kind = typeof p.kind === 'string' ? p.kind : '';
  if (id === '' || (kind !== 'exec' && kind !== 'subagent')) return rows as BgTaskRow[];
  const label = typeof p.label === 'string' ? p.label : id;
  const status = typeof p.status === 'string' ? p.status : 'running';
  const startedAt = typeof p.startedAt === 'number' ? p.startedAt : e.ts;
  const endedAt = typeof p.endedAt === 'number' ? p.endedAt : undefined;
  const exitCode = typeof p.exitCode === 'number' ? p.exitCode : undefined;
  const idx = rows.findIndex((r) => r.id === id);
  const prev = idx >= 0 ? rows[idx] : undefined;
  const next: BgTaskRow = {
    id,
    kind,
    label,
    status,
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(prev?.outputTail !== undefined ? { outputTail: prev.outputTail } : {}),
    ...(prev?.outputTruncated === true ? { outputTruncated: true } : {}),
  };
  if (idx < 0) return [...rows, next];
  const out = [...rows];
  out[idx] = next;
  return out;
}

/** 成员名册直播：teammate-created 登记；delegation-*（subagent + 已在册名）翻转 busy。
 *  仅名册内成员改 busy——spawn 一次性 fork 的同形委派不误入成员栏。 */
export function applyTeamMemberEvent(members: readonly TeamMemberRef[], e: SessionEvent): TeamMemberRef[] {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.type === 'teammate-created') {
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (name === '') return members as TeamMemberRef[];
    const teamId = typeof p.teamId === 'string' && p.teamId !== '' ? p.teamId : undefined;
    const createdAt = typeof p.createdAt === 'number' ? p.createdAt : e.ts;
    const busy = p.busy === true;
    const idx = members.findIndex((m) => m.name === name);
    const next: TeamMemberRef = {
      name,
      busy,
      ...(teamId !== undefined ? { teamId } : {}),
      ...(createdAt > 0 ? { createdAt } : {}),
    };
    if (idx < 0) return [...members, next];
    const out = [...members];
    out[idx] = {
      ...out[idx]!,
      ...next,
      // 重发保既有 createdAt(缺新值时)
      createdAt: next.createdAt ?? out[idx]!.createdAt,
      teamId: next.teamId ?? out[idx]!.teamId,
    };
    return out;
  }
  if (e.type === 'delegation-started' || e.type === 'delegation-ended') {
    if (p.kind !== 'subagent') return members as TeamMemberRef[];
    const name = typeof p.label === 'string' ? p.label.trim() : '';
    if (name === '') return members as TeamMemberRef[];
    const idx = members.findIndex((m) => m.name === name);
    if (idx < 0) return members as TeamMemberRef[]; // 非名册成员(spawn fork)忽略
    const busy = e.type === 'delegation-started';
    if (members[idx]!.busy === busy) return members as TeamMemberRef[];
    const out = [...members];
    out[idx] = { ...out[idx]!, busy };
    return out;
  }
  return members as TeamMemberRef[];
}
