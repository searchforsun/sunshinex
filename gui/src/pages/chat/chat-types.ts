import type { MutableRefObject } from 'react';
import type { Connection, ConnectionState, GuiApprovalReq, GuiAskReq, SnapshotResponse } from '../../connection';
import type { SessionEvent, TodoItem } from '../../../../src/types';
import type { TaskBoardState } from '../../projection';
import type { TodoBatch } from './ToolEntry';

/** Chat 公开类型面(D32 第六批批F-7c 自 Chat.tsx 平移):ChatSink/ChatProps——
 *  Chat.tsx 原路径再导出(App/测试消费零迁移),宿主 type-import 回引。
 *  P11 T7:工具调用旁路结构类型退役(G6 双通道归一字段单源)——工具条渲染全走内核
 *  条目 name/input/result/status 直映,本文件不再持工具条结构类型。 */

export interface ChatSink {
  /** 本会话帧(已过 App 侧 sessionId 过滤;seq 供种子竞态窗过滤) */
  on(e: SessionEvent, seq: number): void;
  /** 连接重置(首连/重连):清投影 + 本会话重播种(卡保留——挂起仍在 daemon 未决) */
  reset(): void;
  /** G4 审批挂起帧(已过 App 侧 sessionId 过滤;pid = 回执寻址键) */
  onApproval(pid: string, req: GuiApprovalReq): void;
  /** G4 问询挂起帧(同上) */
  onAsk(pid: string, req: GuiAskReq): void;
  /** G4 会话 reset 通知帧(本会话):清卡(daemon 已 deny/dismissed 回填) + 清投影重播种 */
  resetSession(): void;
}

export interface ChatProps {
  conn: Connection;
  /** 当前会话(:id 动作与播种的维) */
  sessionId: string;
  /** 连接状态机(App 壳单连接透传;composer 门:非 open 禁用) */
  connState: ConnectionState;
  /** 返回首页(App 路由回调;Chat 顶栏「返回首页」) */
  onBack(): void;
  /** App 持有的转投注册面(见 ChatSink) */
  sinkRef: MutableRefObject<ChatSink | null>;
  /** G5 快照落定回调(App 消费 snapshot.team 存态——Board 侧栏;可选防测试桩免配) */
  onSeeded?: (snap: SnapshotResponse) => void;
  /** G6 write 工具 path 按钮回调(App 切 Files tab 并带 initialPath;可选防测试桩免配)。G8d 起
   *  降为回退通道:callId 在场的 write 条目优先走 onOpenDiff(开 diff 标签),callId 缺场(种子
   *  条/无 callId 面)仍开文件标签预览 */
  onOpenFile?: (path: string) => void;
  /** G14.137 todo_write 清单上抛(App 存态喂任务标签会话待办区) */
  onTodos?: (todos: TodoItem[]) => void;
  /** G14.154 挂载即落的初始引用(文件选区「在辅助对话中提问」经 fork 参数携带) */
  initialInsert?: string;
  /** G8d write 条目 path 钮主通道:开 diff 标签(callId 寻址,App 接 openTabInSession('diff',
   *  {callId,path}));可选防测试桩免配——缺场时全部回落 onOpenFile */
  onOpenDiff?: (callId: string, path: string) => void;
  /** G14.171 spawn 行子智能体名=蓝色链接:点开对应 agent 只读标签页(App 接 openTabInSession('agent',{label,agentTitle})) */
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  /** G14.176 create_task 行任务名=蓝色链接:点开任务板并定位高亮对应卡(App 接 openTabInSession('agents')+focus 定位) */
  onOpenTask?: (taskRef: string) => void;
  /** G14.177 顶栏动态计数按钮:打开对应页签(待办=tasks/任务板=agents/后台任务=bgtasks) */
  onOpenTab?: (type: 'tasks' | 'agents' | 'bgtasks') => void;
  /** G14.172 task_wait 行任务名解析材料(任务板投影;App 注入会话板) */
  board?: TaskBoardState;
  /** G14.174 待办批次上抛(每批 todo_write 一卡:时间/关联轮次输入/条目;App 经 services 供待办页签) */
  onTodoBatches?: (batches: TodoBatch[]) => void;
  /** G14.174 关联轮次用户输入上抛(最近一条 user 行;任务板卡片头共用) */
  onTurnGoal?: (goal: string) => void;
  /** G10-C4 回到此轮(/rewind 底层):turn=anchors 1-based;App 接 rewindSession+重开;可选 */
  onRewind?: (turn: number) => void;
  /** 会话级操作错误上抛(2026-10-21 归档 F4):App showOpError 通道(与 fork/rewind 同一 sx-toast
   *  错误条)——顶栏归档失败不再静默回摆,错误文案透传上屏;可选防测试桩免配 */
  onOpError?: (err: unknown) => void;
  /** G10-C4 分叉新会话(从最近任务轮;/fork 底层);App 接 forkSession+openSession;可选 */
  onFork?: () => void;
  /** G10 欢迎页接力:播种完成后提交的 welcome 目标(setWelcomeGoal 写入;提交即回调清位) */
  pendingGoal?: { root: string; goal: string };
  onPendingGoalDone?: () => void;
  /** 会话所属工作区 root(G10 项目条显示;default 会话='default') */
  root?: string;
  /** 标题落盘后上抛(G14.16:App bump recentVersion → 侧栏 RECENTS 即时同名) */
  onRenamed?: () => void;
  /** 会话数据变更上抛(2026-10-22:顶栏 ⋯ 菜单置顶/归档/标记未读后,App bump recentVersion → 侧栏联动刷新) */
  onSessionsMutated?: () => void;
  /** G14.28:右栏折叠时顶栏右侧示「展开侧栏」钮(折叠态不渲染 32px 细条) */
  /** G14.29 输入 /btw /side 拦截:开辅助对话旁路标签(不动 daemon 提交面) */
  onSideChat?: () => void;
  /** G14.148 /memory(-rm) 拦截:开记忆标签(GUI 的删除面;daemon 命令通道不支持 TUI 交互多选) */
  onOpenMemory?: () => void;
  /** G14.31 辅助对话全新视图:种子历史不落屏(上下文只在模型侧),开播即空会话观感 */
  freshView?: boolean;
  /** G14.32 顶栏定名(辅助对话):压过会话名回落链,不露注册 id */
  fixedTitle?: string;
  /** G14.2xx 辅助对话形态:空态文案/composer 占位用 side 变体(sidechat 页签注入) */
  sideChat?: boolean;
  /** G14.213 滚动位存档键:journal 档案 id(稳定跨重挂/重启)。sessionId 是活动会话别名
   *  (每次重开经 newSession+attach 重新发号,s165→s167),按它存档永远失配;未配回落 sessionId */
  journalId?: string;
  /** G14.2xx b 转录内存缓存(App LRU 面):挂载命中即以缓存态直渲(快照播种落定无缝整替),
   *  卸载写回最新投影——切会话回来不再白屏等快照往返。缺省(测试桩/旁路面)不缓存 */
  chatMem?: { get(key: string): import('../../chat-reducer').ChatState | undefined; put(key: string, state: import('../../chat-reducer').ChatState): void };
}
