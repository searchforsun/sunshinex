/**
 * G8a 标签类型注册表(task-3 简报):每类标签的五件套声明——id/group/title/resolveKey/
 * singleton/render——标签条「+」菜单、uid 判重探针(registryProbe)与 T5 标签体渲染共此一表;
 * G8b-d 增类(diff/agents/directory/terminal/web)只需在此追加条目,菜单/判重自动跟进。
 * render 直接复用既有 pages 组件(Files/Board,不改它们);T6 才接线 App——本模块零 App
 * 依赖,投影面经 TabServices 注入(T5 组装)。
 */

import { Files } from '../pages/Files';
import { Board } from '../pages/Board';
import { TerminalTab } from './TerminalTab';
import type { SingletonProbe, TabTypeId } from './tab-state';

export interface TabServices {
  // App 投影面(G8a:任务标签消费;后续批次按需扩)
  readonly board: import('../projection').TaskBoardState;
  readonly delegations: readonly import('../projection').Delegation[];
  readonly team: readonly { name: string; busy: boolean }[];
  readonly onReview: (taskId: string, approved: boolean) => void;
}

export interface TabRenderProps {
  readonly conn: import('../connection').Connection;
  readonly sessionId: string;
  readonly params: import('./tab-state').TabParams;
  readonly services: TabServices;
  /** G8b:标签实例 uid(App 渲染面单点注入——TerminalTab 记账/守卫单实例面;file/tasks 忽略) */
  readonly uid: string;
  /** G8b pty 生命周期钩子:terminal 标签 openPty 落定回传(App 侧 ptyIdsRef 记账,关标签 kill) */
  readonly onPtyAllocated: (uid: string, ptyId: string) => void;
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

/** G8a 两类 + G8b terminal:file(按 path 判重多实例)+ tasks(每会话单例)+ 终端(nonce 多实例) */
export const TAB_REGISTRY: readonly TabTypeEntry[] = [
  {
    id: 'file',
    group: 'content',
    title: (params) => params.path ?? '文件',
    resolveKey: (params) => params.path ?? '',
    singleton: false,
    render: (p) => <Files conn={p.conn} sessionId={p.sessionId} initialPath={p.params.path} />,
  },
  {
    id: 'tasks',
    group: 'session',
    title: () => '任务',
    resolveKey: () => '',
    singleton: true,
    render: (p) => (
      <Board
        board={p.services.board}
        // 既有 Board 收可变数组而 TabServices 按简报签名为 readonly——浅拷贝桥接(pages 不改)
        delegations={[...p.services.delegations]}
        team={[...p.services.team]}
        onReview={p.services.onReview}
      />
    ),
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
      <TerminalTab conn={p.conn} sessionId={p.sessionId} params={p.params} uid={p.uid} onPtyAllocated={p.onPtyAllocated} />
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
