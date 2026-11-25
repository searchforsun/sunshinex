import type { RewindOps } from './chat-types';
import type { ComposerEnv } from './edit-composer';
import type { MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode } from 'react';
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { t } from '../../i18n';
import type { Connection } from '../../connection';
import { fmtTokens as fmtTokensShared } from '../../ui-util';
import { groupEntriesByDay } from '../../chat-groups';
import type { ChatEntry } from '../../chat-reducer';
import { isOfficeHiddenNotice, useUiMode } from '../../ui-mode';
import { SunxMark } from '../../sunx-icon';
import { WelcomeLogo } from '../../welcome/welcome-logo';
import { platformMeta } from '../../sidebar/use-menu-channels';
import { useUsageStats } from '../../usage-stats';
import { dayUnitSpans, firstUnitAt, prefixOffsets, reuseUnchangedSpans, sliceRange, unitEstimate } from './transcript-units';
import { rememberUnitHeight, unitHeightsFor } from './unit-heights';
import { peekScrollAnchor } from './scroll-mem';
import type { UnitSpan } from './transcript-units';
function fmtTokens(n: number): string {
  return fmtTokensShared(n);
}

/** D48 尾部窗口:会话流只全量渲染尾部窗口条目,更早条目折叠为头部「显示更早」行渐进回放
 *  (对齐主仓 TUI tail-rewrite 上限口径;立项与切点回退设计见 docs/superpowers/plans/
 *  2026-10-23-messagelist-tail-window.md) */
const RENDER_WINDOW_DEFAULT = 80; // 2026-11-13 用户裁定「切会话不要卡,先进视口再平滑补齐」:入口窗口缩到视口级
// (原 600 条整表同步渲染=重会话进入即长帧),余量由下方空闲分批回放逐批补齐,上限不变
const RENDER_WINDOW_STEP = 300; // 手动回放步进(「显示更早」钮/滚顶回放,用户显式动作取大批)
// 空闲回放步进(2026-11-13:批小让主线程,交互可抢占;上限仍 600)。2026-11-17 用户实测
// 「回放速度快一些,跨度小一些」:60→24 缩跨度(单批挂载量≈1/2.5),调度 timeout 500→150、
// setTimeout 兜底 64→32 提频——总填速反升(24 行/150ms≈160 行/s > 60 行/500ms),视觉由
// 大块跳变变平滑渐进
const RENDER_WINDOW_IDLE_STEP = 24;
export const RENDER_WINDOW_MAX = 600; // 空闲回放天花板(沿旧入口窗口预算);超出部分仍走手动/滚顶回放
/** 虚拟窗口旁路闸(2026-11-18 结构性改造):jsdom 无布局(clientHeight=0 / gBCR 全零),切片模型
 *  无从测量——整窗逐块直渲,测试面语义与旧实现一致;真浏览器(Chromium/Electron)走虚拟窗口 */
const LAYOUT_FREE = typeof window !== 'undefined' && typeof window.navigator !== 'undefined' && /jsdom/i.test(window.navigator.userAgent);
/** 视口上下各多挂一屏内容(滚动提前就位,避免白块;估算误差由实测回钉吸收) */
const VIRTUAL_OVERSCAN = 900;
/** 切片滞回安全边(2026-11-19 快速滑动轮):视口离已挂载覆盖区边界还剩这么多 px 时不重算切片 */
const RANGE_EDGE_MARGIN = 240;
import { ChatEntryView, CommandEntryView, isCommandEntry, RunEntryView, ThinkingEntryView, UserEntryView } from './EntryViews';
import { ToolEntryView } from './ToolEntry';
import { ToolSegBlock } from './ToolGroups';
import { ChatRail } from './ChatRail';
import { isMidRunInsert } from './use-chat-fold';

/** 会话流列表(D32 第六批批F-3 自 Chat.tsx 平移):空态/按日分组/段折叠聚合
 *  (ToolSegBlock)/run·user·assistant 行派发/运行状态行。滚动容器 ref 与贴底旁路 ref 留宿主
 *  (归底 effects 消费),onScroll 存档逻辑留宿主经 props 注入;P11 T7 起 tool 行全走 entry
 *  字段(callIdOf 寻址注入保留,info 旁路注入退役)。 */
export interface MessageListProps {
  readonly entries: ChatEntry[];
  /** P1 派生冻结键(chat.structureVersion/seedGen 直穿):日分组骨架 memo 依赖,见组件内 daySkeleton */
  readonly structureVersion: number;
  readonly seedGen: number;
  readonly hiddenKeys: ReadonlySet<string>;
  readonly callIdOf: (entry: ChatEntry) => string | undefined;
  readonly conn: Connection;
  readonly sessionId: string;
  /** 图片落盘引用解析根(2026-10-31 images-cache 裁定;缺省=引用原样不解析) */
  readonly root?: string;
  /** 2026-11-04 待办行点击定位:打开待办页签+定位对应卡 */
  readonly onOpenTodos?: (todos: Array<{ text: string; status: string }>, title?: string) => void;
  readonly onOpenFile?: (p: string) => void;
  readonly onOpenDiff?: (callId: string, p: string) => void;
  readonly onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  readonly onOpenTask?: (ref: string) => void;
  readonly taskNameOf: (id: string) => string;
  /** 后台任务 id → 子智能体(办公模式等待行链接转录页;use-chat-derived taskAgentResolverOf) */
  readonly taskAgentOf?: (id: string) => { name: string; prompt?: string; kind?: 'exec' } | undefined;
  readonly teamNameOf?: (ref: string) => string;
  readonly teams?: readonly { teamId: string; name: string }[];
  readonly collapsedRuns: ReadonlySet<string>;
  readonly toggleRun: (key: string) => void;
  /** 编辑卡重发回调(可选,Sunx 2026-11-24 置空收编辑入口:undefined=气泡 Edit 钮不渲染) */
  readonly submitText?: (text: string, images?: string[]) => Promise<void>;
  readonly rewindOps?: RewindOps;
  readonly composerEnv?: ComposerEnv;
  readonly runFooterByEntry: ReadonlyMap<string, ChatEntry>;
  /** 会话级操作错误上抛(轮末产物卡 OpenSplit/openInEditor 错误条同通道;可选防测试桩免配) */
  readonly onOpError?: (err: unknown) => void;
  /** 轮末产物卡「产物库」链接通道(2026-11-12 spec §4;Task 12 接 App 入口——本任务纯类型面) */
  readonly onOpenArtifacts?: () => void;
  readonly onOpenWeb?: (url: string) => void;
  readonly onRunInTerminal?: (command: string) => void;
  readonly onEntryOpenDiff: (p: string) => void;
  readonly onEntryRestore: (p: string) => void;
  /** 轮次 checkpoint 通道(2026-11-10):改动条文件名开本轮 diff 页签 / 前像回写撤销 */
  readonly onOpenTurn?: (run: number, path: string) => void;
  readonly onTurnRestore?: (run: number, paths: string[]) => Promise<Array<{ path: string; ok: boolean; stale?: boolean; noCheckpoint?: boolean }>>;
  readonly onFork?: (runKey: string) => void;
  /** fork 分界横幅回父会话(横幅=合成 notice 条目由 ChatEntryView 专支渲染) */
  readonly onOpenSession?: (sessionId: string) => void;
  readonly onEntryToggleClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** 2026-10-26 图片功能(并行):气泡图片条点击 → lightbox(App 持 src 态) */
  readonly onOpenImage?: (src: string) => void;
  readonly chatScrollRef: MutableRefObject<HTMLElement | null>;
  readonly onScroll: (e: { currentTarget: HTMLElement }) => void;
  readonly onWheel: (e: { deltaY: number }) => void;
  /** G14.2xx 辅助对话空态文案(sidechat 页签) */
  readonly sideChat?: boolean;
  /** sunx 会话显示名(sunx P2 2026-11-15):在场=空态欢迎语走 Sunx 分支(编排者口径,无技术细节) */
  readonly sunxName?: string;
  /** 通道域会话(2026-11-22 用户裁定「新会话提示改回欢迎页样式,图标随应用」):true=空态走
   *  通道 hero 分支(平台大图标+「新会话」)——journalId 命中绑定档由 Chat 层钩子判定 */
  readonly channelChat?: boolean;
  /** 通道平台(2026-11-22 用户裁定「不同应用不同图标」):空态大图标随应用;缺席=中性通道形 */
  readonly channelPlatform?: string;
  /** 后台补齐目标(2026-11-17 实测卡顿根修):Chat 自 chatMem 注入上次展开宽度——**不是首帧窗口**
   *  (首帧恒入口窗 80,免同步重建整段历史的长帧),而是空闲 pump 的爬升上限;缺省=600 预暖
   *  (冷会话平滑补齐口径不变)。仅挂载读一次(Memo 比较器不列) */
  readonly initialRenderWindow?: number;
  /** 窗口变更上抛(Chat 收 ref 镜像,卸载随 chatMem 写回缓存):回放/手动步进每拍上报。
   *  Chat 侧 useCallback 恒稳,memo 比较器不列 */
  readonly onRenderWindowChange?: (n: number) => void;
  /** 贴底闩镜像(Chat 持有):false=用户在上方阅读态——窗口顶冻结(见 cut 计算处),流式追加
   *  不再推走正在读的行。缺省=贴底语义(测试桩/降级面) */
  readonly chatStickRef?: MutableRefObject<boolean>;
  /** 前台态(2026-11-18 keep-alive):false=隐藏驻留座——空闲补齐 pump 停止(否则后台白挂条目,
   *  与前台滚动抢主线程=「正文滑动卡顿/一会划不动」),切回再续 */
  readonly active?: boolean;
  /** 虚拟窗口锚式恢复位(2026-11-18):块 key + 块顶相对视口偏移(负值)。与 Chat 的距底存档互斥
   *  接管(有锚=skipRestore);只读一次,应用后忽略 */
  readonly restoreAnchor?: { key: string; off: number };
  /** 高度表归档作用域(会话档键,同滚动存档):重挂命中上次实测高度,滚动条/恢复一次到位 */
  readonly heightScope?: string;
  readonly running: boolean;
  readonly liveSteps: number;
  readonly liveTokens: number;
}

/** 虚拟块视图(2026-11-19 滑动去重渲):滚动期 unit 对象与 renderUnit 回调恒稳(useCallback),
 *  React.memo 让已挂载块整段 bail-out——旧实现每次切片换界都重调全部块的 renderUnit,块内
 *  ToolSegBlock/Markdown 元素全量重建;模型/折叠/流式换新回调时照常重渲(身份判等) */
const UnitView = memo(function UnitView({ unit, render, unitRef, claimEnter }: {
  unit: UnitSpan;
  render: (u: UnitSpan) => ReactNode;
  unitRef: (el: HTMLDivElement | null) => void;
  /** 入场认领(2026-11-25):只在**本实例挂载**时问一次,结果存进 state——切片换界重挂的块
   *  已在宿主登记,认领返回 false 不重放动画;同一实例后续重渲沿用初值,属性不掉、动画不被
   *  流式更新打断(旧实现把判定放在 render 期且见了命中就回 true,重挂会重放) */
  claimEnter: (key: string) => boolean;
}): JSX.Element {
  const [enter] = useState(() => claimEnter(unit.key));
  return (
    <div className="chat-unit" data-unit-key={unit.key} data-enter={enter ? '' : undefined} ref={unitRef}>
      {render(unit)}
    </div>
  );
});

/** 通道会话空态(2026-11-22 用户裁定「改回欢迎页样式,图标随应用」):平台大图标占 logo 位,
 *  标语=新会话;首条消息后生成会话名,侧栏标题随之归位 */
function ChannelEmpty({ platform }: { platform?: string }): JSX.Element {
  const ChannelIcon = platformMeta(platform).Icon;
  return (
    <div className="chat-empty chat-empty-welcome chat-empty-channel" aria-label="chat empty">
      <ChannelIcon size={72} strokeWidth={1.25} className="chat-empty-mark" />
      <h1 className="welcome-tagline">{t('New session', '新会话')}</h1>
    </div>
  );
}

/** 会话流列表(2026-11-18 结构:虚拟窗口)——窗口内条目经 dayUnitSpans 切成「块」,只挂视口
 *  ±overscan 的块,上下 spacer 占位;块高实测表 + 前缀和,阅读位按块坐标锚定。jsdom(无布局)
 *  旁路为整窗逐块直渲(回退 DOM=旧 DayGroupBlock 拼接结果,测试面语义不变)。 */
export function MessageList(props: MessageListProps): JSX.Element {
  const usageOn = useUsageStats(); // 用量统计开关(2026-11-14):关=运行状态行隐步数+tokens
  // P1 回调稳定化:宿主回调面(callIdOf/onOpen*/taskNameOf/toggleRun/submitText/onEntry*/onFork)
  // 经 propsRef 取用(见下方稳定化块),解构只留渲染直读面
  const { entries, structureVersion, seedGen, hiddenKeys, conn, sessionId, root, collapsedRuns, runFooterByEntry, onEntryToggleClick, chatScrollRef, onScroll, onWheel, running, liveSteps, liveTokens, sideChat, sunxName, channelChat, channelPlatform, onOpenImage, onOpenWeb } = props;
  /** D48 尾部窗口:窗口外更早条目折叠为头部「显示更早」行;切点回退见下方。
   *  初值恒为入口窗(视口级)——2026-11-17 用户实测「切回会话仍卡顿」量化:同步挂载 80 条
   *  富文本≈214ms、500 条≈1075ms(jsdom;插桩证实元素树缓存 100% 命中也不省,成本在 DOM
   *  挂载本身)——缓存窗口曾整段同步重建=切回长帧根因。「切回不要重分段」改由目标窗+后台补齐
   *  兑现:缓存窗仅作 pump 目标(targetRef),首帧只挂入口窗,空闲分批爬到目标(24/32ms,
   *  底部阅读态下上方增长不可见),视觉上无重新分段、首帧恒定轻 */
  const cachedWindow = Math.min(Math.max(props.initialRenderWindow ?? RENDER_WINDOW_MAX, RENDER_WINDOW_DEFAULT), RENDER_WINDOW_MAX);
  const [visibleCount, setVisibleCount] = useState(RENDER_WINDOW_DEFAULT);
  /** 窗口目标(pump 上限):挂载取缓存窗(无缓存=600 预暖,冷会话行为不变);手动/滚顶回放抬升 */
  const windowTargetRef = useRef(cachedWindow);
  /** 最近一次用户滚动时刻(空闲回放让路判据:滚动进行中不挂载更早条目) */
  const lastScrollAtRef = useRef(0);
  /** 渐进回放视口锚定(2026-11-17 元素锚重写):展开前记「视口顶缘压住的第一个内容块」,挂载后
   *  把它顶回原视口位。旧实现记 scrollHeight 差值——流式在视口下方的生长被错算进补偿,运行中
   *  用户滚到上方时每拍回放都被往下推(「时不时直接跳到底部」根因②);元素锚只补上方生长,
   *  下方增量零项。锚块丢失(流式重排换实例)即弃手动回钉交原生锚定,永不反向拖拽 */
  const expandAnchorRef = useRef<{ node: Element; top: number } | null>(null);
  const captureAnchor = (): void => {
    const el = chatScrollRef.current;
    if (el === null) {
      expandAnchorRef.current = null;
      return;
    }
    const cTop = el.getBoundingClientRect().top;
    let found: { node: Element; top: number } | null = null;
    for (const child of el.children) {
      if (child.classList.contains('sx-rail')) continue; // 左侧刻度条 sticky 悬浮不参与内容流,恒不为锚
      if (child.classList.contains('chat-spacer')) continue; // 虚拟窗口占位条不是内容
      const r = child.getBoundingClientRect();
      if (r.bottom > cTop) {
        found = { node: child, top: r.top - cTop };
        break;
      }
    }
    expandAnchorRef.current = found;
  };
  useLayoutEffect(() => {
    const saved = expandAnchorRef.current;
    if (saved === null) return;
    expandAnchorRef.current = null;
    const el = chatScrollRef.current;
    if (el === null) return;
    // 贴底态(2026-11-18 用户实测「切回后划不到底/看不到运行行」):后台补齐在上方插条目,元素锚会
    // 把「视图」钉住而让底部越走越远(实测距底 94px 持续增长)——贴底时改为补齐后重新贴底;
    // 阅读态才走元素锚(保用户正在读的那一行不动)
    if (props.chatStickRef === undefined || props.chatStickRef.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (!saved.node.isConnected) return;
    const cTop = el.getBoundingClientRect().top;
    const afterTop = saved.node.getBoundingClientRect().top - cTop;
    el.scrollTop += afterTop - saved.top;
  }, [visibleCount, chatScrollRef]);
  /** P1 回调稳定化(Task 3):宿主回调 ref 镜像 + 零依赖稳定包装——行组件 memo 判等的回调引用
   *  逐渲染恒定;宿主重装配/会话切换由 ref 取最新(免闭包陈旧,对齐 App.tsx sessionRef 手法)。
   *  opt():可选回调底层缺省时透传 undefined——行组件按「prop 在场」分支渲染(如 spawn 行
   *  onOpenAgent 在场才出链接),包装恒函数会伪造在场;两分支引用各自恒定,memo 判等不破 */
  const propsRef = useRef(props);
  propsRef.current = props;
  const opt = <T,>(wrapper: T, raw: T | undefined): T | undefined => (raw === undefined ? undefined : wrapper);
  const onOpenFileStable = useCallback((p: string) => propsRef.current.onOpenFile?.(p), []);
  const onOpenDiffStable = useCallback((callId: string, p: string) => propsRef.current.onOpenDiff?.(callId, p), []);
  const onOpenAgentStable = useCallback((label: string, agentTitle: string, task?: string) => propsRef.current.onOpenAgent?.(label, agentTitle, task), []);
  const onOpenTaskStable = useCallback((ref: string) => propsRef.current.onOpenTask?.(ref), []);
  const onForkStable = useCallback((runKey: string) => propsRef.current.onFork?.(runKey), []);
  /** 可选回调在场判定同样走 ref(getter 零依赖稳定;返回值=包装或 undefined,两支引用各自恒定) */
  const onOpenFileOpt = useCallback(() => opt(onOpenFileStable, propsRef.current.onOpenFile), [onOpenFileStable]);
  const onOpenDiffOpt = useCallback(() => opt(onOpenDiffStable, propsRef.current.onOpenDiff), [onOpenDiffStable]);
  const onOpenAgentOpt = useCallback(() => opt(onOpenAgentStable, propsRef.current.onOpenAgent), [onOpenAgentStable]);
  const onOpenTaskOpt = useCallback(() => opt(onOpenTaskStable, propsRef.current.onOpenTask), [onOpenTaskStable]);
  const onForkOpt = useCallback(() => opt(onForkStable, propsRef.current.onFork), [onForkStable]);
  const onOpenSessionStable = useCallback((sid: string) => propsRef.current.onOpenSession?.(sid), []);
  const onOpenSessionOpt = useCallback(() => opt(onOpenSessionStable, propsRef.current.onOpenSession), [onOpenSessionStable]);
  const taskNameOfStable = useCallback((id: string) => propsRef.current.taskNameOf(id), []);
  const taskAgentOfStable = useCallback((id: string) => propsRef.current.taskAgentOf?.(id), []);
  const teamNameOfStable = useCallback((ref: string) => propsRef.current.teamNameOf?.(ref) ?? ref, []);
  const teamNameOfOpt = useCallback(() => opt(teamNameOfStable, propsRef.current.teamNameOf), [teamNameOfStable]);
  const callIdOfStable = useCallback((e: ChatEntry) => propsRef.current.callIdOf(e), []);
  const toggleRunStable = useCallback((key: string) => propsRef.current.toggleRun(key), []);
  // 图片随行二参必须透传(2026-10-26 编辑卡重发原图);类型面用 unknown[] 收口——
  // UserEntryView 声明 string[]、ChatEntryView 声明 File[](历史口径),单签名不收则两处不可赋值
  const submitTextStable = useCallback((text: string, ...rest: unknown[]): Promise<void> => {
    const send = propsRef.current.submitText;
    if (send === undefined) return Promise.resolve(); // sunx=编辑链整闭(不可达兜底)
    return send(text, rest[0] as string[] | undefined);
  }, []);
  // 编辑重发面随可选 submitText 缺席收口(2026-11-24 Sunx 编辑入口关闭):undefined=气泡 Edit 钮不渲染
  const onSendArg = props.submitText !== undefined ? submitTextStable : undefined;
  const onEntryOpenDiffStable = useCallback((p: string) => propsRef.current.onEntryOpenDiff(p), []);
  const onEntryRestoreStable = useCallback((p: string) => propsRef.current.onEntryRestore(p), []);
  const onOpenTurnStable = useCallback((run: number, path: string) => propsRef.current.onOpenTurn?.(run, path), []);
  const onTurnRestoreStable = useCallback((run: number, paths: string[]) => propsRef.current.onTurnRestore?.(run, paths) ?? Promise.resolve([]), []);
  const onOpenTurnOpt = useCallback(() => opt(onOpenTurnStable, propsRef.current.onOpenTurn), [onOpenTurnStable]);
  const onTurnRestoreOpt = useCallback(() => opt(onTurnRestoreStable, propsRef.current.onTurnRestore), [onTurnRestoreStable]);
  /** 单位渲染面(2026-11-18 结构性改造):原 DayGroupBlock 的节点装配逻辑平移为「按块渲染」——
   *  虚拟窗口只对挂载块调 renderUnit;jsdom/无布局回退整窗逐块直渲(DOM 与旧结构一致)。
   *  回调全部走稳定化包装,行组件 memo 判等面不破 */
  const onOpenFileArg = onOpenFileOpt();
  const onOpenDiffArg = onOpenDiffOpt();
  const onOpenAgentArg = onOpenAgentOpt();
  const onOpenTaskArg = onOpenTaskOpt();
  const teamNameOfArg = teamNameOfOpt();
  const onOpenTurnArg = onOpenTurnOpt();
  const onTurnRestoreArg = onTurnRestoreOpt();
  const onForkArg = onForkOpt();
  const onOpenSessionArg = onOpenSessionOpt();
  const renderTool = useCallback((e2: ChatEntry) => (
    <ToolEntryView
      key={e2.key}
      entry={e2}
      conn={conn}
      sessionId={sessionId}
      callId={callIdOfStable(e2)}
      root={root}
      onOpenFile={onOpenFileArg}
      onOpenDiff={onOpenDiffArg}
      onOpenAgent={onOpenAgentArg}
      onOpenTask={onOpenTaskArg}
      onOpenTodos={props.onOpenTodos}
      onOpenArtifacts={props.onOpenArtifacts}
      taskNameOf={taskNameOfStable}
      taskAgentOf={taskAgentOfStable}
      teamNameOf={teamNameOfArg}
      teams={props.teams}
    />
  ), [conn, sessionId, callIdOfStable, root, onOpenFileArg, onOpenDiffArg, onOpenAgentArg, onOpenTaskArg, props.onOpenTodos, props.onOpenArtifacts, taskNameOfStable, taskAgentOfStable, teamNameOfArg, props.teams]);
  const renderThinking = useCallback((e2: ChatEntry) => <ThinkingEntryView key={e2.key} entry={e2} />, []);
  const renderAssistant = useCallback((e2: ChatEntry) => <ChatEntryView key={e2.key} entry={e2} onOpenDiff={onEntryOpenDiffStable} onOpenTurn={onOpenTurnArg} onTurnRestore={onTurnRestoreArg} onOpenAgent={onOpenAgentArg} sideChat={sideChat} />, [onEntryOpenDiffStable, onOpenTurnArg, onTurnRestoreArg, onOpenAgentArg, sideChat]);
  const renderFoldEntry = useCallback((e2: ChatEntry) => {
    if (e2.kind === 'user') {
      return (
        <UserEntryView
          key={e2.key}
          entry={e2}
          insert
          onSend={onSendArg}
          rewindOps={props.rewindOps}
          composerEnv={props.composerEnv}
          onOpenFile={onOpenFileArg}
          onOpenImage={onOpenImage}
          conn={conn}
          root={root}
          sideChat={sideChat}
        />
      );
    }
    return (
      <ChatEntryView
        key={e2.key}
        entry={e2}
        onOpenDiff={onEntryOpenDiffStable}
        onOpenTurn={onOpenTurnArg}
        onTurnRestore={onTurnRestoreArg}
        onOpenAgent={onOpenAgentArg}
        onOpenFile={onOpenFileArg}
        sideChat={sideChat}
        conn={conn}
        sessionId={sessionId}
        root={root}
        onOpError={props.onOpError}
        onOpenWeb={onOpenWeb}
        onRunInTerminal={props.onRunInTerminal}
        onOpenArtifacts={props.onOpenArtifacts}
      />
    );
  }, [onSendArg, props.rewindOps, props.composerEnv, onOpenFileArg, onOpenImage, conn, sessionId, root, props.onOpError, onOpenWeb, props.onRunInTerminal, props.onOpenArtifacts, onEntryOpenDiffStable, onOpenTurnArg, onTurnRestoreArg, onOpenAgentArg, sideChat]);
  /** 切点回退:cut 落在 run 折叠隐区(Worked 头后的隐藏行)会劈开折叠组——回退到首个非隐藏边界,
   *  折叠组随头完整保留 */
  /** 窗口顶冻结(2026-11-17 用户实测「运行中滚到上面时不时跳到底部」根因①):cut=entries.length-
   *  visibleCount 随流式追加前移,正在读的行不断从窗口顶掉出,视口被逐步拽向底部。非贴底(stick
   *  =false)期间冻结窗口顶——追加条目只落在窗口尾内,阅读位纹丝不动;回贴底(发送回显 stick=true)
   *  恢复窗口跟随尾部。冻结值与回放互取 min:空闲回放/手动步进仍向上揭示 */
  const stick = props.chatStickRef !== undefined ? props.chatStickRef.current : true;
  const cutLive = Math.max(0, entries.length - visibleCount);
  const prevStickRef = useRef(true);
  const cutFrozenRef = useRef<number | null>(null);
  if (prevStickRef.current !== stick) {
    prevStickRef.current = stick;
    cutFrozenRef.current = stick || entries.length === 0 ? null : cutLive; // 空态不锁(种子未落),锁 0=窗口全开
  } else if (!stick && cutFrozenRef.current === null && entries.length > 0) {
    cutFrozenRef.current = cutLive; // 挂载即阅读态(存档恢复路径):条目到位当拍锁窗
  }
  const frozen = cutFrozenRef.current;
  let cut = frozen !== null ? Math.min(frozen, cutLive) : cutLive;
  if (cut > 0) {
    while (cut > 0 && hiddenKeys.has(entries[cut]!.key)) cut -= 1;
  }
  /** 尾部窗口只在无布局面(jsdom)保留(测试锚:入口 80/步进/回放/冻结);真浏览器=全量模型——
   *  虚拟窗口只挂视口切片,千条会话无需「显示更早」逐段解锁(2026-11-18 结构性改造完全体) */
  const windowed = LAYOUT_FREE;
  const visible = useMemo(() => (windowed && cut > 0 ? entries.slice(cut) : entries), [windowed, entries, cut]);
  const hiddenCount = entries.length - visible.length;
  /** P1 派生冻结:日分组骨架 memo(区间切分随骨架缓存),成员数组 dayGroups 逐渲染按区间
   *  slice 重绑最新条目引用(流式尾行实时)——语义与逐帧全量分组等价,省去逐帧 Intl 构造 */
  const daySkeleton = useMemo(() => {
    const gs = groupEntriesByDay(visible);
    let start = 0;
    return gs.map((g) => {
      const s = { key: g.key, label: g.label, start, end: start + g.entries.length };
      start = s.end;
      return s;
    });
    // 依赖=骨架判据四元组(visible 的切分只随 sv/seedGen/visibleCount/hiddenKeys 变)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureVersion, seedGen, visibleCount, hiddenKeys]);
  /** 虚拟窗口(2026-11-18 结构性改造):窗口内条目按「块」挂载——只挂视口±overscan,上下 spacer
   *  占位;高度表实测优先/估算兜底,视口上方块高度变化同帧回钉 scrollTop(阅读位不动)。
   *  jsdom(无布局)整体旁路:整窗逐块直渲,测试面语义与旧实现逐字一致。 */
  const [viewH, setViewH] = useState<number>(() => (LAYOUT_FREE ? 0 : Math.max(320, Math.round((typeof window === 'undefined' ? 800 : window.innerHeight) * 0.6))));
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);
  const [heightVer, setHeightVer] = useState(0);
  const viewHRef = useRef(viewH);
  const rangeRef = useRef<{ first: number; last: number } | null>(range);
  rangeRef.current = range;
  /** 高度表=会话档持久表(重挂命中上次实测值;reference 即持久档,RO 写入直接落档) */
  const [heightsMap] = useState<Map<string, number>>(() => unitHeightsFor(props.heightScope ?? ''));
  const heightsRef = useRef<Map<string, number>>(heightsMap);
  const unitElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const offsetsRef = useRef<number[]>([0]);
  const unitIndexByKeyRef = useRef<Map<string, number>>(new Map());
  const unitIndexOfEntryRef = useRef<Map<string, number>>(new Map());
  const scrollTopRef = useRef(Number.MAX_SAFE_INTEGER); // 首帧贴底语义(恢复位由 Chat 的恢复效果随后写入)
  const unitsRef = useRef<UnitSpan[]>([]);
  /** 阅读态内容锚(2026-11-18 虚拟窗口):视口顶所在块 key + 块顶相对视口的偏移。块序列/高度
   *  变化(扩窗上插、上方实测校正)后按新偏移回钉 scrollTop——索引平移不再靠元素锚(块可能未挂) */
  const anchorRef = useRef<{ key: string; off: number } | null>(null);
  /** 高度实测回钉的待应用增量(2026-11-19 刻度跳转后回弹):applyPending 只累计、不即时写 scrollTop——
   *  旧实现「改高度前先 scrollTop += Δ」,滚动先于 React 提交新 spacer,中间一帧整段可见内容上移
   *  (用户实测刻度跳转 ~400ms 后上滑 ~10px)。现在统一在下方 layout effect(提交后、绘制前)应用:
   *  有阅读锚=按锚块**真实盒位移**回钉(估算校正不算位移);无锚才用本增量兜底 */
  const pendingAboveRef = useRef(0);
  /** 程序化落点代次(0=无落点收敛):落点由 landOnUnit 的实测收敛独占,回钉让路——两边同时
   *  按同一真实位移补差会把内容推两次;新落点递增代次,旧收敛循环见代次不符即自行退出 */
  const landingRef = useRef(0);
  const rafRef = useRef(0);
  const unitRoRef = useRef<ResizeObserver | null>(null);
  /** 滚动期暂存的高度实测(流式增长块停手后批量落账;滚动中改 spacer=每帧 Layout/Layerize。
   *  非流式块挂载即落账,见 RO callback 注) */
  const pendingHeightsRef = useRef<Map<string, number>>(new Map());
  const settleTimerRef = useRef<number | null>(null);
  /** 高度落账调度单点(RO/滚动两路共用;RO effect 挂载时写入) */
  const scheduleHeightsRef = useRef<() => void>(() => undefined);
  /** 立即落账入口(换界前冲刷待办;RO effect 挂载时写入) */
  const flushHeightsRef = useRef<(() => void) | null>(null);
  const office = useUiMode() === 'office';
  /** 日分组(块模型的组边界;memo 免逐渲染 Intl 构造) */
  const dayGroups = useMemo(() => daySkeleton.map((s) => ({
    key: s.key,
    label: s.label,
    entries: visible.slice(s.start, s.end),
  })), [daySkeleton, visible]);
  /** 块序列(虚拟列表挂载单位;纯投影,不建 React 元素)。2026-11-18 全量模型:千条会话每次渲染
   *  重切全部分组会吃掉流式预算——按组缓存(键=组序号/键/首末条目;折叠态变更整表清空),渲染期
   *  只做扁平化(O(组数)+数组引用拷贝)。
   *  2026-11-19 流式/滑动去重渲:缓存命中还要校验成员条目引用逐位未变——span 对象是 UnitView
   *  memo 的身份指纹,末条正文流式增长时条目对象换新但缓存键不变,不重切=块被 memo 判等跳过,
   *  正文冻住。成员引用有变即重切该组(只有变化组付 O(n),其余组仍复用旧 span 对象) */
  const spanCacheRef = useRef(new Map<string, UnitSpan[]>());
  const spanEntriesRef = useRef(new Map<string, readonly ChatEntry[]>());
  const spanHiddenRef = useRef(hiddenKeys);
  if (spanHiddenRef.current !== hiddenKeys) {
    spanHiddenRef.current = hiddenKeys;
    spanCacheRef.current.clear();
    spanEntriesRef.current.clear();
  }
  const units = useMemo(() => {
    const cache = spanCacheRef.current;
    const entriesCache = spanEntriesRef.current;
    const out: UnitSpan[] = [];
    const live = new Set<string>();
    for (let gi = 0; gi < dayGroups.length; gi += 1) {
      const g = dayGroups[gi]!;
      const last = g.entries[g.entries.length - 1];
      // 键只管分组身份(序号/日键/首末):成员集变化由下方条目引用逐位校验兜底——把
      // structureVersion/seedGen 也放进键,会让一次工具落账(结构变更)整表 miss,
      // 未变的组也跟着整组换 span/整组重渲;引用校验已覆盖插入/替换/切种
      const key = `${gi}:${g.key}:${g.entries.length}:${g.entries[0]?.key ?? ''}:${last?.key ?? ''}`;
      live.add(key);
      const oldSpans = cache.get(key);
      const oldEntries = entriesCache.get(key);
      let spans = oldSpans;
      if (spans !== undefined) {
        if (oldEntries === undefined || oldEntries.length !== g.entries.length) {
          spans = undefined;
        } else {
          for (let k = 0; k < g.entries.length; k += 1) {
            if (oldEntries[k] !== g.entries[k]) { spans = undefined; break; }
          }
        }
      }
      if (spans === undefined || spans.length === 0) {
        const fresh = dayUnitSpans(gi, g.key, g.label, g.entries, hiddenKeys, office, isCommandEntry, isOfficeHiddenNotice);
        // 组重建但只有尾块变化时,未变块沿用旧 span 对象(UnitView memo bail-out)
        spans = oldSpans === undefined || oldEntries === undefined ? fresh : reuseUnchangedSpans(fresh, oldSpans, oldEntries, g.entries);
        cache.set(key, spans);
        entriesCache.set(key, g.entries);
      }
      for (let i = 0; i < spans.length; i += 1) out.push(spans[i]!);
    }
    if (cache.size > live.size * 2) {
      for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
      for (const k of entriesCache.keys()) if (!live.has(k)) entriesCache.delete(k);
    }
    return out;
  }, [dayGroups, hiddenKeys, office, structureVersion, seedGen]);
  /** 渲染期取组条目(2026-11-19:renderUnit 回调不再以 dayGroups 身份为依赖——流式每帧 dayGroups
   *  换新会让回调换新→UnitView 全量重渲;组内容变化已由上方成员引用校验反映为 span 换新 */
  const dayGroupsRef = useRef(dayGroups);
  dayGroupsRef.current = dayGroups;
  /** 运行中的末段(2026-11-19 简洁模式常显最后一条工具行):末个 seg 块,供 ToolSegBlock 钉住 */
  const liveSegKey = useMemo(() => {
    if (!running) return undefined;
    for (let i = units.length - 1; i >= 0; i -= 1) if (units[i]!.kind === 'seg') return units[i]!.key;
    return undefined;
  }, [units, running]);
  const unitIndexByKey = useMemo(() => new Map(units.map((u, i) => [u.key, i])), [units]);
  /** 用户气泡块序号(刻度加亮按模型二分:线所属轮=块顶≤判定线的最后一枚用户块) */
  const userUnitIdx = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < units.length; i += 1) if (units[i]!.kind === 'user') out.push(i);
    return out;
  }, [units]);
  const userUnitIdxRef = useRef(userUnitIdx);
  userUnitIdxRef.current = userUnitIdx;
  /** 刻度加亮模型反查(线=内容坐标;offsetsRef 同空间):不依赖挂载窗,长正文轮也不断档 */
  const activeUserKeyAt = useCallback((line: number): string | null => {
    const arr = userUnitIdxRef.current;
    const list = unitsRef.current;
    const off = offsetsRef.current;
    if (arr.length === 0) return null;
    let lo = 0;
    let hi = arr.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((off[arr[mid]!] ?? 0) <= line) {
        hit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (hit < 0) return null;
    return list[arr[hit]!]?.key ?? null;
  }, []);
  unitIndexByKeyRef.current = unitIndexByKey;
  unitsRef.current = units;
  /** 条目 key → 块序号(刻度跳转/未挂载定位用;段内条目指向所在段块) */
  const unitIndexOfEntry = useMemo(() => {
    const m = new Map<string, number>();
    units.forEach((u, i) => {
      if (u.kind === 'day') return;
      const g = dayGroups[u.group]!.entries;
      for (let k = u.start; k < u.end; k += 1) m.set(g[k]!.key, i);
    });
    return m;
  }, [units, dayGroups]);
  unitIndexOfEntryRef.current = unitIndexOfEntry;
  const virtual = !LAYOUT_FREE && viewH > 0 && units.length > 0;
  const virtualRef = useRef(virtual);
  virtualRef.current = virtual;
  const offsets = useMemo(() => prefixOffsets(units, heightsRef.current), [units, heightVer]);
  offsetsRef.current = offsets;
  const totalH = offsets[units.length] ?? 0;
  /** 本帧挂载区间:贴底恒取尾部(流式增长自动跟);阅读态取已提交区间(滚动事件更新) */
  const rangeNow = virtual
    ? stick
      ? sliceRange(offsets, Math.max(0, totalH - viewH), viewH, VIRTUAL_OVERSCAN)
      : range ?? sliceRange(offsets, Math.max(0, Math.min(scrollTopRef.current, Math.max(0, totalH - viewH))), viewH, VIRTUAL_OVERSCAN)
    : null;
  const firstUnit = Math.min(rangeNow?.first ?? 0, Math.max(0, units.length - 1));
  const lastUnit = Math.min(rangeNow?.last ?? units.length, units.length);
  /** 记阅读锚(2026-11-19 二次回弹根修):锚块已挂载时记**真实盒位**——模型偏移含估算,
   *  实测校正只让模型追赶、不产生真实 DOM 位移;以估算坐标为锚会在下一次回钉时把误差再补一遍。
   *  锚块未挂载(极少,overscan 保证视口块恒挂)才回落模型坐标 */
  const setReadingAnchor = (): void => {
    if (LAYOUT_FREE || !virtualRef.current) return;
    const el = chatScrollRef.current;
    if (el === null) return;
    const off = offsetsRef.current;
    const at = firstUnitAt(off, el.scrollTop);
    const uu = unitsRef.current[at];
    if (uu === undefined) return;
    const node = unitElsRef.current.get(uu.key);
    if (node !== undefined && node.isConnected) {
      anchorRef.current = { key: uu.key, off: node.getBoundingClientRect().top - el.getBoundingClientRect().top };
    } else {
      anchorRef.current = { key: uu.key, off: (off[at] ?? 0) - el.scrollTop };
    }
  };
  /** 滚动 → 视口高/挂载区间更新(rAF 合并;区间不变不重渲) */
  const scheduleViewport = (): void => {
    if (LAYOUT_FREE || rafRef.current !== 0) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = chatScrollRef.current;
      if (el === null) return;
      scrollTopRef.current = el.scrollTop;
      const h = el.clientHeight;
      if (h > 0 && h !== viewHRef.current) {
        viewHRef.current = h;
        setViewH(h);
      }
      if (!virtualRef.current) return;
      const off = offsetsRef.current;
      setReadingAnchor();
      // 2026-11-19 快速滑动轮:切片滞回——视口仍稳稳落在已挂载覆盖区内(离上/下边界还余
      // RANGE_EDGE_MARGIN)就不重算区间。旧实现每帧 setRange:提交期整段可视树重渲(实测快速
      // 滑动 2.4s 内 React 提交 241 次、占主线程 ~43%),且每帧装卸边界单元=持续 layout 抖动。
      // 覆盖区自带 900px overscan,典型滚速下每滚 ~700px 才更新一次;贴底(cur.last 覆盖末块)
      // 视为已覆盖,避免底部反复重算
      const cur = rangeRef.current;
      const total = off[off.length - 1] ?? 0;
      const viewTop = el.scrollTop;
      const viewBot = viewTop + h;
      const covered = cur !== null && (
        (viewBot >= total - 1 && cur.last >= unitsRef.current.length)
        || (viewTop >= (off[cur.first] ?? 0) + RANGE_EDGE_MARGIN && viewBot <= (off[cur.last] ?? 0) - RANGE_EDGE_MARGIN)
      );
      if (!covered) {
        // 换界前把待落账高度并入模型(2026-11-25):换界会卸载上方块,它们的实测高若还躺在
        // 待办里,顶 spacer 就退回估算——估算与实测差多少,视口内容就整段跳多少
        let offSlice = off;
        if (pendingHeightsRef.current.size > 0) {
          flushHeightsRef.current?.();
          offSlice = prefixOffsets(unitsRef.current, heightsRef.current);
        }
        const r = sliceRange(offSlice, viewTop, h, VIRTUAL_OVERSCAN);
        if (cur === null || r.first !== cur.first || r.last !== cur.last) {
          rangeRef.current = r;
          // 挂载窗变更同帧提交(2026-11-25 白闪轮):rAF 里的 setState 走调度器任务,可能落到
          // 本帧绘制之后——旧窗已滚出视口、新块还没挂=整屏空白一帧;flushSync 把挂载压进当前帧
          flushSync(() => setRange(r));
        }
      }
      // 视口空洞兜底(2026-11-25 长正文白屏轮):模型再怎么滞后也不许把视口晾在 spacer 里。
      // 量首末已挂块的真实盒位,视口整体落到挂载区之外即把 scrollTop 钳回区界;下一帧切片
      // 随落账后的模型(或下一块挂载)自然复位
      if (!(props.chatStickRef !== undefined && props.chatStickRef.current) && landingRef.current === 0) {
        const rr = rangeRef.current;
        const n = unitsRef.current.length;
        if (rr !== null && rr.first < rr.last && rr.first >= 0 && rr.last <= n) {
          const firstNode = unitElsRef.current.get(unitsRef.current[rr.first]!.key);
          const lastNode = unitElsRef.current.get(unitsRef.current[rr.last - 1]!.key);
          if (firstNode !== undefined && lastNode !== undefined && firstNode.isConnected && lastNode.isConnected) {
            const cTop = el.getBoundingClientRect().top;
            const fTop = firstNode.getBoundingClientRect().top - cTop;
            const lBot = lastNode.getBoundingClientRect().bottom - cTop;
            if (lBot <= 0) {
              el.scrollTop += lBot - h; // 视口在挂载区下方(底部 spacer 空洞):贴回内容末尾
              scrollTopRef.current = el.scrollTop;
            } else if (fTop >= h) {
              el.scrollTop += fTop; // 视口在挂载区上方:贴回内容开头
              scrollTopRef.current = el.scrollTop;
            }
          }
        }
      }
      // 待落账高度:滚动中不断顺延(停手 200ms 后批量应用,见 RO effect)
      if (pendingHeightsRef.current.size > 0) scheduleHeightsRef.current();
      schedulePrefetch();
    });
  };
  /** 停顿期向前预挂载(2026-11-19 大块滑动轮「不改显示效果」方案):用户停手后把视口前方再多挂
   *  2 个块——大正文块(实测单块首次挂载 ~80ms)的 React 提交/布局成本在空闲时付掉,滚动经过时
   *  不再现挂。按「块数」而非像素扩(大块本身上万 px,像素距离盖不住一块);只向前扩、不缩后方;
   *  滚动中定时器被新滚动重置,不会抢当前帧;上限 48 块兜底内存。
   *  2026-11-19 复测(用户「滑动又加重」):300ms 与真实「滑—停—再滑」节奏(300-400ms)重叠,
   *  大块挂载恰好落在用户再次起滑前一帧=反被感知成卡顿——提到 600ms,只在真正读停时预挂 */
  const PREFETCH_IDLE_MS = 600;
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchAhead = (): void => {
    if (!virtualRef.current) return;
    if (document.visibilityState !== 'visible') return;
    const el = chatScrollRef.current;
    if (el === null) return;
    const h = el.clientHeight;
    if (h <= 0) return;
    const off = offsetsRef.current;
    const cur = rangeRef.current;
    const viewR = sliceRange(off, el.scrollTop, h, 0);
    const n = unitsRef.current.length;
    const last = Math.min(n, viewR.last + 2);
    const merged = { first: cur === null ? viewR.first : cur.first, last: Math.max(cur?.last ?? 0, last) };
    if (merged.last - merged.first > 48) return;
    if (cur === null || merged.last !== cur.last || merged.first !== cur.first) {
      rangeRef.current = merged;
      setRange(merged);
    }
  };
  const schedulePrefetch = (): void => {
    if (LAYOUT_FREE) return;
    if (prefetchTimerRef.current !== null) clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = setTimeout(() => {
      prefetchTimerRef.current = null;
      prefetchAhead();
    }, PREFETCH_IDLE_MS);
  };
  useEffect(() => () => {
    if (prefetchTimerRef.current !== null) clearTimeout(prefetchTimerRef.current);
  }, []);
  /** 挂载期:量视口高(首帧估算值落地)+ 视口尺寸变化跟随;卸载取消在途帧 */
  useLayoutEffect(() => {
    if (LAYOUT_FREE) return;
    const el = chatScrollRef.current;
    if (el === null) return;
    const measure = (): void => {
      const h = el.clientHeight;
      if (h > 0 && h !== viewHRef.current) {
        viewHRef.current = h;
        setViewH(h);
      }
      scrollTopRef.current = el.scrollTop;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current);
    };
  }, [chatScrollRef]);
  /** 块高度实测(ResizeObserver 单点):高度表更新→spacer 重算;视口上方块变化同帧回钉 scrollTop */
  useLayoutEffect(() => {
    if (LAYOUT_FREE || typeof ResizeObserver === 'undefined') return;
    /** 块是否仍在流式增长(末条正文/运行中的工具段):流式块逐帧长高,落账推迟到停手 */
    const isStreamingUnit = (idx: number): boolean => {
      const u = unitsRef.current[idx];
      if (u === undefined || u.kind === 'day') return false;
      const g = dayGroupsRef.current[u.group];
      if (g === undefined) return false;
      for (let k = u.start; k < u.end; k += 1) if (g.entries[k]?.streaming === true) return true;
      return false;
    };
    /** 高度落账(流式块滚动静默后批量应用):逐拍改 spacer 高度=每帧 Layout/Layerize(实测
     *  滚动期 Layerize 703ms/2s),成熟列表的做法都是滚动期零布局、停手后一次校正。
     *  compensate=false=换界前冲刷:spacer 与刚卸载的真实高度精确互换,无需再补 scrollTop */
    const applyPending = (compensate: boolean = true): void => {
      settleTimerRef.current = null;
      const el = chatScrollRef.current;
      const pending = pendingHeightsRef.current;
      if (el === null || pending.size === 0) return;
      let above = 0;
      const off = offsetsRef.current;
      for (const [key, h] of pending) {
        const old = heightsRef.current.get(key);
        if (old !== undefined && Math.abs(old - h) <= 0.5) continue;
        heightsRef.current.set(key, h);
        rememberUnitHeight(props.heightScope ?? '', key, h);
        const idx = unitIndexByKeyRef.current.get(key);
        // 块整体在视口顶之上(底边 ≤ scrollTop)且是**已实测值的再变化**(内容真长高/缩短)才回钉。
        // 首测(旧值缺省=估算占位)不算:浏览器早已按真实高度排版,DOM 位移为 0——把「实测-估算」
        // 也当增量会重复补差(实测刻度跳转 ~300ms 后上滑 13.6px 即此,模型追赶≠真实位移)
        if (compensate && old !== undefined && idx !== undefined && off[idx + 1] !== undefined && off[idx + 1]! <= el.scrollTop) above += h - old;
      }
      pending.clear();
      // 增量不在此写 scrollTop(见 pendingAboveRef 注):交下方 layout effect 在提交后统一回钉
      if (above !== 0) pendingAboveRef.current += above;
      setHeightVer((v) => v + 1);
    };
    const deferApply = (): void => {
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      const idleFor = performance.now() - lastScrollAtRef.current;
      settleTimerRef.current = window.setTimeout(() => applyPending(true), Math.max(60, 200 - Math.min(idleFor, 190)));
    };
    scheduleHeightsRef.current = deferApply;
    flushHeightsRef.current = (): void => {
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      applyPending(false);
    };
    const ro = new ResizeObserver((entries) => {
      // 卸载块剪枝(节点已脱离文档:RO 不再交付,map 不留悬引用)
      for (const [k, n] of unitElsRef.current) {
        if (!n.isConnected) {
          unitElsRef.current.delete(k);
          ro.unobserve(n);
        }
      }
      const pending = pendingHeightsRef.current;
      const el = chatScrollRef.current;
      const cTop = el !== null ? el.getBoundingClientRect().top : 0;
      let got = false;
      let applied = 0;
      let above = 0;
      for (const en of entries) {
        const node = en.target as HTMLElement;
        const key = node.dataset.unitKey ?? '';
        if (key === '') continue;
        const h = en.contentRect.height;
        if (!(h > 0.5)) continue;
        const old = pending.get(key) ?? heightsRef.current.get(key);
        if (old !== undefined && Math.abs(old - h) <= 0.5) continue;
        const idx = unitIndexByKeyRef.current.get(key);
        if (idx !== undefined && isStreamingUnit(idx)) {
          pending.set(key, h);
          got = true;
          continue;
        }
        // 非流式块**挂载即落账**(2026-11-25 长正文白屏轮根因之一):旧实现一律推迟到停手,推迟
        // 窗内 offsets 仍是估算——750px 列宽下长正文/代码块可高估 2-3 倍,slice 按模型算,视口滑
        // 进「模型说还有内容、真实 DOM 已是空白 spacer」的区间就再也补挂不出来(白屏)。落账后
        // 模型与真实排版同步;块在视口上方时同步补偿 scrollTop(内容实测差多少,视口就补多少)
        const u = idx !== undefined ? unitsRef.current[idx] : undefined;
        const modelH = old ?? (u !== undefined ? unitEstimate(u.kind, u.entryKind, u.est) : h);
        heightsRef.current.set(key, h);
        rememberUnitHeight(props.heightScope ?? '', key, h);
        pending.delete(key);
        applied += 1;
        if (el !== null && node.getBoundingClientRect().bottom <= cTop) above += h - modelH;
      }
      if (applied > 0) {
        if (above !== 0 && el !== null) {
          el.scrollTop += above;
          scrollTopRef.current = el.scrollTop;
        }
        setHeightVer((v) => v + 1);
      }
      if (got) deferApply();
    });
    unitRoRef.current = ro;
    for (const n of unitElsRef.current.values()) ro.observe(n);
    return () => {
      ro.disconnect();
      unitRoRef.current = null;
      flushHeightsRef.current = null;
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [chatScrollRef]);
  /** 模型变更后区间重算(2026-11-18 折叠展开缺口):折叠/展开/高度实测改块序列时,区间 state
   *  里的旧序号已不对应新块——只等滚动事件会漏(点击展开不产生滚动):视口下侧内容不挂载,
   *  用户看到「展开只有两个轮次」。块/偏移一变即按当前滚动位重算区间,保证视口全覆盖 */
  useLayoutEffect(() => {
    if (!virtualRef.current) return;
    const el = chatScrollRef.current;
    if (el === null) return;
    const h = el.clientHeight;
    if (h <= 0) return;
    const total = offsetsRef.current[offsetsRef.current.length - 1] ?? 0;
    const top = stick ? Math.max(0, total - h) : el.scrollTop;
    const r = sliceRange(offsetsRef.current, top, h, VIRTUAL_OVERSCAN);
    const cur = rangeRef.current;
    if (cur === null || r.first !== cur.first || r.last !== cur.last) setRange(r);
    // 模型落定(种子/折叠/高度校正/流式停顿)后同样排一次前方预挂载
    schedulePrefetch();
  }, [offsets, units, stick, chatScrollRef]);

  /** 阅读态内容锚回钉(虚拟窗口):块序列/高度变→按锚块**真实 DOM 位移**校正 scrollTop;
   *  贴底/无锚不接管。
   *  2026-11-19 刻度跳转二次回弹(用户实测「隔一下又跳动/上滑」):旧实现按模型偏移
   *  `offsets[anchor]-a.off` 回钉——模型对未实测块用的是估算值,块挂载实测后模型追赶(实测-估算),
   *  但浏览器早已按真实高度排版,DOM 位移为 0;按模型补差=把误差再推一遍(实测 +13.6px)。
   *  改为锚块已挂载时直接量它的盒位移:只有真实 DOM 变化(图片/字体/代码高亮把内容撑高)才回钉,
   *  模型估算校正不再制造位移。锚块未挂载(极少)才回退模型坐标。 */
  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    const pendingAbove = pendingAboveRef.current;
    pendingAboveRef.current = 0;
    if (!virtualRef.current || stick || el === null) return;
    if (landingRef.current !== 0) return; // 落点收敛接管(见 landingRef 注)
    const a = anchorRef.current;
    if (a !== null) {
      const node = unitElsRef.current.get(a.key);
      if (node !== undefined && node.isConnected) {
        const delta = (node.getBoundingClientRect().top - el.getBoundingClientRect().top) - a.off;
        if (Math.abs(delta) > 1) {
          el.scrollTop += delta;
          scrollTopRef.current = el.scrollTop;
        }
        return;
      }
      const idx = unitIndexByKeyRef.current.get(a.key);
      if (idx !== undefined) {
        const want = Math.max(0, (offsetsRef.current[idx] ?? 0) - a.off);
        if (Math.abs(el.scrollTop - want) > 1) {
          el.scrollTop = want;
          scrollTopRef.current = el.scrollTop;
        }
        return;
      }
    }
    if (pendingAbove !== 0) {
      el.scrollTop += pendingAbove;
      scrollTopRef.current = el.scrollTop;
    }
  }, [offsets, stick, chatScrollRef]);
  /** 块包装引用(稳定回调:同一节点不重挂则不重 observe) */
  const unitRefCb = useCallback((el: HTMLDivElement | null) => {
    if (el === null) return;
    const key = el.dataset.unitKey ?? '';
    if (key === '') return;
    unitElsRef.current.set(key, el);
    unitRoRef.current?.observe(el);
  }, []);
  /** 按块渲染(原 DayGroupBlock 装配分支逐条镜像:日分隔/命令三态/折叠段/run/用户/正文)。
   *  2026-11-19 滑动去重渲:回调以 useCallback 封存(滚动期依赖全稳)——配合下方 UnitView 的
   *  memo,切片换界时只渲染新进视口的块,已挂载块整段 bail-out */
  const renderUnit = useCallback((u: UnitSpan): ReactNode => {
    if (u.kind === 'day') {
      return (
        <div key={u.key} className="chat-day-sep" role="separator" aria-label={u.label}>
          {u.label}
        </div>
      );
    }
    const groupEntries = dayGroupsRef.current[u.group]!.entries;
    if (u.kind === 'seg') {
      const segEntries = groupEntries.slice(u.start, u.end);
      return (
        <ToolSegBlock
          key={u.key}
          seg={segEntries}
          closed={hiddenKeys.has(segEntries[0]!.key)}
          live={u.key === liveSegKey}
          renderTool={renderTool}
          renderThinking={renderThinking}
          renderAssistant={renderAssistant}
          renderEntry={renderFoldEntry}
        />
      );
    }
    const entry = groupEntries[u.start]!;
    if (u.kind === 'cmd') return <CommandEntryView key={entry.key} entry={entry} />;
    if (u.kind === 'run') {
      return (
        <RunEntryView
          key={entry.key}
          entry={entry}
          wake={entry.wake}
          scheduled={entry.schedule === true ? true : undefined}
          restored={entry.restored === true ? true : undefined}
          onOpenTask={onOpenTaskArg}
          collapsed={collapsedRuns.has(entry.key)}
          onToggle={toggleRunStable}
        />
      );
    }
    if (u.kind === 'user') {
      const insert = sideChat === true || isMidRunInsert(groupEntries, u.start);
      return (
        <UserEntryView
          key={entry.key}
          entry={entry}
          insert={insert}
          onSend={onSendArg}
          rewindOps={props.rewindOps}
          composerEnv={props.composerEnv}
          onOpenFile={onOpenFileArg}
          onOpenImage={onOpenImage}
          conn={conn}
          root={root}
          sideChat={sideChat}
        />
      );
    }
    return (
      <ChatEntryView
        key={entry.key}
        entry={entry}
        footerRun={runFooterByEntry.get(entry.key)}
        onOpenDiff={onEntryOpenDiffStable}
        onRestore={onEntryRestoreStable}
        onFork={onForkArg}
        onOpenFile={onOpenFileArg}
        onOpenAgent={onOpenAgentArg}
        onOpenSession={onOpenSessionArg}
        onOpenTurn={onOpenTurnArg}
        onTurnRestore={onTurnRestoreArg}
        conn={conn}
        sessionId={sessionId}
        root={root}
        onOpError={props.onOpError}
        onOpenWeb={onOpenWeb}
        onRunInTerminal={props.onRunInTerminal}
        onOpenArtifacts={props.onOpenArtifacts}
        sideChat={sideChat}
      />
    );
  }, [hiddenKeys, renderTool, renderThinking, renderAssistant, renderFoldEntry, collapsedRuns, onOpenTaskArg, toggleRunStable, sideChat, onSendArg, props.rewindOps, props.composerEnv, onOpenFileArg, onOpenImage, conn, root, runFooterByEntry, onEntryOpenDiffStable, onEntryRestoreStable, onForkArg, onOpenAgentArg, onOpenSessionArg, onOpenTurnArg, onTurnRestoreArg, sessionId, props.onOpError, onOpenWeb, props.onRunInTerminal, props.onOpenArtifacts]);
  /** 刻度跳到未挂载条目(2026-11-18 刻度全量模型):按全量索引扩挂载窗到覆盖该条(含切点
   *  隐藏行回退同口径);返回是否已覆盖(=可立即落点)。虚拟态:覆盖 ≠ 挂载——先落模型坐标
   *  (滚动事件驱动切片),渲染落定后由 landOnUnit 独占实测收敛(返回 true=刻度侧不再另开循环) */
  const pendingRevealRef = useRef<{ key: string; off: number } | null>(null);
  const landOnUnitByEntry = (entryKey: string, off: number, triesMax = 40): void => {
    const ui = unitIndexOfEntryRef.current.get(entryKey);
    if (ui === undefined) return;
    const u = unitsRef.current[ui];
    if (u !== undefined) landOnUnit(u.key, off, triesMax);
  };
  const revealEntry = (key: string): boolean => {
    const idx = entries.findIndex((e) => e.key === key);
    if (idx < 0) return false;
    if (!windowed) {
      // 全量模型:无窗口可扩——直接按块坐标落点(虚拟挂载,滚动事件驱动切片)。
      // 落点/收敛单点(2026-11-19 跳动根修):落点由 landOnUnit 独占(off 与已挂载路径一致取 0),
      // ChatRail 见 true 即不再开自己的 rAFConverge——旧实现两个收敛循环(目标 8px vs 0px)
      // 每帧互相推翻,跳转后内容 ~8px 高频抖动;收敛窗放到 150 帧覆盖大块实测期
      if (virtualRef.current) landOnUnitByEntry(key, 0, 150);
      return true;
    }
    const need = entries.length - idx + 8; // 目标下缘再留 8 条缓冲,避免落点贴窗顶
    if (need > visibleCount) {
      windowTargetRef.current = Math.max(windowTargetRef.current, need);
      captureAnchor();
      pendingRevealRef.current = { key, off: 8 }; // 扩窗后(下一拍块序列就位)落到模型坐标
      setVisibleCount(Math.min(entries.length, need));
      return false; // 本帧尚未挂载,渲染落定后跳转侧重试
    }
    if (virtualRef.current) {
      const ui = unitIndexOfEntryRef.current.get(key);
      const el = chatScrollRef.current;
      if (ui !== undefined && el !== null) {
        el.scrollTop = Math.max(0, (offsetsRef.current[ui] ?? 0) - 8);
        scrollTopRef.current = el.scrollTop;
      }
    }
    return true;
  };
  /** 模型坐标落点 + 实测收敛:目标块可能尚未挂载/高度仍是估算——先按前缀和落位(切片随滚动
   *  事件重算、目标块随后挂载),再按真实盒位置迭代校正(默认 ≤40 帧,eps=2;刻度跳转 150 帧)。
   *  收敛期置 landingRef 代次:阅读锚回钉让路,且新落点会令旧循环自行退出(不互抢 scrollTop) */
  const landOnUnit = (key: string, off: number, triesMax = 40): void => {
    const el = chatScrollRef.current;
    const ui = unitIndexByKeyRef.current.get(key);
    if (el === null || ui === undefined) return;
    const gen = ++landingRef.current;
    el.scrollTop = Math.max(0, (offsetsRef.current[ui] ?? 0) - off);
    scrollTopRef.current = el.scrollTop;
    let tries = 0;
    const finish = (): void => {
      if (landingRef.current !== gen) return;
      landingRef.current = 0;
      setReadingAnchor(); // 收敛落定后以真实盒位重记锚,后续回钉不再补估算差
    };
    const seek = (): void => {
      if (landingRef.current !== gen) return; // 新落点/已收口:旧循环退出
      const el2 = chatScrollRef.current;
      if (el2 === null) { finish(); return; }
      const node = el2.querySelector<HTMLElement>(`[data-unit-key="${CSS.escape(key)}"]`);
      if (node === null) {
        if (++tries < triesMax) requestAnimationFrame(seek);
        else finish();
        return;
      }
      const d = node.getBoundingClientRect().top - el2.getBoundingClientRect().top - off;
      if (Math.abs(d) > 2 && tries < triesMax) {
        tries += 1;
        el2.scrollTop += d;
        scrollTopRef.current = el2.scrollTop;
        requestAnimationFrame(seek);
      } else {
        finish();
      }
    };
    requestAnimationFrame(seek);
  };
  /** 扩窗后的未挂载定位:块序列就位即把目标块滚进视口(切片随滚动/本帧重算,目标块随后挂载) */
  useLayoutEffect(() => {
    const pending = pendingRevealRef.current;
    if (pending === null) return;
    if (unitIndexByKeyRef.current.get(pending.key) === undefined) return; // 块尚未进模型窗,等下一拍
    pendingRevealRef.current = null;
    landOnUnit(pending.key, pending.off);
  }, [unitIndexOfEntry, chatScrollRef]);

  /** 切回驻留座的锚式落点(2026-11-18 落点固化):active false→true 且存档有锚时,按块坐标
   *  落点——距底反推受总高实测变化影响(顶部位实测偏 1.5k),锚式与挂载/高度无关 */
  const prevActiveRef = useRef(props.active !== false);
  useLayoutEffect(() => {
    const on = props.active !== false;
    const was = prevActiveRef.current;
    prevActiveRef.current = on;
    if (!on || was) return;
    if (!virtualRef.current) return;
    const scope = props.heightScope ?? '';
    if (scope === '') return;
    const a = peekScrollAnchor(scope);
    if (a === null) return; // 贴底/无锚:距底或贴底路径接管
    if (unitIndexByKeyRef.current.get(a.key) === undefined) return;
    if (props.chatStickRef !== undefined) props.chatStickRef.current = false;
    landOnUnit(a.key, a.off);
  }, [props.active, props.heightScope, props.chatStickRef]);

  /** 锚式恢复(2026-11-18 虚拟窗口):按存档块坐标落点——目标在窗口外先扩窗(虚拟挂载下扩窗
   *  不挂 DOM,代价=建块对象),块就位后 landOnUnit 落点并实测收敛。只应用一次 */
  const restoreAppliedRef = useRef(false);
  useLayoutEffect(() => {
    if (restoreAppliedRef.current) return;
    const a = props.restoreAnchor;
    if (a === undefined) {
      restoreAppliedRef.current = true;
      return;
    }
    if (!virtual || entries.length === 0 || units.length === 0) return; // 等布局测量/种子
    restoreAppliedRef.current = true;
    const entryKey = a.key.startsWith('seg:') ? a.key.slice(4) : a.key;
    const idx = entries.findIndex((e) => e.key === entryKey);
    if (idx < 0) return; // 存档条目已不在(rewind/删档):放弃锚,保持贴底语义由上层决定
    const need = entries.length - idx + 8;
    if (need > visibleCount) {
      windowTargetRef.current = Math.max(windowTargetRef.current, need);
      setVisibleCount(Math.min(entries.length, need));
      pendingRevealRef.current = { key: a.key, off: a.off };
      return;
    }
    landOnUnit(a.key, a.off);
  }, [virtual, entries, units, visibleCount, props.restoreAnchor]);
  const showEarlier = (step: number = RENDER_WINDOW_STEP): void => {
    captureAnchor();
    // 2026-11-18:手动「显示更早」/滚顶回放不再受 RENDER_WINDOW_MAX 封顶——上万条会话必须能翻到
    // 开头(此前 600 封顶=历史永远不可达);自动(pump)天花板仍是 600,仅控制后台预暖量
    const next = Math.min(entries.length, visibleCount + step);
    windowTargetRef.current = Math.max(windowTargetRef.current, next);
    setVisibleCount(next);
  };
  /** 批2 滚动到顶自动回放:硬顶(scrollTop≤0)即触发步进回放——锚定回钉使展开后 scrollTop=Δ>0,
   *  不再贴顶即天然防循环;继续上滚到顶加载下一批。chat-earlier 按钮保留作显式入口 */
  const maybeReplayEarlier = (): void => {
    if (hiddenCount <= 0) return;
    const el = chatScrollRef.current;
    // 滚顶自动回放用小步(2026-11-18):单帧挂载量小=滚动不顿;手动点「显示更早」仍取大步 300
    if (el !== null && el.scrollTop <= 0) showEarlier(RENDER_WINDOW_IDLE_STEP);
  };
  /** 空闲分批回放(2026-11-13 用户裁定「切会话先进视口,之前的内容再平滑补齐,不要卡」):
   *  入口窗口外的更早条目在空闲时分批挂载(批间让出主线程,单帧不超一批),expandAnchor 回钉
   *  保证每批挂载后用户视口纹丝不动;与手动「显示更早」/滚顶回放共用同一 visibleCount 计数器,
   *  天花板 RENDER_WINDOW_MAX(超出仍走手动/滚顶)。文档不可见(后台页签)暂停;追平即自然停 */
  useEffect(() => {
    if (!windowed) return; // 全量模型:无可补(浏览器路径)
    if (props.active === false) return; // 隐藏驻留座:零后台工作(切回时 active 变更重跑本 effect 续补)
    if (entries.length <= visibleCount) return;
    // 上限=min(600, 条数, 窗口目标):目标=挂载缓存窗或用户手动/滚顶回放抬升后的值——
    // 2026-11-17:缓存窗改成「后台补齐目标」后,重挂不再同步渲染整段历史
    const ceiling = Math.min(RENDER_WINDOW_MAX, entries.length, Math.max(windowTargetRef.current, visibleCount));
    if (visibleCount >= ceiling) return;
    let alive = true;
    const pump = (): void => {
      if (!alive) return;
      // 用户正在滚动的 400ms 窗口内不挂载(2026-11-13「滚动卡」):回放批虽小,穿插在滚动帧里
      // 仍会抢主线程;滚动停顿后再续,视口内内容始终优先
      const scrolledAt = lastScrollAtRef.current;
      if (document.visibilityState !== 'visible' || (scrolledAt > 0 && performance.now() - scrolledAt < 400)) { schedule(); return; }
      captureAnchor();
      setVisibleCount((v) => Math.min(v + RENDER_WINDOW_IDLE_STEP, ceiling));
    };
    const schedule = (): void => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { if (alive) pump(); }, { timeout: 150 });
      else window.setTimeout(() => { if (alive) pump(); }, 32);
    };
    schedule();
    return () => { alive = false; };
  }, [entries.length, visibleCount, chatScrollRef, props.active, windowed]);
  /** 窗口变更上抛(2026-11-17 窗口缓存链尾):回放/手动步进每拍上报,Chat 收 ref 镜像卸载随
   *  chatMem 写回——经 propsRef 取最新回调;挂载首拍也报(同值写回幂等) */
  useEffect(() => {
    propsRef.current.onRenderWindowChange?.(visibleCount);
  }, [visibleCount]);
  /** 入场动画闸(2026-11-25 停手抖动轮):.chat .entry 的 sx-entry-in(淡入+4px 上滑)原随
   *  .entry 节点全量生效——虚拟窗口切片换界会卸载再重挂块,重挂节点是新 DOM=动画重放,滑动
   *  时视口边上内容反复淡入+上滑=「一闪一闪」。改为只随「真正的新条目」:首渲染批次全部记已见
   *  不播(切会话打开不再整屏淡入),此后首挂才有 data-enter;已见过 key 的任何重挂=不重放 */
  const enteredRef = useRef<Set<string>>(new Set());
  const enteredPrimedRef = useRef(false);
  useEffect(() => { enteredPrimedRef.current = true; }, []);
  /** 挂载认领(UnitView 每实例问一次):true 仅当过了首帧 priming 且本 key 从未进过列表 */
  const claimEnter = useCallback((key: string): boolean => {
    if (!enteredPrimedRef.current) {
      enteredRef.current.add(key);
      return false;
    }
    if (enteredRef.current.has(key)) return false;
    enteredRef.current.add(key);
    return true;
  }, []);
  return (
    <main
      className="chat"
      aria-label="chat"
      ref={chatScrollRef}
      onClickCapture={onEntryToggleClick}
      onWheel={(e) => {
        landingRef.current = 0; // 用户接管滚动:立即终止落点收敛,不与其抢 scrollTop
        onWheel(e);
      }}
      onScroll={(e) => {
        lastScrollAtRef.current = performance.now();
        onScroll(e);
        maybeReplayEarlier();
        setReadingAnchor(); // 同步记锚(事件派发时布局已定):rAF 合并窗内若有高度提交,锚不是旧的
        scheduleViewport();
      }}
    >
        {/* 2026-10-26 对话刻度导航条:左侧 sticky 悬浮(不参与内容流),余量自适应显隐 */}
        <ChatRail entries={entries} chatScrollRef={chatScrollRef} sideChat={sideChat} onReveal={revealEntry} activeKeyAt={activeUserKeyAt} />
        {/* 空会话=对应欢迎页 hero(2026-11-17 用户裁定「去掉过时空态,空会话直接显示对应欢迎页」:
            标准会话=WelcomeLogo+欢迎标语(与欢迎页同件同尺),Sunx 会话=SunxMark 名片标+目标标语;
            通道会话=平台大图标+「新会话」(2026-11-22 用户裁定「改回欢迎页样式,图标随应用」——
            72px 平台图标占 logo 位,标语=新会话;首条消息后生成会话名,侧栏标题随之归位);
            原居中「给 Sunshinex 一个任务」旧空态(误读为加载态)退役;辅助对话面保留极简标示） */}
        {/* 空会话三态互斥排布(通道分支抽 ChannelEmpty 单件,免 IIFE):标准=欢迎 hero、
            Sunx=名片标、通道=平台大图标、辅助对话=极简标示(见下注) */}
        {entries.length === 0 && sideChat !== true && channelChat === true ? (
          <ChannelEmpty platform={channelPlatform} />
        ) : entries.length === 0 && sideChat !== true ? (
          <div className={`chat-empty chat-empty-welcome${sunxName !== undefined ? ' chat-empty-sunx' : ''}`} aria-label="chat empty">
            {sunxName !== undefined ? <SunxMark size={72} className="chat-empty-mark" /> : <WelcomeLogo />}
            <h1 className="welcome-tagline">
              {sunxName !== undefined ? t(`Give ${sunxName} a goal`, `给 ${sunxName} 一个目标`) : t('What should we do today?', '今天要做些什么？')}
            </h1>
          </div>
        ) : entries.length === 0 && sideChat === true ? (
          <div className="chat-empty" aria-label="chat empty">
            <div className="chat-empty-title">{t('Side chat', '辅助对话')}</div>
            <div className="chat-empty-hint">{t('Questions here do not affect the main task', '提问不影响主任务')}</div>
          </div>
        ) : null}
        {hiddenCount > 0 && (
          <button type="button" className="chat-earlier" onClick={() => showEarlier()}>
            {t(`Show ${hiddenCount} earlier entries`, `显示更早的 ${hiddenCount} 条`)}
          </button>
        )}
        {/* 会话流(2026-11-18 结构性改造):窗口内条目按「块」渲染——虚拟窗口只挂视口±overscan,
            上下 spacer 占位;jsdom 回退整窗逐块直渲(DOM=旧 DayGroupBlock 拼接结果) */}
        {virtual && <div className="chat-spacer" style={{ height: offsets[firstUnit] ?? 0 }} aria-hidden="true" />}
        {units.slice(firstUnit, lastUnit).map((u) =>
          virtual ? (
            <UnitView key={u.key} unit={u} render={renderUnit} unitRef={unitRefCb} claimEnter={claimEnter} />
          ) : (
            <Fragment key={u.key}>{renderUnit(u)}</Fragment>
          ),
        )}
        {virtual && (
          <div className="chat-spacer" style={{ height: Math.max(0, totalH - (offsets[lastUnit] ?? totalH)) }} aria-hidden="true" />
        )}
        {/* G14.52 运行状态行:常驻流区末行(圆圈+步数+tokens),轮次完成/停止即隐;
            原「尾参挂最后一个工具行」只在工具执行期可见且左缘随工具行缩进不齐——独立成行对齐 */}
        {running && (
          <div className="run-live-line" role="status" aria-label="run status">
            <span className="run-spinner" aria-hidden="true" />
            {usageOn && <span>{t(`${liveSteps} steps`, `${liveSteps} 步`)}</span>}
            {usageOn && <span>{fmtTokens(liveTokens)}</span>}
          </div>
        )}
    </main>
  );
}
