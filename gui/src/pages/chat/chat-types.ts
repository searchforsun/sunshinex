import type { MutableRefObject } from 'react';
import type { Connection, ConnectionState, GuiApprovalReq, GuiAskReq, GuiPlanApprovalReq, RestorePlan, RewindTarget, SnapshotResponse } from '../../connection';
import type { ChatEntry } from '../../chat-reducer';
import type { SessionEvent, TodoItem } from '../../../../src/types';
import type { TaskBoardState } from '../../projection';
import type { TodoBatch } from './ToolEntry';
import type { NavControls } from '../../nav-history';
import type { PinEntry } from '../../sidebar/pin-store';

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
  /** 阶段三 plan-arm 计划审批挂起帧(同 approval/ask 装配形态;pid=回执寻址键) */
  onPlanApproval(pid: string, req: GuiPlanApprovalReq): void;
  /** G4 会话 reset 通知帧(本会话):清卡(daemon 已 deny/dismissed 回填) + 清投影重播种 */
  resetSession(): void;
}

export interface RewindRequest {
  target: RewindTarget;
  restoreFiles: boolean;
  resend: { text: string; images?: string[] };
}

/** 编辑重发操作面(Chat 组装、MessageList 透传、UserEntryView 消费;引用恒稳不破行组件 memo)。
 *  「回到此轮」独立按钮已退役(2026-11-06 用户裁定:想回退复制原文走编辑重发即可),回退只此一条入口 */
export interface RewindOps {
  /** 运行中(含命令运行态):底层拒绝回退,编辑卡据此提示先停止 */
  busy(): boolean;
  planForEntry(entry: ChatEntry): Promise<RestorePlan>;
  resendFrom(entry: ChatEntry, text: string, images: string[] | undefined, restoreFiles: boolean): Promise<void>;
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
  /** 首问 token 的选取全文(2026-11-07 串扰根修,与 insert 同路;挂载即入私有账本) */
  readonly initialInsertContent?: string;
  /** 首问注入消费回调(2026-11-07 用户实测「重启后每个辅助会话都多一枚片段」根修):insert
   *  参数持久化于页签档,消费后即清(页签档置空串),否则每次挂载/重启重放=删了又现 */
  onInsertConsumed?: () => void;
  /** G8d write 条目 path 钮主通道:开 diff 标签(callId 寻址,App 接 openTabInSession('diff',
   *  {callId,path}));可选防测试桩免配——缺场时全部回落 onOpenFile */
  onOpenDiff?: (callId: string, path: string) => void;
  /** 轮次 checkpoint 通道(2026-11-10 用户裁定「每轮精确看到自己的改动」):改动条文件名点击 →
   *  本轮单文件 diff 页签(run+path 寻址;App 接 openTabInSession('turndiff',{run,path})) */
  onOpenTurnDiff?: (run: number, path: string) => void;
  /** G14.171 spawn 行子智能体名=蓝色链接:点开对应 agent 只读标签页(App 接 openTabInSession('agent',{label,agentTitle})) */
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  /** 浏览器工具联动(2026-10-31 用户裁定「浏览器默认直接打开侧栏的浏览器」):browser_navigate
   *  落条时上抛目标 url,App 开 web 页签跟随(判重/聚焦由 openTabInSession 承担);可选防桩免配 */
  onOpenWeb?: (url: string) => void;
  /** 轮次发起回执(2026-11-01「不自动打开浏览器,切会话才显示」根修配套):提交被接受即回执,
   *  App 据此重置内置浏览器自动开签守卫——每轮 run 都允许自动开签(同会话上一轮开过/被关不锁死) */
  onRunStart?: () => void;
  /** 工具行任务名/队名链接:任务 ref 开任务板高亮卡;`team:` 前缀开指定队卡(App 接 openTaskFocus) */
  onOpenTask?: (taskRef: string) => void;
  /** G14.177 顶栏动态计数按钮:打开对应页签(待办=tasks/智能体团队=agents/后台任务=bgtasks) */
  onOpenTab?: (type: 'tasks' | 'agents' | 'bgtasks' | 'diff' | 'plans') => void;
  /** agentTeams 开关(缺省 true):关则顶栏不显团队任务计数钮 */
  agentTeamsOn?: boolean;
  /** 后台任务 running 数(App 经 bg-task 直播;顶栏动态计数) */
  bgRunning?: number;
  /** G14.172 task_wait 行任务名解析材料(任务板投影;App 注入会话板) */
  board?: TaskBoardState;
  /** 队名解析材料(get_agent_team_board/create_agent_team 链接;App 注入投影 teams) */
  teams?: readonly import('../../projection').BoardTeamRef[];
  /** G14.174 待办批次上抛(每批 todo_write 一卡:时间/关联轮次输入/条目;App 经 services 供待办页签) */
  onTodoBatches?: (batches: TodoBatch[]) => void;
  /** 待办卡主名字定位信号(2026-11-03):nonce 变更即滚到关联轮次正文输入气泡 */
  todoFocus?: { key: string; nonce: number } | null;
  /** 成员转录 leader 链接定位信号(2026-11-08;nonce 变更即滚动高亮):toLeader=该成员发来的消息气泡,
   *  fromLeader=leader 发出该消息的发送团队消息工具行 */
  leaderFocus?: { member: string; text: string; dir: 'toLeader' | 'fromLeader'; nonce: number } | null;
  /** 2026-11-04 正文圈选·辅助会话提问通道(添加到主对话=insert-ref 事件,组件内置) */
  onSideAsk?: (text: string, content?: string) => void;
  /** 2026-11-04 待办行点击定位:打开待办页签+定位对应卡(App 开页签+落定位信号) */
  onTodoLocate?: (todos: Array<{ text: string; status: string }>) => void;
    /** 2026-11-04 fork 横幅导航:「分叉于会话」点击回父会话(App openSession;root 同源) */
  onOpenSession?: (sessionId: string) => void;
  /** 回退(2026-11-05 编辑重发):App 接 rewindSession+页签迁座+换座,编辑重发唯一通道;
   *  未配=编辑卡退回追加发送(辅助对话页签/测试桩)。resend=回退落定后重发的编辑文本 */
  onRewind?: (req: RewindRequest) => Promise<void>;
  /** 会话级操作错误上抛(2026-10-21 归档 F4):App showOpError 通道(与 fork/rewind 同一 sx-toast
   *  错误条)——顶栏归档失败不再静默回摆,错误文案透传上屏;可选防测试桩免配 */
  onOpError?: (err: unknown) => void;
  /** 轮末产物卡「产物库」链接通道(2026-11-12 spec §4):Task 12 接 App openTabInSession('artifacts')——
   *  本任务纯类型面透传,App 不传即全链 undefined(编译序:'artifacts' TabTypeId Task 12 才注册) */
  readonly onOpenArtifacts?: () => void;
  /** G10-C4 分叉新会话(/fork 底层);App 接 forkSession+openSession;可选。
   *  2026-11-04 用户裁定「fork 显示点击点之上所有记录」:收轮次序位(turn=1-based,点击的
   *  run 在转录中的序),宿主按该轮锚点分档——新会话时间线=点击点之上全部记录 */
  onFork?: (turn: number) => void;
  /** G10 欢迎页接力:播种完成后提交的 welcome 目标(setWelcomeGoal 写入;提交即回调清位) */
  pendingGoal?: { root: string; goal: string; images?: string[] };
  onPendingGoalDone?: () => void;
  /** 会话所属工作区 root(G10 项目条显示;default 会话='default') */
  root?: string;
  /** 标题落盘后上抛(G14.16:App bump recentVersion → 侧栏 RECENTS 即时同名) */
  onRenamed?: () => void;
  /** 会话数据变更上抛(2026-10-22:顶栏 ⋯ 菜单置顶/归档/标记未读后,App bump recentVersion → 侧栏联动刷新) */
  onSessionsMutated?: () => void;
  /** 置顶档单源(2026-11-07 置顶卡顿根修):App 乐观态直通顶栏,置顶/取消零往返 */
  readonly pins?: PinEntry[];
  readonly persistPins?: (next: PinEntry[]) => void;
  /** 2026-10-24 用户裁定:[|] 切换钮=菜单关闭态显示在会话名左(呼出);菜单开着时收起钮在菜单头右上(不双显) */
  menuClosed?: boolean;
  onToggleMenu?: () => void;
  /** G14.29 输入 /btw /side 拦截:开辅助对话旁路标签(不动 daemon 提交面) */
  onSideChat?: () => void;
  /** G14.148 /memory(-rm) 拦截:开记忆标签(GUI 的删除面;daemon 命令通道不支持 TUI 交互多选) */
  onOpenMemory?: (focus?: string) => void;
  /** 学习技能页签(2026-10-31):[skills] learned/updated 回显行点击打开(App 开 learned 页签) */
  onOpenLearned?: (skillId?: string) => void;
  /** G14.31 辅助对话全新视图标记(2026-11-06 语义退役:side fork 档零继承转录行,种子=辅助对话
   *  自身往来,清种子曾致重启恢复后空白)——保留 prop 兼容旧装配,组件内不再消费 */
  freshView?: boolean;
  /** G14.32 顶栏定名(辅助对话):压过会话名回落链,不露注册 id */
  fixedTitle?: string;
  /** G14.2xx 辅助对话形态:空态文案/composer 占位用 side 变体(sidechat 页签注入) */
  sideChat?: boolean;
  /** G14.213 滚动位存档键:journal 档案 id(稳定跨重挂/重启)。sessionId 是活动会话别名
   *  (每次重开经 newSession+attach 重新发号,s165→s167),按它存档永远失配;未配回落 sessionId */
  journalId?: string;
  /** 2026-10-25 应用级导航(前进/后退)控制面:App 壳持历史,顶栏左聚钮对消费;可选防测试
   *  桩/旁路 Chat(辅助对话页签)免配——缺场顶栏不渲染钮对 */
  nav?: NavControls;
  /** G14.2xx b 转录内存缓存(App LRU 面):挂载命中即以缓存态直渲(快照播种落定无缝整替),
   *  卸载写回最新投影——切会话回来不再白屏等快照往返。缺省(测试桩/旁路面)不缓存 */
  chatMem?: { get(key: string): import('../../chat-reducer').ChatState | undefined; put(key: string, state: import('../../chat-reducer').ChatState): void };
  /** 2026-11-10 终端下栏:App pty 记账单点透传(dock 标签体 TerminalTab 与右栏同款装配/重连) */
  ptyIdFor?: (uid: string) => string | undefined;
  onPtyAllocated?: (uid: string, ptyId: string) => void;
  /** dock 标签 ×:App 既有关标签 kill 链(takePtyId→killPty)——dock 复用同一单点 */
  onCloseDockTab?: (uid: string) => void;
}
