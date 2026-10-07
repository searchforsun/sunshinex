/**
 * G8a 标签框架纯状态层(spec §1 标签模型 / task-2 简报):每会话独立的标签会话态 +
 * 开/关/切换/判重/单例/折叠/宽度钳制的纯函数族——零 React 依赖;T3(标签条)与
 * T5(App 壳)以 `setTab(s => fn(s, sessionId, ...))` 消费,StrictMode 会双调
 * updater,故全部不可变更新、无任何写透(同态引用在无变化时原样返回)。
 *
 * uid 规约:`type + ':' + resolveKey(type, params)`(无参标签 key='' → uid='tasks:')。
 * 判重/单例口径由 SingletonProbe 注入(T3 registry 提供真实现):resolveKey 相同 =
 * 同目标(重开=聚焦既有);isSingleton(type) = 该类型每会话单份(tasks/agents/directory)。
 * 行序:openTab 追加居末(最新在最右,与标签条末端「+」钮连贯,spec §1 草图);
 * 切换 cycleTab 活动位 ±1 环回(计划作者裁定口径,测试 #6 为链式断言)。
 */

/** 标签类型 id(注册表键;G8a 注册 file/tasks,其余类型后续批次入表) */
export type TabTypeId = 'file' | 'diff' | 'tasks' | 'agents' | 'directory' | 'terminal' | 'web';

/** 开标签目标参数(按类型取用:file=diff=目录用 path、diff 备选 callId、web=url、终端 cols/rows) */
export interface TabParams {
  readonly path?: string;
  readonly callId?: string;
  readonly url?: string;
  readonly cols?: number;
  readonly rows?: number;
  /** G8b 终端多实例铸键:「+」菜单每次开铸唯一 nonce(mintParams)→ resolveKey 各异 →
   *  同型并存(每标签独立 pty);无 nonce 开档互判重(聚焦既有) */
  readonly nonce?: string;
}

/** 标签实例:uid 为全会话唯一键(params 快照开档时定格,判重靠 uid 而非深比较) */
export interface TabInstance {
  readonly uid: string;
  readonly type: TabTypeId;
  readonly params: TabParams;
}

/** 单会话标签态:tabs 行序即标签条渲染序;width 200..720(clamp 于 setWidth) */
export interface TabSessionState {
  readonly tabs: readonly TabInstance[];
  readonly activeUid: string | null;
  readonly collapsed: boolean;
  readonly width: number;
}

/** 多会话标签态总表:key = sessionId;会话间互不可见(切会话各持各的) */
export type TabStates = Readonly<Record<string, TabSessionState>>;

/** 右栏缺省宽(双列 Diff 可读;spec §1) */
export const DEFAULT_TAB_WIDTH = 420;

/** 拖拽调宽边界(spec §1:200-720px clamp)——模块私有,setWidth 单点执行 */
const MIN_TAB_WIDTH = 200;
const MAX_TAB_WIDTH = 720;

/**
 * 判重/单例探针:T3 的 TAB_REGISTRY 装配真实现(registryProbe),测试桩同口径注入。
 * resolveKey(type, params) = 同目标判别键(file 按 path / diff 按 callId / web 按 url /
 * 单例与无参类型恒 '');isSingleton(type) = 该类型每会话单份。
 */
export interface SingletonProbe {
  isSingleton(type: TabTypeId): boolean;
  resolveKey(type: TabTypeId, params: TabParams): string;
}

/** 空会话缺省面:无标签、无活动、不折叠、缺省宽 */
export function emptyTabSession(): TabSessionState {
  return { tabs: [], activeUid: null, collapsed: false, width: DEFAULT_TAB_WIDTH };
}

/** uid 规约单点:type + ':' + resolveKey(无参 key='' → 'tasks:') */
const tabUid = (type: TabTypeId, params: TabParams, probe: SingletonProbe): string =>
  `${type}:${probe.resolveKey(type, params)}`;

/**
 * 会话在席保障:无该会话 → 建空态并按探针缺省开 tasks 单例页(spec §1「新会话默认开
 * 『任务』一页」;tasks 未注册单例时留空态);已有 → 原引用返回(未动即未变,
 * 测试以 toBe 断言)。注意走 openTab 而非直拼,令缺省页同样过 uid 规约与置活动口径。
 */
export function ensureSession(states: TabStates, sessionId: string, registry: SingletonProbe): TabStates {
  if (states[sessionId] !== undefined) return states;
  const seeded: TabStates = { ...states, [sessionId]: emptyTabSession() };
  return registry.isSingleton('tasks') ? openTab(seeded, sessionId, 'tasks', {}, registry) : seeded;
}

/**
 * 开标签(判重优先):① resolveKey 同 uid 的既有标签 → 仅置活动(重开同文件/同 Diff/
 * 同 URL=聚焦不重复);② 单例类型 → 既有同类型标签置活动;③ 否则**追加**新
 * TabInstance 居末置活动(最新在最右,与标签条末端「+」钮连贯,spec §1)。会话缺席时
 * 先落空态再开(防御:消费面恒先 ensureSession,此分支仅为不炸)。
 */
export function openTab(
  states: TabStates,
  sessionId: string,
  type: TabTypeId,
  params: TabParams,
  probe: SingletonProbe,
): TabStates {
  const cur = states[sessionId] ?? emptyTabSession();
  const uid = tabUid(type, params, probe);
  const byUid = cur.tabs.find((t) => t.uid === uid);
  if (byUid !== undefined) return { ...states, [sessionId]: { ...cur, activeUid: byUid.uid } };
  if (probe.isSingleton(type)) {
    const byType = cur.tabs.find((t) => t.type === type);
    if (byType !== undefined) return { ...states, [sessionId]: { ...cur, activeUid: byType.uid } };
  }
  const tab: TabInstance = { uid, type, params };
  return { ...states, [sessionId]: { ...cur, tabs: [...cur.tabs, tab], activeUid: uid } };
}

/**
 * 关标签:关活动 → 承继位取删后 min(关闭索引, tabs.length-1)(=右邻优先、无右取左;
 * 清空 → null);关非活动 → 活动不变。uid 不在席/会话缺席 → 原引用返回(未动)。
 */
export function closeTab(states: TabStates, sessionId: string, uid: string): TabStates {
  const cur = states[sessionId];
  if (cur === undefined) return states;
  const idx = cur.tabs.findIndex((t) => t.uid === uid);
  if (idx < 0) return states;
  const tabs = cur.tabs.filter((_, i) => i !== idx);
  const activeUid =
    cur.activeUid === uid ? (tabs.length === 0 ? null : tabs[Math.min(idx, tabs.length - 1)].uid) : cur.activeUid;
  return { ...states, [sessionId]: { ...cur, tabs, activeUid } };
}

/** 置活动:uid 在席才落(活动位恒指向存在标签的不变式);否则原引用返回 */
export function setActive(states: TabStates, sessionId: string, uid: string): TabStates {
  const cur = states[sessionId];
  if (cur === undefined || !cur.tabs.some((t) => t.uid === uid) || cur.activeUid === uid) return states;
  return { ...states, [sessionId]: { ...cur, activeUid: uid } };
}

/**
 * 切换标签(Ctrl+Alt+→/←):活动位 ±1 **环回**((idx+dir+len)%len——末位 +1 回首位、
 * 首位 -1 回末位);tabs 空/单标签/无活动位不动(原引用返回)。
 */
export function cycleTab(states: TabStates, sessionId: string, dir: 1 | -1): TabStates {
  const cur = states[sessionId];
  if (cur === undefined || cur.tabs.length < 2) return states;
  const idx = cur.tabs.findIndex((t) => t.uid === cur.activeUid);
  if (idx < 0) return states;
  const next = (idx + dir + cur.tabs.length) % cur.tabs.length;
  return { ...states, [sessionId]: { ...cur, activeUid: cur.tabs[next].uid } };
}

/** 折叠右栏:值未变/会话缺席 → 原引用返回 */
export function setCollapsed(states: TabStates, sessionId: string, collapsed: boolean): TabStates {
  const cur = states[sessionId];
  if (cur === undefined || cur.collapsed === collapsed) return states;
  return { ...states, [sessionId]: { ...cur, collapsed } };
}

/** 调宽:clamp 200..720(拖拽边条越界钳回);钳后未变/会话缺席 → 原引用返回 */
export function setWidth(states: TabStates, sessionId: string, width: number): TabStates {
  const cur = states[sessionId];
  if (cur === undefined) return states;
  const clamped = Math.min(MAX_TAB_WIDTH, Math.max(MIN_TAB_WIDTH, width));
  if (cur.width === clamped) return states;
  return { ...states, [sessionId]: { ...cur, width: clamped } };
}
