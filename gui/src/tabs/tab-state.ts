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

import { pathBasename, pathSegments } from '../ui-util';

/** 标签类型 id(注册表键;G8a 注册 file/tasks,其余类型后续批次入表) */
export type TabTypeId = 'file' | 'diff' | 'tasks' | 'agents' | 'agent' | 'directory' | 'terminal' | 'web' | 'context' | 'bgtasks' | 'memory' | 'sidechat';

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
  /** G14.29 辅助对话:fork 旁路会话 id(sidechat 标签寻址;同一辅助会话重开=聚焦) */
  readonly sideId?: string;
  /** G14.154 辅助对话首问(文件选区「在辅助对话中提问」携带,挂载即落输入框) */
  readonly insert?: string;
  /** G14.164 子智能体只读标签:payload.subagent 标签(委派行/工具行点开;同 agent 重开=聚焦) */
  readonly label?: string;
  /** G14.164 开档时定格的 agent 显示名(开档面解析齐备即带——任务板 assignee/title 命中或原始 label;标签条标题用) */
  readonly agentTitle?: string;
  /** G14.175 子智能体的用户输入(任务内容):spawn 行带 prompt、看板行带任务标题——无活动流时的正文兜底 */
  readonly task?: string;
  /** G14.2xx web 页名回写(WebTab onLoad 取 document.title;标签条标题派生 title() 优先消费) */
  readonly pageTitle?: string;
  /** G14.2xx 终端 pty 定址(分配即落参数,随 gui-state 落盘)——刷新后凭此直连旧 pty
   *  (replay 环缓冲重建屏幕);pty 已死(daemon 重启/超时)由 TerminalTab 一次性回退新开 */
  readonly ptyId?: string;
}

/** 标签实例:uid 为全会话唯一键(params 快照开档时定格,判重靠 uid 而非深比较)。
 *  createdAt=G14.2xx 标签搜索弹窗相对时间面(开档时刻;无兼容旧档——盘档缺值落 0,时间面留空) */
export interface TabInstance {
  readonly uid: string;
  readonly type: TabTypeId;
  readonly params: TabParams;
  readonly createdAt: number;
}

/** G14.2xx 最近关闭记录(标签搜索弹窗「最近关闭的标签页」数据源):type/params 供重开,
 *  closedAt 供相对时间,createdAt 沿带(重开后时间面连续) */
export interface ClosedTab {
  readonly type: TabTypeId;
  readonly params: TabParams;
  readonly closedAt: number;
  readonly createdAt: number;
}

/** 单会话标签态:tabs 行序即标签条渲染序;width 只钳最小 440,无上限(clamp 于 setWidth;
 * G14.183 最小列宽=主对话/侧栏共用;G14.2xx 用户裁定:最大宽限制退役——三栏均只留最小宽钳制)。
 * recentClosed=最近关闭历史(新者在前,cap 10——closeTab 单点维护,reopenLastClosed 消费) */
export interface TabSessionState {
  readonly tabs: readonly TabInstance[];
  readonly activeUid: string | null;
  readonly collapsed: boolean;
  readonly width: number;
  readonly recentClosed: readonly ClosedTab[];
}

/** 多会话标签态总表:key = sessionId;会话间互不可见(切会话各持各的) */
export type TabStates = Readonly<Record<string, TabSessionState>>;

/** 右栏缺省宽(双列 Diff 可读;spec §1) */
export const DEFAULT_TAB_WIDTH = 520;

/** 拖拽调宽边界:只钳最小(spec §1 旧 200-720 上界退役;G14.2xx 用户裁定:三栏只留最小宽
 *  钳制,右栏可任意拖宽)——模块私有,setWidth 单点执行 */
const MIN_TAB_WIDTH = 208; // 2026-10-24 用户裁定 440→240→208 再收窄:搜索弹窗(280+视口钳制)不截断;页签条窄端页签逐个滚动

/**
 * 判重/单例探针:T3 的 TAB_REGISTRY 装配真实现(registryProbe),测试桩同口径注入。
 * resolveKey(type, params) = 同目标判别键(file 按 path / diff 按 callId / web 按 url /
 * 单例与无参类型恒 '');isSingleton(type) = 该类型每会话单份。
 */
export interface SingletonProbe {
  isSingleton(type: TabTypeId): boolean;
  resolveKey(type: TabTypeId, params: TabParams): string;
}

/** 空会话缺省面:无标签、无活动、不折叠、缺省宽、关闭历史空 */
export function emptyTabSession(): TabSessionState {
  return { tabs: [], activeUid: null, collapsed: true, width: DEFAULT_TAB_WIDTH, recentClosed: [] };
}

/** uid 规约单点:type + ':' + resolveKey(无参 key='' → 'tasks:') */
const tabUid = (type: TabTypeId, params: TabParams, probe: SingletonProbe): string =>
  `${type}:${probe.resolveKey(type, params)}`;

/**
 * 会话在席保障:无该会话 → 建空态(零标签——G14.27 用户裁定:不再默认开『任务』页,右栏
 * 空态显示推荐项卡片);已有 → 原引用返回(未动即未变,测试以 toBe 断言)。
 */
// _registry 预留接缝:单例在席探针(当前无消费面,签名保形——App/tab-strip 调用点零迁移)
export function ensureSession(states: TabStates, sessionId: string, _registry: SingletonProbe): TabStates {
  if (states[sessionId] !== undefined) return states;
  return { ...states, [sessionId]: emptyTabSession() };
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
  // G14.2xx 判重改按「当前判重键」扫描(uid 是开档时定格的实例 id,params 演进后即陈旧):
  // web 页内导航回写 url/页名后,同 url 开档仍聚焦、裸开档新立=浏览器多标签语义;file/diff/
  // terminal 等键即 uid 尾段且 params 不演进,行为与原 uid 判重一致
  const key = probe.resolveKey(type, params);
  const byKey = cur.tabs.find((t) => t.type === type && probe.resolveKey(type, t.params) === key);
  if (byKey !== undefined) {
    // 命中既有标签 → 聚焦并更新 params(diff 标签 path 载荷联动:点对话文件行
    // 自动展开对应项——同 key(changes 视图)参数刷新,不重开新档)
    return {
      ...states,
      [sessionId]: {
        ...cur,
        activeUid: byKey.uid,
        tabs: cur.tabs.map((t) => (t.uid === byKey.uid ? { ...t, params } : t)),
      },
    };
  }
  if (probe.isSingleton(type)) {
    const byType = cur.tabs.find((t) => t.type === type);
    if (byType !== undefined) return { ...states, [sessionId]: { ...cur, activeUid: byType.uid } };
  }
  // uid minting 防撞:导航回写不 rekey(uid 恒稳=React key/pty 记账稳定),但同键开档被上方
  // 判重收编后仍可能撞(如裸 web 档已导航,再裸开新档同得 'web:')——尾加序号保唯一
  let uid = tabUid(type, params, probe);
  if (cur.tabs.some((t) => t.uid === uid)) {
    let i = 2;
    while (cur.tabs.some((t) => t.uid === `${uid}~${i}`)) i++;
    uid = `${uid}~${i}`;
  }
  const tab: TabInstance = { uid, type, params, createdAt: Date.now() };
  return { ...states, [sessionId]: { ...cur, tabs: [...cur.tabs, tab], activeUid: uid } };
}

/** 最近关闭历史深度(新者在前;超出截尾——chrome 同量级) */
const RECENT_CLOSED_CAP = 10;

/**
 * 关标签:关活动 → 承继位取删后 min(关闭索引, tabs.length-1)(=右邻优先、无右取左;
 * 清空 → null);关非活动 → 活动不变。uid 不在席/会话缺席 → 原引用返回(未动)。
 * G14.2xx:被关标签压入 recentClosed 头部(最近关闭弹窗数据源;cap 截尾)。
 */
export function closeTab(states: TabStates, sessionId: string, uid: string): TabStates {
  const cur = states[sessionId];
  if (cur === undefined) return states;
  const idx = cur.tabs.findIndex((t) => t.uid === uid);
  if (idx < 0) return states;
  const victim = cur.tabs[idx]!;
  const tabs = cur.tabs.filter((_, i) => i !== idx);
  const activeUid =
    cur.activeUid === uid ? (tabs.length === 0 ? null : tabs[Math.min(idx, tabs.length - 1)].uid) : cur.activeUid;
  const closed: ClosedTab = { type: victim.type, params: victim.params, closedAt: Date.now(), createdAt: victim.createdAt };
  const recentClosed = [closed, ...cur.recentClosed].slice(0, RECENT_CLOSED_CAP);
  return { ...states, [sessionId]: { ...cur, tabs, activeUid, recentClosed } };
}

/** G14.111 拖拽重排:fromUid 标签移到 toUid 所在位(数组 splice 对调,活动位不变——
 *  拖拽重排不改活动标签;uid 缺席/相同/会话缺席 → 原引用返回) */export function reorderTab(states: TabStates, sessionId: string, fromUid: string, toUid: string): TabStates {
  const cur = states[sessionId];
  if (cur === undefined) return states;
  const from = cur.tabs.findIndex((t) => t.uid === fromUid);
  const to = cur.tabs.findIndex((t) => t.uid === toUid);
  if (from < 0 || to < 0 || from === to) return states;
  const tabs = [...cur.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  return { ...states, [sessionId]: { ...cur, tabs } };
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

/** G14.2xx web 标签元数据回写(浏览器原生标签形):页内导航/取到页名后合并进 params——
 *  标签条标题(title() 派生)与判重键(resolveKey=url)随页演进,同一标签换页不换 uid。
 *  会话/标签缺席或 url+pageTitle 均未变 → 原引用返回 */
export function patchTabMeta(
  states: TabStates,
  sessionId: string,
  uid: string,
  patch: { url?: string; pageTitle?: string; ptyId?: string },
): TabStates {
  const cur = states[sessionId];
  const target = cur?.tabs.find((t) => t.uid === uid);
  if (cur === undefined || target === undefined) return states;
  const params: TabParams = { ...target.params, ...patch };
  if (target.params.url === params.url && target.params.pageTitle === params.pageTitle && target.params.ptyId === params.ptyId) return states;
  return { ...states, [sessionId]: { ...cur, tabs: cur.tabs.map((t) => (t.uid === uid ? { ...t, params } : t)) } };
}

/** 调宽:只钳最小 440(无最大宽——G14.2xx 用户裁定);钳后未变/会话缺席 → 原引用返回 */
export function setWidth(states: TabStates, sessionId: string, width: number): TabStates {
  const cur = states[sessionId];
  if (cur === undefined) return states;
  const clamped = Math.max(MIN_TAB_WIDTH, width);
  if (cur.width === clamped) return states;
  return { ...states, [sessionId]: { ...cur, width: clamped } };
}

/** G14.2xx 同名标签消歧(用户裁定):file 标签按末段名分组,组内撞名时逐级上溯路径段构成
 *  **最小区分相对路径**(chrome 同位)——`src/a/util.ts` 与 `src/b/util.ts` 显 `a/util.ts`/`b/util.ts`;
 *  无撞名保持原题。返回 uid → 显示题(非 file 标签不在表中,消费面回落 registry 原题) */
export function disambiguateTabTitles(tabs: readonly TabInstance[]): Map<string, string> {
  // 末段名与 registry.title 同源(pathBasename 双分隔符口径——模型写入路径可能带 win32 盘符,POSIX-only 切分会整径当末段)
  const out = new Map<string, string>();
  const groups = new Map<string, TabInstance[]>();
  for (const t of tabs) {
    if (t.type !== 'file' || t.params.path === undefined) continue;
    const base = pathBasename(t.params.path);
    out.set(t.uid, base);
    const g = groups.get(base);
    if (g === undefined) groups.set(base, [t]);
    else g.push(t);
  }
  for (const [base, g] of groups) {
    if (g.length <= 1) continue;
    const segLists = g.map((t) => ({ t, segs: pathSegments(t.params.path ?? '') }));
    const maxDepth = Math.max(...segLists.map((s) => s.segs.length));
    const labels = new Map<string, string>();
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const counts = new Map<string, number>();
      for (const s of segLists) {
        if (labels.has(s.t.uid)) continue; // 已在浅层唯一:不再上溯
        const label = s.segs.slice(-depth).join('/');
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      if (counts.size === 0) break;
      for (const [label, n] of counts) {
        if (n !== 1) continue;
        const hit = segLists.find((s) => !labels.has(s.t.uid) && s.segs.slice(-depth).join('/') === label);
        if (hit !== undefined) labels.set(hit.t.uid, label);
      }
      if (labels.size === g.length) break;
    }
    for (const s of segLists) out.set(s.t.uid, labels.get(s.t.uid) ?? base);
  }
  return out;
}

/** G14.2xx 重开最近关闭(标签搜索弹窗「最近关闭」行点击,按行索引):弹出该记录按常规
 *  openTab 重开(判重/单例同口径——重开同文件=聚焦既有),记录随弹随消;索引越界/会话
 *  缺席 → 原引用返回 */
export function reopenClosed(states: TabStates, sessionId: string, index: number, probe: SingletonProbe): TabStates {
  const cur = states[sessionId];
  const top = cur?.recentClosed[index];
  if (cur === undefined || top === undefined) return states;
  const recentClosed = cur.recentClosed.filter((_, i) => i !== index);
  return openTab({ ...states, [sessionId]: { ...cur, recentClosed } }, sessionId, top.type, top.params, probe);
}

const TAB_TYPES: ReadonlySet<string> = new Set<string>([
  'file', 'diff', 'tasks', 'agents', 'agent', 'directory', 'terminal', 'web', 'context', 'bgtasks', 'memory', 'sidechat',
]);

/** G14.2xx 盘档消毒(gui/sessions/<会话id>.json → TabSessionState):盘为真相源,但坏键/越型
 *  一律弃——未知 type 的标签、非串 uid、activeUid 不在 tabs 全部滤除;字段缺省回落
 *  emptyTabSession 口径(折叠缺省 true=G14.38,宽缺省 DEFAULT_TAB_WIDTH)。非对象/null → null */
export function parseTabSession(raw: unknown): TabSessionState | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const tabs: TabInstance[] = [];
  if (Array.isArray(o.tabs)) {
    for (const t of o.tabs) {
      if (t === null || typeof t !== 'object') continue;
      const e = t as Record<string, unknown>;
      if (typeof e.uid !== 'string' || e.uid === '') continue;
      if (typeof e.type !== 'string' || !TAB_TYPES.has(e.type)) continue;
      const params = (typeof e.params === 'object' && e.params !== null && !Array.isArray(e.params) ? e.params : {}) as TabParams;
      tabs.push({ uid: e.uid, type: e.type as TabTypeId, params, createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0 });
    }
  }
  const recentClosed: ClosedTab[] = [];
  if (Array.isArray(o.recentClosed)) {
    for (const c of o.recentClosed) {
      if (c === null || typeof c !== 'object') continue;
      const e = c as Record<string, unknown>;
      if (typeof e.type !== 'string' || !TAB_TYPES.has(e.type)) continue;
      const params = (typeof e.params === 'object' && e.params !== null && !Array.isArray(e.params) ? e.params : {}) as TabParams;
      recentClosed.push({
        type: e.type as TabTypeId,
        params,
        closedAt: typeof e.closedAt === 'number' ? e.closedAt : 0, // 0=未知时刻(时间面留空)
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
      });
    }
  }
  const activeUid = typeof o.activeUid === 'string' && tabs.some((t) => t.uid === o.activeUid)
    ? o.activeUid
    : tabs[0]?.uid ?? null;
  const width = typeof o.width === 'number' && o.width >= MIN_TAB_WIDTH ? o.width : DEFAULT_TAB_WIDTH;
  return { tabs, activeUid, collapsed: o.collapsed === true, width, recentClosed };
}
