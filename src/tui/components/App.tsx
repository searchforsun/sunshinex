import { OptionSelector, filterOptions } from './OptionSelector';
import { t } from '../../i18n';
import * as React from 'react';
import { Box, Text, useStdout } from 'ink';
import useInput, { RawKey, keyTrace } from './use-input';
import { SessionController, TuiState } from '../session';
// J6 双源收敛：状态栏上下文分母经模型层单点解析（modelWindow ?? env ?? 0），渲染层不直读 env
import { resolveContextWindow } from '../chat-model';
import { SLASH_COMMANDS, slashCommandDescriptions } from '../slash-commands';
import { SlashMenu, SlashMenuEntry, SLASH_MENU_MAX_ROWS } from './SlashMenu';
import { initialRetained, RetainedUiState } from '../ui-state';
import { createTailLedger, TailLedger } from '../tail-rewrite';
import { segmentCount } from '../transcript-view';
import type { RepaintMode } from '../tui-loop';
import { BannerInfo, buildBannerInfo } from '../banner-info';
import { MessageList } from './MessageList';
import { InputBox } from './InputBox';
import { TodoList } from './TodoList';
import { StatusBar } from './StatusBar';
import { Spinner } from './Spinner';
import { ChildPanel } from './ChildPanel';
import { BrowseList } from './BrowseList';
import { ChildInspector } from './ChildInspector';
import { KeyHints, keyHintsFor } from './KeyHints';
import { useInspectKeys } from './use-inspect-keys';
import { useBrowseKeys, browseRows } from './use-browse-keys';
import { useQuestionKeys } from './use-question-keys';
import { useApprovalKeys, approvalKeyToDecision, approvalDecisionByIndex } from './use-approval-keys';
import { useLineEditKeys } from './use-line-edit';

// 审批键盘映射与选择器下标→裁决映射随按键分支迁至 use-approval-keys（D17-H2），此处 re-export
// 保住既有「from './App'」导入面（App.test 等纯函数单测）
export { approvalKeyToDecision, approvalDecisionByIndex };

/** 纵向命令面板技能源（session.skillMenuEntries 同构）：lastUsedAt 缺省=从未使用，排最尾部 */
interface SlashMenuSkillSource {
  id: string;
  name?: string;
  description?: string;
  lastUsedAt?: number;
}

/** 纵向命令面板条目装配（2026-09-30 对标 Claude Code，纯函数）：内置命令按 SLASH_COMMANDS 固定序在前、
 *  技能命令按最近使用降序（平局回落数字典序）在后，整池按 buffer（已 trim）前缀动态过滤；
 *  非 / 前缀或带参（含空格，trim 后前缀必失配）一律空表=菜单不出现 */
export function buildSlashMenu(buffer: string, skills: readonly SlashMenuSkillSource[] = []): SlashMenuEntry[] {
  const q = buffer.trim();
  if (!q.startsWith('/')) return [];
  const descs = slashCommandDescriptions();
  const builtins: SlashMenuEntry[] = SLASH_COMMANDS.map((cmd) => ({ cmd, description: descs[cmd.slice(1)] ?? '', kind: 'builtin' as const }));
  const skillEntries: SlashMenuEntry[] = [...skills]
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => ({ cmd: `/${s.id}`, description: s.description ?? '', kind: 'skill' as const }));
  return [...builtins, ...skillEntries].filter((e) => e.cmd.startsWith(q));
}

/** 输入框占位文案（按会话状态分流；纯函数便于断言） */
function inputPlaceholder(status: TuiState['status']): string {
  switch (status) {
    case 'awaiting-approval': return t('Awaiting approval: y approve once / a allow for session / n deny', '等待审批：y 放行一次 / a 本会话放行 / n 拒绝');
    case 'awaiting-plan': return t('Plan awaiting confirmation: y execute / n discard', '计划待确认：y 执行 / n 放弃');
    case 'awaiting-question': return t('Answer the question above: up/down move · space select · enter submit · esc dismiss', '请回答上方问题：↑/↓ 移动 · 空格选定 · 回车提交 · Esc 放弃');
    case 'running': return t('Running… (input will queue)', '运行中…（输入将排队）');
    case 'error': return t('Previous task failed; enter a new task to continue', '上次任务出错；输入新任务继续');
    default: return t('Type a task, Enter to send · /help for commands', '输入任务，Enter 发送 · /help 查看命令');
  }
}

/** 审批选择器选项（与 approvalKeyToDecision 同序：Approve once / Allow for session / Deny；运行期求值防 t() 冻结） */
export function approvalSelectorOptions(): { label: string; description?: string }[] {
  return [
    { label: t('Approve once', '放行一次'), description: t('approve this action', '仅本次放行') },
    { label: t('Allow for session', '本会话放行'), description: t('same subject will not ask again', '同主体后续不再询问') },
    { label: t('Deny', '拒绝'), description: t('esc also denies', 'Esc 同效') },
  ];
}

/** plan 确认选择器选项（首项=执行；Esc 同第二项放弃） */
function planSelectorOptions(): { label: string; description?: string }[] {
  return [
    { label: t('Execute plan', '执行计划'), description: t('run the steps above', '逐项执行上述计划') },
    { label: t('Keep planning (esc)', '放弃 (esc)'), description: t('discard and return to input', '放弃并回到输入态') },
  ];
}

/** filterable 卡视图派生单点（规格 D8；2026-09-30 用户裁决改口径）：恒全量直出——空词=全量列表，
 *  有词=子串过滤视图；超窗翻页由 OptionSelector 渲染层光标跟随滑窗承载（命令面板式自动翻页），
 *  不再有 More…/Back… 导航行与页码态。map[i]=视图第 i 行对应的 q.options 原下标 */
export function deriveFilterableView(
  full: Array<{ label: string; description?: string }>,
  query: string,
): { view: Array<{ label: string; description?: string }>; map: number[] } {
  return filterOptions(full, query);
}

/** 动态区预览行数上限（2026-09-30「贴地不再上提」）：总帧高 = chrome 实账 + 预览行数须 ≤ rows-1——
 *  ink3 outputHeight >= rows 即 clearTerminal 整屏重放（历史短于视口时输入框被提离贴地位）；
 *  4 行下限保底、28 行绝对上限（纯函数独立单测） */
export function computePreviewCap(rows: number, chromeRows: number): number {
  return Math.max(4, Math.min(28, rows - chromeRows - 1));
}

/** Ink 渲染层（纯渲染 + useInput 垫片键盘分发：垫片保留原始字节，退格/⌦ 经 key.raw 精确分流）：状态全量来自 controller 订阅；
 *  retain 为跨重挂现场（resize/Tab 重挂时输入现场与展开模式不丢）：挂载读初值，每次渲染后实时回写。
 *  键盘分发按模态判定序拆为五个 hook（D17-H2 技术债镜像重构，行为零变化）：use-inspect-keys（全屏查看）、
 *  use-browse-keys（子代理浏览）、use-question-keys（问询卡）、use-approval-keys（审批/plan 卡）、
 *  use-line-edit（输入行编辑与提交）——各 hook 收编专属状态与分支、handleKey 返回 true=已消费短路；
 *  共享状态（buffer/cursor/菜单条目等）由本组件持有并经参数注入；判定序全契约见下方 useInput 前置注释 */
export function App({
  controller,
  banner,
  retain,
  onRequestRepaint,
  onExit,
}: {
  controller: SessionController;
  banner?: BannerInfo;
  retain?: RetainedUiState;
  /** 宿主注入的「请求整屏重绘」出口（tui-loop 注入，带重绘模式）：'tail'（缺省 full）为尾部
   *  原位重写——段锚点折叠经此只重放变化尾部（2026-09-30 方案 A，闪屏消除） */
  onRequestRepaint?: (mode?: RepaintMode) => void;
  /** 空闲态 Ctrl+C 的退出请求出口（entry 注入优雅退出：flush→dispose→unmount→exit）；缺省无退出通道 */
  onExit?: () => void;
}): JSX.Element {
  const localRetain = React.useRef<RetainedUiState>(initialRetained());
  const store = retain ?? localRetain.current;
  // 打印账本（方案 A）：跨重挂经 store 存续（tui-loop 读 plan 定夺 tail 可达性）；挂载一次性消费
  // rewriteFrom 并截留账本——有值=尾部重写挂载（前缀槽位保留），无值=整屏重放（账本重建、forceFull 复位）
  const tailLedgerRef = React.useRef<TailLedger | undefined>(undefined);
  if (tailLedgerRef.current === undefined) {
    tailLedgerRef.current = store.tailLedger ?? createTailLedger();
    store.tailLedger = tailLedgerRef.current;
  }
  const [rewriteFrom] = React.useState<number | undefined>(() => {
    const v = store.rewriteFrom;
    store.rewriteFrom = undefined;
    const ledger = tailLedgerRef.current!;
    if (v === undefined) {
      ledger.slots = [];
      ledger.forceFull = false;
      ledger.plan = null;
    } else {
      ledger.slots.length = v;
    }
    return v;
  });
  const [state, setState] = React.useState<TuiState>(controller.getState());
  // AskQuestion 问询卡：选择器/勾选/自由输入/筛选词状态与按键分支收编于 useQuestionKeys（D17-H2 模态拆件，行为零变化）
  const { qCursor, qPicked, qCustom, qText, qFilter, handleKey: handleQuestionKey } = useQuestionKeys({ controller, question: state.question });
  // 审批/plan 选择器：光标状态、转入归位与两卡按键分支收编于 useApprovalKeys（D17-H2 模态拆件，行为零变化）
  const { aCursor: aCursorState, pCursor: pCursorState, handleKey: handleApprovalKey } = useApprovalKeys({ controller, status: state.status });
  const [buffer, setBuffer] = React.useState(store.buffer);
  const [cursor, setCursor] = React.useState(store.cursor);
  // 两层展开视图（Tab/Ctrl+O 正交，均经 tui-loop 卸载→清屏→重挂整屏重放，视口永远只有一份历史）：
  // expandAll=第一层行折叠开关，缺省 true=全行展开（2026-09-30 用户裁决：主链运行中不自动折叠工具行、
  // 折叠重写即闪屏源，是否折叠由用户 Tab 决定——Tab 翻转进入折叠形态）；
  // latestFull=第二层内容深度（当前一个轮次的所有工具与思考行全文 ↔ 摘要，详情缺省摘要）；无状态门槛，运行中随时可切
  const [expandAll, setExpandAll] = React.useState(store.expandAll ?? true);
  const [latestFull, setLatestFull] = React.useState(store.latestFull ?? false);
  // 待办展开开关（2026-10-01 用户裁决「运行过程中点 Tab 展开 todolist」）：运行中默认折叠单行，
  // Tab 翻转全量清单；经 retain 跨重挂保留（Tab 触发尾部重挂，不存即重挂打回折叠）
  const [todoExpanded, setTodoExpanded] = React.useState(store.todoExpanded ?? false);
  // 键分发 ref 真值（对标 qCursor/browseCursorRef 先例）：子面板更新走 notifyThrottled 节流，
  // 处理器闭包的 state 可能滞后节流一拍，浏览器序列构造必须读 ref 不读闭包
  const stateRef = React.useRef(state);
  stateRef.current = state;
  // 全屏查看模式（规格 §3.3）：状态与按键分支收编于 useInspectKeys（D17-H2 模态拆件，行为零变化）
  const { inspect, inspectExpanded, inspectRef, setInspectRetained, handleKey: handleInspectKey } = useInspectKeys({ controller, stateRef, store, onRequestRepaint });
  // 子代理浏览模式（Ctrl+B）：状态与按键分支（含 Ctrl+B 进入）收编于 useBrowseKeys（D17-H2 模态拆件，行为零变化）
  const { browseMode, browseCursor, browseModeRef, handleKey: handleBrowseKey } = useBrowseKeys({ controller, stateRef, store, enterInspect: setInspectRetained });
  // 技能命令池快照（规格 D6/D7）：会话层 skillMenuEntries 同源（附描述与最近使用）；挂载即读 + 回合边界
  // （sessionTurns 变化）刷新，不逐键读盘——最近使用排序在会话层 loadSkill 落盘后下回合生效
  const [skillMenu, setSkillMenu] = React.useState<SlashMenuSkillSource[]>(() => controller.skillMenuEntries());
  React.useEffect(() => {
    setSkillMenu(controller.skillMenuEntries());
  }, [controller, state.metrics.sessionTurns]);
  // 纵向命令面板光标（2026-09-30 对标 CC）：ref 真值 + state 渲染（useInput 处理器闭包滞后先例）；
  // buffer 变化（逐键过滤词变）即归位首项——过滤语义下旧光标位置无意义
  const [slashCursorState, setSlashCursorState] = React.useState(0);
  const slashCursorRef = React.useRef(0);
  const setSlashCursor = (v: number): void => { slashCursorRef.current = v; setSlashCursorState(v); };
  React.useEffect(() => { setSlashCursor(0); }, [buffer]);
  // 纵向命令面板条目（2026-09-30 对标 CC）：'/' 前缀动态过滤（含技能池，最近使用在前）；
  // 在场性=条目非空 + idle/error（与旧横向提示行同门槛）
  const menuEntries = React.useMemo(() => buildSlashMenu(buffer, skillMenu), [buffer, skillMenu]);
  const slashPool = React.useMemo(() => buildSlashMenu('/', skillMenu).map((e) => e.cmd), [skillMenu]);
  // 输入行编辑：Home/End/⌦/光标/菜单↑↓/撤回排队/历史↑↓/换行/Enter/退格/插入分支与 history/histIdx 状态
  // 收编于 useLineEditKeys（D17-H2 模态拆件，行为零变化；buffer/cursor 等共享状态经参数传入不复制）
  const { history, histIdx, setHistIdx, handleKey: handleLineEditKey } = useLineEditKeys({
    controller,
    buffer,
    cursor,
    setBuffer,
    setCursor,
    status: state.status,
    menuEntries,
    slashCursorRef,
    setSlashCursor,
    initialHistory: store.history,
    initialHistIdx: store.histIdx,
  });
  React.useEffect(() => controller.onState(() => setState({ ...controller.getState() })), [controller]);
  // 输入框回填（/rewind //fork，规格 §7）：锚点轮输入取回输入框可编辑重发；每帧检查、takeBackfill 幂等（无回填 no-op，无重渲染环）
  React.useEffect(() => {
    const b = controller.takeBackfill();
    if (b !== undefined) {
      setBuffer(b);
      setCursor(b.length);
    }
  });
  // 现场回写：无依赖数组——每次渲染后同步最新值到 retain，重挂前的最后一帧即最新现场
  React.useEffect(() => {
    store.buffer = buffer;
    store.cursor = cursor;
    store.expandAll = expandAll;
    store.latestFull = latestFull;
    store.todoExpanded = todoExpanded;
    store.browseMode = browseMode;
    store.browseCursor = browseCursor;
    store.history = history;
    store.histIdx = histIdx;
  });
  // Tab 模式切换 → 请求整屏重绘：本 effect 晚于回写 effect 执行（声明序），卸载前 retain 已持新值，
  // 重挂的 renderOnce 读到的就是切换后的模式；首次挂载不触发（本来就渲染一次）
  const expandAllInitRef = React.useRef(false);
  React.useEffect(() => {
    if (!expandAllInitRef.current) {
      expandAllInitRef.current = true;
      return;
    }
    // Tab/Ctrl+O 折叠切换走 tail 模式（2026-09-30「折叠闪频」）：清屏整屏重放在无 DEC 2026 的
    // WT 上即清屏空白帧（轻微闪频实锤）；tail 原位重写带可达性判定——变化尾部在视口内（Ctrl+O
    // 当前轮详情、近期历史折叠）就地擦写零闪屏，超出视口自动回落 full（安全降级）
    onRequestRepaint?.('tail');
  }, [expandAll, latestFull]);
  // 段锚点自动重绘：段数变化即新锚点落定。段数经 segmentCount 单点（与 buildTranscriptDecisions 同一
  // 切段谓词——两份手写曾漂移：system 行计段与否）。折叠判定改打印账本精确比对（2026-09-30 方案 A，
  // 取代旧 segHasProcess 启发式）：「屏上已打印形态 vs 当前决策」有失配即有可收拢内容——经 tail 模式
  // 只重放变化尾部（tui-loop 按可达性就地擦写或回落全量）；无失配即零重绘；400ms 防抖合并锚点连发
  const segInitRef = React.useRef(false);
  const segCountRef = React.useRef(0);
  const segDebounceRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => {
    const segCount = segmentCount(state.messages);
    const changed = segInitRef.current && segCount !== segCountRef.current;
    segInitRef.current = true;
    segCountRef.current = segCount;
    // 全屏/浏览态跳过段锚点重绘（2026-09-28 用户裁决）：动态区自绘面在场时整屏拆挂即持续闪屏、
    // 且重挂空窗吞 Esc/↑↓ 按键；账本照记，退出后从真实基线起算零虚触发
    if (inspectRef.current || browseModeRef.current) return;
    if (!changed) return;
    const ledger = tailLedgerRef.current!;
    if (ledger.forceFull) {
      // 不可数形态（SPAWN 展开转录等）：回落全量路径
      if (segDebounceRef.current) clearTimeout(segDebounceRef.current);
      segDebounceRef.current = setTimeout(() => {
        segDebounceRef.current = undefined;
        onRequestRepaint?.();
      }, 400);
      return;
    }
    if (ledger.plan === null) return; // 精确无失配：零重绘
    if (segDebounceRef.current) clearTimeout(segDebounceRef.current);
    segDebounceRef.current = setTimeout(() => {
      segDebounceRef.current = undefined;
      onRequestRepaint?.('tail');
    }, 400);
  }, [state.messages]);
  const info = React.useMemo(() => banner ?? buildBannerInfo(), [banner]);
  const columns = useStdout().stdout?.columns ?? 80;
  const rows = useStdout().stdout?.rows ?? 24; // 全屏查看视口高度（规格 §3.3 有界=终端行数）
  // 动态区 chrome 行数实账：输入框（多行缓冲随行数涨）/待办（运行中折叠单行、其余态展开全量）——
  // 纵向命令面板窗口上限（menuMaxRows）随视口收缩的计行输入
  const inputRows = 2 + Math.max(1, buffer.split('\n').length);
  // 待办行与 Tab 折叠解耦（2026-09-30）：运行中恒折叠单行（动态帧高度纪律，Tab 语义收敛为转录行折叠），其余态展开全量
  // 待办行（2026-10-01 用户裁决「运行过程中点 Tab 展开 todolist」）：缺省运行中折叠单行，todoExpanded
  // 翻转全量（tabExpanded 计入 chrome 实账，previewCap 随之收缩、帧高有界不触顶）
  const todoRows = state.todos.length > 0 ? (state.status === 'running' && !todoExpanded ? 1 : state.todos.length + 1) : 0;
  // 菜单可见行数：上限 20，随视口与 chrome（输入框/待办/状态栏）实账收缩，防动态帧触顶整屏重写
  const menuMaxRows = Math.max(3, Math.min(SLASH_MENU_MAX_ROWS, rows - inputRows - todoRows - 3));
  // 动态帧总高实账（2026-09-30 用户裁决「贴地不再上提」）：ink3 在 outputHeight >= rows 时 clearTerminal
  // 整屏重放（node_modules/ink/build/ink.js onRender），历史短于视口时输入框被「提」离贴地位、长历史则整屏闪烁——
  // 预览行数上限按 chrome 实账收缩（活动行/输入框/待办/子代理面板/状态栏 + 预览 marginBottom 与 … 行预算），
  // 帧高恒 ≤ rows-1，clearTerminal 路径结构性不可达
  const spinnerRows = state.status === 'running' ? 1 : 0;
  const runningChildren = state.children.filter((c) => !c.done).length;
  const childPanelRows = runningChildren > 0 && !browseMode ? runningChildren + 2 : 0; // ChildPanel round 边框上下各 1
  // 恒驻键提示条（2026-10-02）：所有交互处的快捷键单点承载——矩阵见 keyHintsFor；恒 1 行计入
  // previewCap chrome 实账（不实账即帧高触顶 clearTerminal，子代理视图冻结同病根）；模态卡在场
  // hints=undefined 条退场（卡 hint 承载，零行）
  const hints = keyHintsFor({
    status: state.status,
    approval: state.approval,
    question: state.question,
    pauseConfirm: state.pauseConfirm,
    browse: browseMode,
    inspect: inspect !== undefined,
    inspectLive: inspect?.kind === 'live',
    menuVisible: menuEntries.length > 0 && (state.status === 'idle' || state.status === 'error'),
    hasChildren: runningChildren > 0,
  });
  const hintRows = hints ? 1 : 0;
  const previewCap = computePreviewCap(rows, spinnerRows + inputRows + todoRows + childPanelRows + hintRows + 1 /* StatusBar */ + 2 /* 预览 marginBottom + … 行 */);
  // 模态卡优先（规格 §6）：审批/计划/问询卡在场即自动退出全屏，让位模态交互
  React.useEffect(() => {
    if (inspectRef.current && (state.approval || state.question || state.status === 'awaiting-plan')) setInspectRetained(undefined);
  });
  // live→archived 换挡（真机「查看中子代理完成：任务名/步数/耗时全消失、仍显运行态 ✻ []」）：被查看的
  // live 子代理完成即经 archiveInto 从 children 离场、转录折进 SPAWN 调用行——inspect 滞留 live 形态则
  // 下一帧 child/archived 双空。此处按基名回查 SPAWN 归档行并切换 inspect 至 archived 形态。配对口径与
  // browseRows 同源：调用行文本 `SPAWN <基名>` 精确等值（#N 并发消歧后缀只在子代理事件侧，调用行恒基名，
  // 剥除后匹配；同名并发批无法精确到 seq，取最后归档一条）。必须走 setInspectRetained 生产 repaint 整屏
  // 重放：Static append-only，原地换数据源只会把归档时间线整段重复追加进滚动缓冲（Static 状态切换必须
  // 整屏重放的既定裁决）；换挡出 setTimeout 0——unmount 不能在 React effect 冲刷期同步执行
  React.useEffect(() => {
    const cur = inspectRef.current;
    if (cur?.kind !== 'live') return;
    if (stateRef.current.children.some((c) => c.label === cur.label)) return;
    const base = cur.label.replace(/#\d+$/, '');
    const cands = stateRef.current.messages.filter(
      (m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.detail !== undefined && m.text === `SPAWN ${base}`,
    );
    const target = cands[cands.length - 1];
    if (target === undefined) return;
    const timer = setTimeout(() => {
      // 用户在窗口期 Esc 退出或切到别处即放弃换挡（inspect 引用不同一），不复活全屏
      if (inspectRef.current === cur) setInspectRetained({ kind: 'archived', seq: target.seq });
    }, 0);
    return () => clearTimeout(timer);
  });
  const fq = state.question?.filterable ? deriveFilterableView(state.question.options, qFilter) : undefined;

  /* ── 键盘模态判定序契约（D17-H2 显式化：原九层 if 单闭包的隐式截获序，拆 hook 后必须保持不变）──
   * 1. inspect 全屏查看（use-inspect-keys，在场恒吞键）：Ctrl+C=live 两段停【此子代理】/archived 撤暂停卡；
   *     Esc=暂停卡在场先撤卡、无卡才退视图；Tab=时间线折叠↔完整两态；其余键吞掉
   * 2. browse 浏览态（use-browse-keys，在场恒吞键）：列表空自退；Esc 退浏览；↑↓ moveCursor 回环；
   *     Enter=running 行进 live 全屏/archived 行进回看，随后退浏览；Ctrl+C=退浏览+两次确认暂停
   * 3. Ctrl+B 进入浏览（use-browse-keys）：无状态门槛、位于问询卡之前，恒吞键（无可进列表亦吞）
   * 4. 问询卡 awaiting-question（use-question-keys，模态恒吞键，Esc 不回落清缓冲）：filterable 卡
   *     （Ctrl+C 弃+断；Esc 两段=有词清词/无词弃；⌫删词；↑↓ 滤后视图回环；Enter/Space 经 map 落原下标
   *     提交；可打印进筛选词）→ qCustom 自由输入态（Esc 返回；Enter 提交 custom；⌫删字；可打印追加）
   *     → 普通卡（Ctrl+C 弃+断；Esc 弃；↑↓；Enter/Space（customIndex=切自由输入）；数字 1-9 窗口内快选）
   * 5. Ctrl+C 全局分流（App 保留）：暂停卡二段真中断 → running 挂暂停卡 → interrupt 可达即中断 →
   *     空闲输入非空=清空缓冲+历史指针复位 -1 → 空闲输入空=请求退出
   * 6. Esc 全局分流（App 保留）：暂停卡撤卡 → interrupt 可达即中断 → 输入非空=清空（空输入无操作，不退出）
   * 7. 审批卡 awaiting-approval（use-approval-keys，模态恒吞键）：y/a/n 快捷；Esc=deny；↑↓；
   *     Space/Enter=光标行裁决；数字 1-3 快选
   * 8. plan 卡 awaiting-plan（use-approval-keys，模态恒吞键）：y/n；Esc=放弃；↑↓；Space/Enter；1-2 快选
   * 9. Tab 分流（App 保留）：/ 前缀=斜杠补全（exact 词池内循环邻位+空格 / 补面板选中项+空格）；
   *     否则=expandAll+todoExpanded 同步翻转（store 先写）并 recordView
   * 10. Ctrl+O（App 保留）：latestFull 内容深度翻转并 recordView
   * 11. 输入行编辑（use-line-edit，判定序终点，到达即终结）：Home/End/⌦ CSI 序列 → Ctrl+A/E 双轨 → ←→
   *     → 菜单在场（idle/error）↑↓ 接管 → running 空缓冲 ↑=撤回排队 → idle/error 单行缓冲 ↑↓=历史回填
   *     → Shift/Alt+Enter（含 kitty CSI-u）=框内换行 → Enter（菜单提交选中 / 行尾单反斜杠续行 / 整行提交）
   *     → ⌫退格（\u001B[3~ 前向删除）→ 可打印字符插入
   * 不变量：模态卡（1-4、7-8）在场即吞键不落输入缓冲；Ctrl+C/Esc 在 5/6 位才具备全局语义；
   * buffer/cursor 等共享状态由 App 持有、经参数注入各 hook，单一真值不复制 */
  useInput((input: string, key: RawKey) => {

    // 判定序第 1 位：全屏查看模式（规格 §3.3）——最前置接管，在场恒吞键（分支与状态收编 use-inspect-keys）
    if (handleInspectKey(input, key)) return;

    // 判定序第 2/3 位：子代理浏览模式（browse 在场短接管 ↑/↓/Enter/Esc 恒吞键）与 Ctrl+B 进入
    //（分支与状态收编 use-browse-keys；进入分支须在问询卡之前——既有判定序原样）
    if (handleBrowseKey(input, key)) return;

    // 判定序第 4 位：AskQuestion 问询卡（AskQuestion 线 T2）——模态接管键盘恒吞键（三分支与专属状态收编
    // use-question-keys）；分支置于全局键之前（Esc 在此不回落清缓冲）
    if (state.status === 'awaiting-question' && state.question) {
      handleQuestionKey(state.question, input, key);
      return;
    }
    // 判定序第 5 位：Ctrl+C 分流（2026-10-02 用户裁决「两次 Ctrl+C 确认暂停」，简化版=一行提示非模态卡）：
    // 运行中第一次挂提示（任务不停），已挂提示再按=真正中断（主链连带子代理）；
    // 其余等待态=中断；空闲且输入非空=清空输入；空闲且输入空=请求退出
    if (key.ctrl && input === 'c') {
      if (stateRef.current.pauseConfirm) { keyTrace('main pause-interrupt'); controller.interrupt(); return; }
      if (stateRef.current.status === 'running') { keyTrace('main pause-hang'); controller.requestPause(); return; }
      if (controller.interrupt()) return;
      if (buffer.length > 0) {
        setBuffer('');
        setCursor(0);
        setHistIdx(-1); // 历史指针复位（2026-10-02 交互统一）：清空即回「下次 ↑ 取最新」，不残留召回位
        return;
      }
      onExit?.();
      return;
    }
    // 判定序第 6 位：Esc 同源分流：暂停确认卡在场=撤卡继续；运行/等待态=中断；空闲且有输入=清空输入（空闲空输入不退出）
    if (key.escape) {
      if (stateRef.current.pauseConfirm) { keyTrace('main pause-cancel'); controller.cancelPause(); return; }
      if (controller.interrupt()) return;
      if (buffer.length > 0) {
        setBuffer('');
        setCursor(0);
        setHistIdx(-1); // 历史指针复位（同 Ctrl+C 清空口径）
      }
      return;
    }
    // 判定序第 7/8 位：审批卡与 plan 确认卡——模态接管键盘恒吞键（分支与光标状态收编 use-approval-keys）
    if (handleApprovalKey(input, key)) return;

    // 判定序第 9 位：Tab 分流：/ 前缀 → 斜杠补全；否则切换「会话历史展开模式」（Claude Code ctrl+o 同款：清屏后按全展开/折叠
    // 形态整屏重放，视口永远只有一份历史）——无模态态，↑↓ 永远归输入历史，运行中随时可切
    if (key.tab) {
      if (buffer.startsWith('/')) {
        // 2026-09-30 纵向面板语义：已 exact（完整命令词）→ 池内循环下一位 + 空格（既有邻位钉不动）；
        // 否则补全到面板当前选中项 + 空格（对标 CC：↑↓ 选中的那一条，而非恒首项）
        const token = buffer.trim();
        const exactIdx = slashPool.indexOf(token);
        const target =
          exactIdx >= 0
            ? slashPool[(exactIdx + 1) % slashPool.length] + ' '
            : menuEntries.length > 0
              ? `${(menuEntries[Math.min(slashCursorRef.current, menuEntries.length - 1)] ?? menuEntries[0])!.cmd} `
              : undefined;
        if (target !== undefined) {
          setBuffer(target);
          setCursor(target.length);
        }
      } else {
        // 第一层切换（行折叠）：翻转后经重挂整屏重放（Static 按新形态整体重建，视口永远只有一份），运行中随时可切
        const nextExpand = !expandAll;
        // 待办展开同步翻转（2026-10-01 用户裁决「运行过程中点 Tab 展开 todolist」）：**store 先写**
        // （setBrowse 同款先例）——setExpandAll 的同步重渲染即触发 onRequestRepaint('tail') 卸载，
        // 其后排队的 setTodoExpanded 落在已卸载组件上被吞、回写 effect 永不再跑，store 残 false=
        // 重挂后待办仍折叠（真机「Tab 不展开」病根）；先同步写 store 再 setState 即卸载前已持新值
        const nextTodo = !todoExpanded;
        store.todoExpanded = nextTodo;
        setTodoExpanded(nextTodo);
        setExpandAll(nextExpand);
        controller.recordView(nextExpand, latestFull);
      }
      return;
    }

    // 判定序第 10 位：Ctrl+O：第二层切换（内容深度）——当前一个轮次（自最后一条 user 指令行起）的所有工具与思考行展开/收起为全文
    if (key.ctrl && input === 'o') {
      const nextFull = !latestFull;
      setLatestFull(nextFull);
      controller.recordView(expandAll, nextFull);
      return;
    }

    // 判定序第 11 位（终点）：输入行编辑与提交——Home/End/⌦/Ctrl+A/E、左右光标、斜杠菜单在场 ↑↓、
    // 运行中撤回排队 ↑、输入历史 ↑↓、Shift/Alt+Enter 换行、Enter（菜单提交/续行/整行提交）、退格与 ⌦、
    // 可打印插入（分支与 history/histIdx 状态收编 use-line-edit；到达即终结，恒 true）
    handleLineEditKey(input, key);
  });

  return (
    <Box flexDirection="column">
      {/* 全屏查看（规格 §3.3）：整屏接管——live 让位 + 历史区抑制（suppressHistory），全屏视图独占整页；
          MessageList 保持挂载，进入/退出经生产 repaint 重挂完成切换 */}
      <MessageList
        banner={info}
        messages={state.messages}
        live={inspect ? undefined : state.live}
        columns={columns}
        rows={rows}
        expandAll={expandAll}
        latestFull={latestFull}
        suppressHistory={!!inspect}
        ledger={tailLedgerRef.current}
        rewriteFrom={rewriteFrom}
        previewCap={previewCap}
      />
      {inspect ? (
        <>
        <ChildInspector
          child={inspect.kind === 'live' ? state.children.find((c) => c.label === inspect.label) : undefined}
          archived={
            inspect.kind === 'archived'
              ? (() => {
                  const m = state.messages.find((x) => x.seq === inspect.seq);
                  return m?.detail !== undefined
                    ? {
                        label: m.text.replace(/^\S+\s*/, '') || 'subagent',
                        lines: m.detail.split('\n'),
                        steps: m.subagentMeta?.steps,
                        durationMs: m.subagentMeta?.durationMs,
                        prompt: m.subagentMeta?.prompt,
                        tokens: m.subagentMeta?.tokens,
                      }
                    : undefined;
                })()
              : undefined
          }
          columns={columns}
          rows={rows}
          expanded={inspectExpanded}
        />
        {hints ? <KeyHints items={hints.items} columns={columns} /> : null}
        </>
      ) : (
        <>
      {state.status === 'running' ? (
        // 恒显活动行（对标 CC）：整个任务运行期常驻计时·tokens 跳动行，reasoning 长静默期与正文流式期均有「活着」信号，
        // 消除「疑似卡死」观感；responding 期与流式正文同屏共存
        <Spinner startedAt={state.metrics.turnStartedAt} tokens={state.metrics.turnTokens + state.metrics.turnChildTokens} phase={state.task.phase} calls={state.task.activeCalls} columns={columns} />
      ) : null}
      {browseMode ? (
        // 子代理统一列表（2026-09-28 用户裁决）：历史与运行中全部由动态区承载——合并序列单点口径
        // （运行中在前 + 已完成委派时间升序）、每页 8 行窗口、光标行反色，动态区每帧自绘 ↑↓ 可见移动零重挂
        <BrowseList key="browse-list" rows={browseRows(state)} cursor={browseCursor} />
      ) : null}
      {(state.children.length > 0 && !browseMode) ? (
        // 常态子代理面板（2026-09-28 统一口径）：只承载运行中；浏览态时运行中行由统一列表承载——
        // 同一子代理面板行与列表行双显属重复呈现（2026-09-28 真机双显 bug），浏览态面板整块让位
        <ChildPanel
          childrenState={state.children}
          columns={columns}
        />
      ) : null}
      {state.approval ? (
        <OptionSelector
          title={`${t('Approval', '审批')} ${state.approval.id} (${state.approval.kind})`}
          question={state.approval.subject}
          options={approvalSelectorOptions()}
          cursor={aCursorState}
          picked={[]}
          hint={t('y approve once · a allow for session · n deny · esc deny', 'y 放行一次 · a 本会话放行 · n 拒绝 · Esc 拒绝')}
        />
      ) : null}
      {state.status === 'awaiting-plan' ? (
        <OptionSelector
          title={t('Plan', '计划')}
          question={t('Execute this plan?', '执行这份计划？')}
          options={planSelectorOptions()}
          cursor={pCursorState}
          picked={[]}
          hint={t('y execute · n discard · esc discard', 'y 执行 · n 放弃 · Esc 放弃')}
        />
      ) : null}
      {state.question ? (
        <Box flexDirection="column">
          <OptionSelector
            question={state.question.question}
            options={fq ? fq.view : state.question.options}
            cursor={qCursor}
            picked={qPicked}
            multiple={state.question.multiple}
            filter={fq ? qFilter : undefined}
            indexMap={fq ? fq.map : undefined}
            title={t('AskQuestion', '问询')}
            hint={
              fq
                ? t('type to filter · enter submit · esc clear/cancel', '输入筛选 · 回车提交 · Esc 清词/取消')
                : qCustom
                  ? t('type your answer · enter submit · esc back to options', '输入回答 · 回车提交 · Esc 返回选项')
                  : undefined
            }
          />
          {qCustom ? (
            <Box paddingX={1}><Text>❯ {qText}▊</Text></Box>
          ) : null}
        </Box>
      ) : null}
      {/* 纵向命令面板（2026-09-30 对标 Claude Code，替换旧横向单行提示）：一行一命令 + 右侧描述、
          选中行反色（❯ + 灰底）、≤20 行窗口随光标翻页；条目=内置 + 技能（最近使用在前），随输入动态过滤；
          键盘：↑↓ 移动、Tab 补全选中、Enter 提交选中；仅 idle/error 在场（与旧提示行同门槛） */}
      {(state.status === 'idle' || state.status === 'error') && menuEntries.length > 0 ? (
        <SlashMenu
          key="slash-menu"
          entries={menuEntries}
          cursor={Math.min(slashCursorState, menuEntries.length - 1)}
          columns={columns}
          maxRows={menuMaxRows}
        />
      ) : null}
      {/* 恒驻键提示条（2026-10-02 用户裁决）：固定输入框上侧一行随状态切换——与输入动作紧耦合
          （对标 CC 提示位），有待办行时不再被挤远；banner 顶部快捷键行/浏览灰底行/暂停灰底行已退役
          归一到这一条（banner 行滚出视口即死提示）；模态卡在场 hints=undefined 条退场（卡 hint 承载） */}
      {hints ? <KeyHints items={hints.items} columns={columns} /> : null}
      <InputBox
        buffer={buffer}
        cursor={cursor}
        placeholder={inputPlaceholder(state.status)}
        active={state.status === 'idle' || state.status === 'error'}
      />
      <TodoList todos={state.todos} expanded={state.status !== 'running' || todoExpanded} columns={columns} />
      <StatusBar
        metrics={state.metrics}
        status={state.status}
        model={state.modelLabel ?? info.model}
        effort={state.effort}
        context={{ used: state.metrics.ctxUsed, window: resolveContextWindow(state) }}
      />
        </>
      )}
    </Box>
  );
}
