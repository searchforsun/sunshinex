/**
 * G8a 标签类型注册表(task-3 简报):每类标签的五件套声明——id/group/title/resolveKey/
 * singleton/render——标签条「+」菜单、uid 判重探针(registryProbe)与 T5 标签体渲染共此一表;
 * G8b-d 增类(diff/agents/directory/terminal/web)只需在此追加条目,菜单/判重自动跟进。
 * render 直接复用既有 pages 组件(Files/Board,不改它们);T6 才接线 App——本模块零 App
 * 依赖,投影面经 TabServices 注入(T5 组装)。
 */

import { Files } from '../pages/Files';
import { TerminalTab } from './TerminalTab';
import { DirectoryTab } from './DirectoryTab';
import { DiffTab } from './DiffTab';
import { AgentTranscriptTab } from './AgentTranscriptTab';
import { TodoCardsTab } from './TodoCardsTab';
import { TaskBoardTab } from './TaskBoardTab';
import { BgTasksTab, MemoryTab } from './InsightTabs';
import { WebTab } from './WebTab';
import type { SingletonProbe, TabTypeId, TabParams } from './tab-state';
import type { MutableRefObject } from 'react';

/** G14.114 标签条/标题行文件名化:取路径末段(win/posix 双分隔,滤空段防尾分隔符) */
const baseName = (p: string): string =>
  p
    .split(/[\\/]/)
    .filter((s) => s.length > 0)
    .pop() ?? p;

export interface TabServices {
  // App 投影面(G8a:任务标签消费;后续批次按需扩)
  readonly board: import('../projection').TaskBoardState;
  readonly delegations: readonly import('../projection').Delegation[];
  readonly team: readonly { name: string; busy: boolean }[];
  readonly onReview: (taskId: string, approved: boolean) => void;
  /** G8d 子代理活动聚合(App 态 applyAgentEvent 归约;Agents 标签只读消费) */
  readonly agentActivities: import('./agent-activity').AgentActivities;
  /** G14.137 会话待办(todo_write 上抛):任务标签「会话待办」区数据源 */
  readonly todos: import('../../../src/types').TodoItem[];
  /** G14.174 待办批次(每批 todo_write 一卡;Chat 从转录重建上抛)——「待办」页签数据面 */
  readonly todoBatches: readonly import('../pages/Chat').TodoBatch[];
  /** G14.174 关联轮次用户输入(Chat 上抛最近一条 user 行)——任务板/待办卡片头共用 */
  readonly turnGoal: string;
  /** G14.176 create_task 行点开的定位信号(App 注入;nonce 变更即滚动高亮) */
  readonly taskFocus: { ref: string; nonce: number } | null;
}

export interface TabRenderProps {
  readonly conn: import('../connection').Connection;
  readonly sessionId: string;
  readonly params: import('./tab-state').TabParams;
  readonly services: TabServices;
  /** G8b:标签实例 uid(App 渲染面单点注入——TerminalTab 记账/守卫单实例面;file/tasks 忽略) */
  readonly uid: string;
  /** G8b pty 记账读取(TerminalTab 重挂重连判据):命中 = 该标签 pty 存活未 kill,跳过
   *  openPty 直连同 ptyId(replay 恢复屏幕);App 侧读 ptyIdsRef.current */
  readonly ptyIdFor: (uid: string) => string | undefined;
  /** G8b pty 生命周期钩子:terminal 标签 openPty 落定回传(App 侧 ptyIdsRef 记账,关标签 kill) */
  readonly onPtyAllocated: (uid: string, ptyId: string) => void;
  /** G8b T7 会话内开标签面(标签体自治跳转——DirectoryTab 文件行 → openTab('file',{path});
   *  App 注入 openTabInSession,判重/单例经 tab-state 共口径;file/tasks 忽略) */
  readonly openTab: (type: TabTypeId, params?: TabParams) => void;
  /** G14.154 辅助对话带问启动(fork+开辅助标签;文件选区「在辅助对话中提问」通道) */
  readonly startSideChat?: (insert?: string) => void;
  /** G10-C6 记忆面板寻址(App 注入 openRoot;file/tasks 忽略) */
  readonly root: string;
  /** G14.29 辅助对话(App 按 sideId 注入旁路聊天 sink——App onEvent 同键路由帧;他型忽略) */
  readonly chatSinkRef?: MutableRefObject<import('../pages/Chat').ChatSink | null>;
}

export interface TabTypeEntry {
  readonly id: import('./tab-state').TabTypeId;
  readonly group: 'content' | 'session' | 'tools';
  readonly title: (params: import('./tab-state').TabParams) => string;
  readonly resolveKey: (params: import('./tab-state').TabParams) => string;
  readonly singleton: boolean;
  readonly render: (props: TabRenderProps) => JSX.Element;
  /** G8b:「+」菜单开新实例的参数铸造(缺省 undefined = 裸开,按 resolveKey 判重)——terminal
   *  用 nonce 铸唯一 uid,令同型多实例并存(每标签独立 pty);单例/判重类型无需此面 */
  readonly mintParams?: () => import('./tab-state').TabParams;
}

/** G8a 两类 + G8b terminal/directory + G8d diff/agents/web:file(按 path 判重多实例)+ diff(write 调用
 * 按 callId 判重多实例——Chat write 条目 path 钮开档,渲染面 fetchDiff 双列/404 降级)+ 目录(每
 * 会话单例,惰拉树文件行跳 file)+ tasks(每会话单例)+ agents(每会话单例——子代理活动聚合卡,
 * G8d:payload.subagent 事件流经 App applyAgentEvent 归约,services.agentActivities 注入)+
 * 终端(nonce 多实例)+ web(by url 判重多实例——裸开档 key='' 聚焦既有,标签体内输入开档) */
import { Chat } from '../pages/Chat';

export const TAB_REGISTRY: readonly TabTypeEntry[] = [
  {
    id: 'file',
    group: 'content',
    // G14.114 文件类标签只显文件名(全路径在标签体内已有:file 面包屑/diff 头)——win/posix 双分隔
    title: (params) => (params.path !== undefined ? baseName(params.path) : '文件'),
    resolveKey: (params) => params.path ?? '',
    singleton: false,
    render: (p) => (
      <Files
        conn={p.conn}
        sessionId={p.sessionId}
        initialPath={p.params.path}
        root={p.root}
        onOpenFile={(path) => p.openTab('file', { path })}
        onSideAsk={(text: string) => p.startSideChat?.(text)}
      />
    ),
  },
  {
    id: 'diff',
    group: 'content',
    // title:文件名可读优先(callId 兜底;裸开档 'Diff')——标签条/标题行同源
    title: (params) => (params.path !== undefined ? baseName(params.path) : params.callId ?? '审查'),
    // by callId 多实例:同 write 调用重开=聚焦,异 callId 并存
    resolveKey: (params) => params.callId ?? '',
    singleton: false,
    render: (p) => <DiffTab conn={p.conn} sessionId={p.sessionId} params={p.params} onOpenFile={(path) => p.openTab('file', { path })} />,
  },
  {
    id: 'directory',
    group: 'content',
    title: () => '目录',
    resolveKey: () => '',
    singleton: true,
    render: (p) => <DirectoryTab conn={p.conn} sessionId={p.sessionId} root={p.root} openTab={p.openTab} />,
  },
  {
    id: 'tasks',
    group: 'session',
    // G14.174 重定位:任务页签 → 待办(每批 todo_write 一卡的卡片流;原看板迁任务板页签)
    title: () => '待办',
    resolveKey: () => '',
    singleton: true,
    render: (p) => <TodoCardsTab batches={p.services.todoBatches} />,
  },
  {
    id: 'agents',
    group: 'session',
    // G14.174 重定位:Agents 页签 → 任务板(卡片流双卡型:任务列表|流程图,逐卡切换)
    title: () => '任务板',
    resolveKey: () => '',
    singleton: true,
    render: (p) => (
      <TaskBoardTab
        board={p.services.board}
        delegations={[...p.services.delegations]}
        turnGoal={p.services.turnGoal}
        focus={p.services.taskFocus}
        onOpenAgent={(label, agentTitle) => p.openTab('agent', { label, agentTitle })}
        onReview={p.services.onReview}
      />
    ),
  },
  {
    id: 'agent',
    group: 'session',
    // G14.164 子代理只读转录页:title=开档时定格的显示名(AgentsTab 传 agentTitle;raw label 在页头)
    title: (params) => params.agentTitle ?? params.label ?? 'agent',
    // by label 多实例:同 agent 重开=聚焦,异 agent 并存;被动入口(菜单不列)
    resolveKey: (params) => params.label ?? '',
    singleton: false,
    render: (p) => (
      <AgentTranscriptTab
        label={p.params.label ?? ''}
        activities={p.services.agentActivities[p.params.label ?? '']}
        delegations={p.services.delegations}
        board={p.services.board}
        task={p.params.task}
      />
    ),
  },
  {
    id: 'bgtasks',
    group: 'session',
    title: () => '后台任务',
    resolveKey: () => '',
    singleton: true,
    render: (p) => <BgTasksTab conn={p.conn} sessionId={p.sessionId} turnGoal={p.services.turnGoal} />,
  },
  {
    id: 'memory',
    group: 'session',
    title: () => '记忆',
    resolveKey: () => '',
    singleton: true,
    render: (p) => <MemoryTab conn={p.conn} root={p.root} />,
  },
  {
    id: 'terminal',
    group: 'tools',
    title: () => '终端',
    // nonce 即判重键:mintParams 铸唯一 → 多实例并存;无 nonce 开档 key='' 互判重(聚焦既有)
    resolveKey: (params) => params.nonce ?? '',
    singleton: false,
    mintParams: () => ({ nonce: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }),
    render: (p) => (
      <TerminalTab
        conn={p.conn}
        sessionId={p.sessionId}
        params={p.params}
        uid={p.uid}
        ptyIdFor={p.ptyIdFor}
        onPtyAllocated={p.onPtyAllocated}
      />
    ),
  },
  {
    id: 'web',
    group: 'tools',
    // title:url 优先(带参开档);裸开档 'Web'——标签条/标题行同源
    title: (params) => params.url ?? 'Web',
    // by url 多实例:同 url 重开=聚焦,异 url 并存;「+」菜单裸开 key='' 互判重(聚焦既有)
    resolveKey: (params) => params.url ?? '',
    singleton: false,
    render: (p) => <WebTab params={p.params} />,
  },
  {
    id: 'sidechat',
    group: 'session',
    // G14.29 辅助对话:fork 旁路会话绑定的完整 Chat(sideId 寻址;帧路由经 App chatSinkRef)
    title: (params) => (params.sideId !== undefined ? '辅助对话' : '辅助对话'),
    resolveKey: (params) => params.sideId ?? '',
    singleton: false,
    render: (p) =>
      p.chatSinkRef !== undefined && p.params.sideId !== undefined ? (
        // G14.30 贴地壳:窄面板内 flex 列(头部/流区滚动/composer 钉底)
        <div className="sx-sidechat">
          <Chat
            conn={p.conn}
            sessionId={p.params.sideId}
            connState="open"
            onBack={() => {}}
            sinkRef={p.chatSinkRef}
            root={p.root}
            freshView
            fixedTitle=""
            initialInsert={p.params.insert}
          />
        </div>
      ) : (
        <></>
      ),
    },
  ];

/** 查表:缺则 throw(开档/渲染面共用;新类型入表前先炸可见,不静默) */
export function tabEntry(id: TabTypeId): TabTypeEntry {
  const entry = TAB_REGISTRY.find((e) => e.id === id);
  if (entry === undefined) throw new Error(`unknown tab type: ${id}`);
  return entry;
}

/** 由 TAB_REGISTRY 装配的判重/单例探针(tab-state 的 SingletonProbe 真实现;未注册类型
 *  缺省非单例、key=''——openTab 仍按 uid 规约落 `type:`,渲染面 tabEntry 自会 throw) */
export function registryProbe(): SingletonProbe {
  return {
    isSingleton: (type) => TAB_REGISTRY.find((e) => e.id === type)?.singleton ?? false,
    resolveKey: (type, params) => TAB_REGISTRY.find((e) => e.id === type)?.resolveKey(params) ?? '',
  };
}
