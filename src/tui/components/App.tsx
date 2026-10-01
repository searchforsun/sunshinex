import { moveCursor, OptionSelector, togglePick, filterOptions, SELECTOR_WINDOW } from './OptionSelector';
import type { AskUserRequest } from '../../types';
import { t } from '../../i18n';
import * as React from 'react';
import { Box, Text, useStdout } from 'ink';
import useInput, { RawKey } from './use-input';
import { ApprovalDecision } from '../../types';
import { SessionController, TuiState } from '../session';
import { SLASH_COMMANDS, slashCommandDescriptions } from '../slash-commands';
import { SlashMenu, SlashMenuEntry, SLASH_MENU_MAX_ROWS, slashMenuWindow } from './SlashMenu';
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

/** 审批键盘映射：y 放行一次 / a 本会话放行 / n 拒绝（纯函数，独立单测） */
export function approvalKeyToDecision(input: string): ApprovalDecision | undefined {
  if (input === 'y') return 'allow';
  if (input === 'a') return 'always';
  if (input === 'n') return 'deny';
  return undefined;
}

/** 斜杠命令清单（补全候选，顺序即 Tab 循环顺序）——唯一源在 ../slash-commands，此处重导出保持既有 import 路径 */
export { SLASH_COMMANDS };

/** 斜杠补全候选：按 buffer（已 trim）前缀匹配合并池（内置在前 + extra 技能命令池，规格 D7）；非 / 前缀或无匹配返回空 */
export function slashCandidates(buffer: string, extra: readonly string[] = []): string[] {
  const t = buffer.trim();
  if (!t.startsWith('/')) return [];
  return [...SLASH_COMMANDS, ...extra].filter((c) => c.startsWith(t));
}

/** Tab 斜杠补全推演（纯函数，规格 D7）：池内 exact → 池内下一位 + 空格（末位回环首位）；否则前缀候选首项 + 空格；无候选 undefined。缺省池=内置清单（与既有行为逐字节等价） */
export function nextSlashCompletion(buffer: string, pool: readonly string[] = SLASH_COMMANDS): string | undefined {
  const token = buffer.trim();
  if (!token.startsWith('/')) return undefined;
  const exactIdx = pool.indexOf(token);
  if (exactIdx >= 0) return pool[(exactIdx + 1) % pool.length] + ' ';
  const candidates = pool.filter((c) => c.startsWith(token));
  return candidates.length > 0 ? candidates[0] + ' ' : undefined;
}

/** 纵向命令面板技能源（session.skillMenuEntries 同构）：lastUsedAt 缺省=从未使用，排最尾部 */
export interface SlashMenuSkillSource {
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
export function inputPlaceholder(status: TuiState['status']): string {
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

/** 审批选择器下标 → 裁决值（渲染层提交映射单点，防两处漂移） */
export function approvalDecisionByIndex(idx: number): 'allow' | 'always' | 'deny' {
  return (['allow', 'always', 'deny'] as const)[idx] ?? 'deny';
}

/** plan 确认选择器选项（首项=执行；Esc 同第二项放弃） */
export function planSelectorOptions(): { label: string; description?: string }[] {
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

/** Home/End 终端转义序列体：ink3 不解析这些功能键，按 ESC 剥离前后的两种形态识别（xterm 与应用模式两族） */
const HOME_SEQS = ['[H', 'OH', '[1~', '[7~'];
const END_SEQS = ['[F', 'OF', '[4~', '[8~'];

/** Ink 渲染层（纯渲染 + useInput 垫片键盘分发：垫片保留原始字节，退格/⌦ 经 key.raw 精确分流）：状态全量来自 controller 订阅；
 *  retain 为跨重挂现场（resize/Tab 重挂时输入现场与展开模式不丢）：挂载读初值，每次渲染后实时回写 */
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
  // AskQuestion 选择器本地态：ref 为输入真值（useInput 处理器经 effect 重挂存在闭包滞后），state 只承载渲染
  const [qCursor, setQCursorState] = React.useState(0);
  const [qPicked, setQPickedState] = React.useState<number[]>([]);
  const [qCustom, setQCustomState] = React.useState(false);
  const [qText, setQTextState] = React.useState('');
  const qCursorRef = React.useRef(0);
  const qPickedRef = React.useRef<number[]>([]);
  const qCustomRef = React.useRef(false);
  const qTextRef = React.useRef('');
  const setQCursor = (v: number): void => { qCursorRef.current = v; setQCursorState(v); };
  const setQPicked = (v: number[]): void => { qPickedRef.current = v; setQPickedState(v); };
  const setQCustom = (v: boolean): void => { qCustomRef.current = v; setQCustomState(v); };
  const setQText = (v: string): void => { qTextRef.current = v; setQTextState(v); };
  // filterable 卡筛选态（规格 D6/D7）：筛选词 ref 真值 + state 渲染，随新问询卡归位清零
  // （2026-09-30 用户裁决：翻页改命令面板式光标跟随滑窗，页码态退役——OptionSelector 渲染层承载）
  const [qFilter, setQFilterState] = React.useState('');
  const qFilterRef = React.useRef('');
  const setQFilter = (v: string): void => { qFilterRef.current = v; setQFilterState(v); };
  // 审批/plan 选择器光标（T3 迁移）：ref 真值 + state 渲染；状态转入时归位首项
  const [aCursorState, setACursorState] = React.useState(0);
  const aCursorRef = React.useRef(0);
  const setACursor = (v: number): void => { aCursorRef.current = v; setACursorState(v); };
  const [pCursorState, setPCursorState] = React.useState(0);
  const pCursorRef = React.useRef(0);
  const setPCursor = (v: number): void => { pCursorRef.current = v; setPCursorState(v); };
  const statusRef = React.useRef(state.status);
  React.useEffect(() => {
    if (state.status !== statusRef.current) {
      if (state.status === 'awaiting-approval') setACursor(0);
      if (state.status === 'awaiting-plan') setPCursor(0);
      statusRef.current = state.status;
    }
  }, [state.status]);
  const qRef = React.useRef<AskUserRequest | undefined>(undefined);
  React.useEffect(() => {
    if (state.question && state.question !== qRef.current) {
      qRef.current = state.question;
      setQCursor(0);
      setQPicked([]);
      setQCustom(false);
      setQText('');
      setQFilter('');
    }
    if (!state.question && qRef.current) qRef.current = undefined;
  }, [state.question]);
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
  // 子代理浏览模式（Ctrl+B）：本地态 + ref 真值（useInput 处理器经 effect 重挂存在闭包滞后，对标 qCursor 先例）；
  // 两态经 retain 跨重挂保留——repaint effect 依赖含 browseMode（行高亮须 Static 整屏重放），不在 retain 则
  // 一按 Ctrl+B 即卸载重挂、浏览态丢失（真机「按 Ctrl+B 挂死」观感）；旧 retain 快照缺字段回落关闭态
  const [browseMode, setBrowseMode] = React.useState(store.browseMode ?? false);
  const browseModeRef = React.useRef(store.browseMode ?? false);
  const [browseCursor, setBrowseCursor] = React.useState(store.browseCursor ?? 0);
  const browseCursorRef = React.useRef(store.browseCursor ?? 0);
  const setBrowse = (mode: boolean, cursor = 0): void => {
    browseModeRef.current = mode;
    browseCursorRef.current = cursor;
    // store 同步先于 setState（对标 setInspectRetained）：browse→inspect 切换经 onRequestRepaint 同步卸载，
    // 本帧「现场回写」effect 永不再跑（setBrowse(false) 的提交被卸载吞掉），不同步写即重挂后 browseMode
    // 残留 true——全屏态叠加浏览态吞键（真机「Tab/Esc 须先按 Enter 才生效」病根）
    store.browseMode = mode;
    store.browseCursor = cursor;
    setBrowseMode(mode);
    setBrowseCursor(cursor);
  };
  // 全屏查看模式（规格 §3.3）：live=运行中子代理（实时流式）、archived=已归档 spawn 调用行（detail 回看）；
  // ref 真值同 browse 先例（useInput 处理器闭包滞后），在场时整页让位（MessageList 保持挂载 live 让位零 Static 重放）
  const [inspect, setInspect] = React.useState<{ kind: 'live'; label: string } | { kind: 'archived'; seq: number } | undefined>(store.inspect);
  // 全屏查看 Tab 两态（2026-09-28 用户裁决：完整时间线缺省，Tab 收起为正文形态）——经 retain 跨重挂保留，
  // 与 browseMode 同款「动态区自绘零重挂」承载，inspect 进入时复位为完整时间线
  const [inspectExpanded, setInspectExpanded] = React.useState<boolean>(store.inspectExpanded ?? false);
  const inspectExpandedRef = React.useRef(inspectExpanded);
  inspectExpandedRef.current = inspectExpanded;
  const inspectRef = React.useRef(inspect);
  inspectRef.current = inspect;
  const setInspectRetained = (v: typeof inspect): void => {
    inspectRef.current = v;
    store.inspect = v;
    setInspect(v);
    setInspectExpanded(false); // 每次进入复位折叠态（缺省态，对标主 agent 折叠位；store 同步防重挂回旧值）
    store.inspectExpanded = false;
    // 整屏接管切换（进入/退出各一次）：经生产 repaint 路径卸载→同 retain 重挂——重挂后历史区按
    // suppressHistory 置空/恢复，全屏视图独占整页不与主 agent 历史拼接（2026-09-27 用户裁决）
    onRequestRepaint?.();
  };
  // 键分发 ref 真值（对标 qCursor/browseCursorRef 先例）：子面板更新走 notifyThrottled 节流，
  // 处理器闭包的 state 可能滞后节流一拍，浏览器序列构造必须读 ref 不读闭包
  const stateRef = React.useRef(state);
  stateRef.current = state;
  /** Ctrl+B 浏览序列单点（2026-09-28 统一口径）：运行中子代理在前（启动序）+ 已完成 spawn 按 subagentMeta.delegatedAt
   *  委派时间升序在后（旧档字段缺省回落 seq 序）——↑↓ 键盘分发与动态区列表渲染共用同一函数，两侧永不漂移 */
  const browseRows = (st: TuiState): { id: string; label: string; running?: boolean; seq?: number; meta?: TuiState['messages'][number]['subagentMeta'] }[] => [
    ...st.children.filter((c) => !c.done).map((c) => ({ id: `live:${c.label}`, label: c.label, running: true as const })),
    ...st.messages
      .filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.subagentMeta)
      .map((m) => ({ id: `archived:${m.seq}`, label: m.text.replace(/^SPAWN /, ''), seq: m.seq, meta: m.subagentMeta }))
      .sort((a, b) => (a.meta?.delegatedAt ?? a.seq!) - (b.meta?.delegatedAt ?? b.seq!)),
  ];
  const [history, setHistory] = React.useState<string[]>(store.history);
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
  const [histIdx, setHistIdx] = React.useState(store.histIdx);
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
  // 纵向命令面板条目（2026-09-30 对标 CC）：'/' 前缀动态过滤（含技能池，最近使用在前）；
  // 在场性=条目非空 + idle/error（与旧横向提示行同门槛）
  const menuEntries = React.useMemo(() => buildSlashMenu(buffer, skillMenu), [buffer, skillMenu]);
  const slashPool = React.useMemo(() => buildSlashMenu('/', skillMenu).map((e) => e.cmd), [skillMenu]);
  // 菜单可见行数：上限 20，随视口与 chrome（输入框/待办/状态栏）实账收缩，防动态帧触顶整屏重写
  const menuMaxRows = Math.max(3, Math.min(SLASH_MENU_MAX_ROWS, rows - inputRows - todoRows - 3));
  // 动态帧总高实账（2026-09-30 用户裁决「贴地不再上提」）：ink3 在 outputHeight >= rows 时 clearTerminal
  // 整屏重放（node_modules/ink/build/ink.js onRender），历史短于视口时输入框被「提」离贴地位、长历史则整屏闪烁——
  // 预览行数上限按 chrome 实账收缩（活动行/输入框/待办/子代理面板/状态栏 + 预览 marginBottom 与 … 行预算），
  // 帧高恒 ≤ rows-1，clearTerminal 路径结构性不可达
  const spinnerRows = state.status === 'running' ? 1 : 0;
  const runningChildren = state.children.filter((c) => !c.done).length;
  const childPanelRows = runningChildren > 0 && !browseMode ? runningChildren + 2 : 0; // ChildPanel round 边框上下各 1
  const previewCap = computePreviewCap(rows, spinnerRows + inputRows + todoRows + childPanelRows + 1 /* StatusBar */ + 2 /* 预览 marginBottom + … 行 */);
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

  useInput((input: string, key: RawKey) => {

    // 全屏查看模式（规格 §3.3）：最前置接管——Esc 退出恢复主界面，Tab 切「折叠 ↔ 完整时间线」两态
    //（2026-09-29 Static 时间线化后经生产 repaint 整屏重放，对标主 agent Tab；store 持久化跨重挂保留），
    // 其余键吞掉不落输入缓冲（纯只读视图，不支持再次会话）
    if (inspectRef.current) {
      // Ctrl+C 暂停确认（2026-10-02 用户裁决）：子代理全屏视图内两次 Ctrl+C 同主视图口径——
      // 第一次挂卡（任务不停），再按即确认中断（主链连带子代理）；此前该分支吞键致运行中无法暂停
      if (key.ctrl && input === 'c') {
        if (stateRef.current.pauseConfirm) { controller.interrupt(); return; }
        controller.requestPause();
        return;
      }
      if (key.escape) { setInspectRetained(undefined); return; }
      if (key.tab) {
        const next = !inspectExpandedRef.current;
        inspectExpandedRef.current = next;
        store.inspectExpanded = next;
        setInspectExpanded(next);
        onRequestRepaint?.();
        return;
      }
      return;
    }

    // 子代理浏览模式（Ctrl+B 进入）：短接管 ↑/↓/Enter/Esc；其余按键一律吞掉不落输入缓冲。
    // 光标与模式取 ref 真值（处理器经 effect 重挂存在闭包滞后，对标 qCursor 先例）；仅 idle/error 可进入。
    if (browseModeRef.current) {
      // 统一子代理浏览器（2026-09-28 用户裁决：历史与运行中全部由动态区承载）：合并序列单点口径——
      // 运行中子代理在前 + 已完成 spawn 委派时间升序在后；常态 ChildPanel 只显运行中，浏览列表两类行统一呈现
      const st = stateRef.current;
      const rows = browseRows(st);
      if (rows.length === 0) { setBrowse(false); return; }
      const clamp = (n: number): number => Math.max(0, Math.min(rows.length - 1, n));
      if (key.escape) { setBrowse(false); return; }
      if (key.upArrow || key.downArrow) {
        // 光标移动零 repaint（选中列表动态区每帧自绘）；窗口按每页 8 行自动平移（BrowseList 同口径）
        setBrowse(true, clamp(browseCursorRef.current + (key.upArrow ? -1 : 1)));
        return;
      }
      if (key.return) {
        const row = rows[clamp(browseCursorRef.current)];
        if (row?.running) {
          // 运行中 → 进入全屏实时视图（规格 §3.3）
          setInspectRetained({ kind: 'live', label: row.label });
        } else if (row?.seq !== undefined) {
          // 已完成 → 进入全屏回看（detail 派生）
          setInspectRetained({ kind: 'archived', seq: row.seq });
        }
        setBrowse(false);
        return;
      }
      // Ctrl+C：退出浏览并走暂停确认（同主视图两次 Ctrl+C 口径——浏览态原语义只退浏览不暂停，运行中暂停在此不可达）
      if (key.ctrl && input === 'c') {
        setBrowse(false);
        if (stateRef.current.pauseConfirm) controller.interrupt();
        else controller.requestPause();
        return;
      }
      return;
    }
    // Ctrl+B 进入统一子代理浏览器：运行中子代理或已完成 spawn 任一在场即可；state 读 ref 真值
    if (key.ctrl && input === 'b') {
      const st = stateRef.current;
      const rows = browseRows(st);
      if (rows.length > 0) {
        setBrowse(true, rows.length - 1); // 光标缺省落最近一条
      }
      return;
    }

    // AskQuestion 问询卡（AskQuestion 线 T2）：模态接管键盘——↑↓ 移动、Space 选定（单选即选即提交、多选为勾选翻转）、
    // Enter 提交（多选提交全部勾选，空勾选=放弃）、数字 1-9 快选（多选为勾选翻转）、Other… 项切自由输入；
    // Esc = 放弃作答（dismissed 属正常观察非错误）；Ctrl+C = 放弃作答并中断任务。
    // 分支置于全局键之前（Esc 在此不回落清缓冲）；取值一律走 ref 真值，不依赖处理器闭包的新鲜度
    if (state.status === 'awaiting-question' && state.question) {
      const q = state.question;
      // filterable 卡（规格 D6–D8；2026-09-30 翻页口径改命令面板式）：可打印字符（含数字）进筛选词、
      // Backspace 删字、Esc 两段式、词变 cursor 归 0；↑/↓/Space/Enter 作用于全量视图（超窗由渲染层
      // 光标跟随滑窗自动翻页），实项经 map 落原下标
      if (q.filterable) {
        const { view, map } = deriveFilterableView(q.options, qFilterRef.current);
        if (key.ctrl && input === 'c') { controller.resolveAskAnswer({ type: 'dismissed' }); controller.interrupt(); return; }
        if (key.escape) {
          if (qFilterRef.current.length > 0) { setQFilter(''); setQCursor(0); return; }
          controller.resolveAskAnswer({ type: 'dismissed' });
          return;
        }
        if (key.backspace || key.delete) { setQFilter(qFilterRef.current.slice(0, -1)); setQCursor(0); return; }
        if (key.upArrow) { setQCursor(moveCursor(qCursorRef.current, view.length, -1)); return; }
        if (key.downArrow) { setQCursor(moveCursor(qCursorRef.current, view.length, 1)); return; }
        if (key.return || input === ' ') {
          const orig = map[qCursorRef.current] ?? -1;
          if (orig < 0) return;
          if (key.return) {
            if (q.multiple) {
              const labels = qPickedRef.current.map((i) => q.options[i]?.label).filter((l): l is string => typeof l === 'string');
              controller.resolveAskAnswer(labels.length > 0 ? { type: 'selected', labels } : { type: 'dismissed' });
            } else {
              controller.resolveAskAnswer({ type: 'selected', labels: [q.options[orig]!.label] });
            }
            return;
          }
          if (q.multiple) setQPicked(togglePick(qPickedRef.current, orig, true));
          else controller.resolveAskAnswer({ type: 'selected', labels: [q.options[orig]!.label] });
          return;
        }
        if (input && !key.ctrl && !key.meta) { setQFilter(qFilterRef.current + input); setQCursor(0); return; }
        return; // 模态：其余键不落输入缓冲
      }
      if (qCustomRef.current) {
        if (key.escape) { setQCustom(false); setQText(''); return; }
        if (key.return) {
          const text = qTextRef.current.trim();
          if (text !== '') controller.resolveAskAnswer({ type: 'custom', text });
          return;
        }
        if (key.backspace || key.delete) { setQText(qTextRef.current.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setQText(qTextRef.current + input); return; }
        return;
      }
      const submitCustom = (): void => { setQCustom(true); setQText(''); };
      const submitLabels = (labels: string[]): void =>
        controller.resolveAskAnswer(labels.length > 0 ? { type: 'selected', labels } : { type: 'dismissed' });
      if (key.ctrl && input === 'c') {
        controller.resolveAskAnswer({ type: 'dismissed' });
        controller.interrupt();
        return;
      }
      if (key.escape) { controller.resolveAskAnswer({ type: 'dismissed' }); return; }
      if (key.upArrow) { setQCursor(moveCursor(qCursorRef.current, q.options.length, -1)); return; }
      if (key.downArrow) { setQCursor(moveCursor(qCursorRef.current, q.options.length, 1)); return; }
      if (key.return) {
        if (qCursorRef.current === q.customIndex) { submitCustom(); return; }
        const pickedNow = q.multiple ? [...qPickedRef.current] : [qCursorRef.current];
        submitLabels(pickedNow.map((i) => q.options[i]?.label).filter((l): l is string => typeof l === 'string'));
        return;
      }
      if (input === ' ') {
        if (q.multiple) {
          if (qCursorRef.current === q.customIndex) { submitCustom(); return; }
          setQPicked(togglePick(qPickedRef.current, qCursorRef.current, true));
        } else {
          if (qCursorRef.current === q.customIndex) { submitCustom(); return; }
          submitLabels([q.options[qCursorRef.current]?.label ?? '']);
        }
        return;
      }
      // 数字快选（非筛选卡）：序号是窗口内可见行的局部编号（OptionSelector 渲染口径），快选映射同一窗口
      const n = Number.parseInt(input, 10);
      const win = slashMenuWindow(q.options.length, qCursorRef.current, SELECTOR_WINDOW);
      if (Number.isInteger(n) && n >= 1 && n <= win.count) {
        const idx = win.start + n - 1;
        if (idx === q.customIndex) { submitCustom(); return; }
        if (q.multiple) setQPicked(togglePick(qPickedRef.current, idx, true));
        else submitLabels([q.options[idx].label]);
        return;
      }
      return; // 模态：其余键不落输入缓冲
    }
    // Ctrl+C 分流（2026-10-02 用户裁决「两次 Ctrl+C 确认暂停」，简化版=一行提示非模态卡）：
    // 运行中第一次挂提示（任务不停），已挂提示再按=真正中断（主链连带子代理）；
    // 其余等待态=中断；空闲且输入非空=清空输入；空闲且输入空=请求退出
    if (key.ctrl && input === 'c') {
      if (stateRef.current.pauseConfirm) { controller.interrupt(); return; }
      if (stateRef.current.status === 'running') { controller.requestPause(); return; }
      if (controller.interrupt()) return;
      if (buffer.length > 0) {
        setBuffer('');
        setCursor(0);
        return;
      }
      onExit?.();
      return;
    }
    // Esc 同源分流：暂停确认卡在场=撤卡继续；运行/等待态=中断；空闲且有输入=清空输入（空闲空输入不退出）
    if (key.escape) {
      if (stateRef.current.pauseConfirm) { controller.cancelPause(); return; }
      if (controller.interrupt()) return;
      if (buffer.length > 0) {
        setBuffer('');
        setCursor(0);
      }
      return;
    }
    // 审批卡（T3 选择器迁移）：y/a/n 单键快捷并存，↑↓ 移动 / Space·Enter 提交 / 数字 1-3 快选 / Esc=拒绝
    if (state.status === 'awaiting-approval') {
      const quick = approvalKeyToDecision(input);
      if (quick) { controller.resolveApproval(quick); return; }
      if (key.escape) { controller.resolveApproval('deny'); return; }
      if (key.upArrow) { setACursor(moveCursor(aCursorRef.current, 3, -1)); return; }
      if (key.downArrow) { setACursor(moveCursor(aCursorRef.current, 3, 1)); return; }
      if (key.return || input === ' ') { controller.resolveApproval(approvalDecisionByIndex(aCursorRef.current)); return; }
      const an = Number.parseInt(input, 10);
      if (Number.isInteger(an) && an >= 1 && an <= 3) { controller.resolveApproval(approvalDecisionByIndex(an - 1)); return; }
      return;
    }
    // plan 确认卡（T3 选择器迁移）：y/n 单键并存，↑↓ 移动 / Space·Enter 提交 / 1-2 快选 / Esc=放弃
    if (state.status === 'awaiting-plan') {
      if (input === 'y') { void controller.confirmPlan(true); return; }
      if (input === 'n') { void controller.confirmPlan(false); return; }
      if (key.escape) { void controller.confirmPlan(false); return; }
      if (key.upArrow) { setPCursor(moveCursor(pCursorRef.current, 2, -1)); return; }
      if (key.downArrow) { setPCursor(moveCursor(pCursorRef.current, 2, 1)); return; }
      if (key.return || input === ' ') { void controller.confirmPlan(pCursorRef.current === 0); return; }
      const pn = Number.parseInt(input, 10);
      if (pn === 1 || pn === 2) { void controller.confirmPlan(pn === 1); return; }
      return;
    }

    // Tab 分流：/ 前缀 → 斜杠补全；否则切换「会话历史展开模式」（Claude Code ctrl+o 同款：清屏后按全展开/折叠
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

    // Ctrl+O：第二层切换（内容深度）——当前一个轮次（自最后一条 user 指令行起）的所有工具与思考行展开/收起为全文
    if (key.ctrl && input === 'o') {
      const nextFull = !latestFull;
      setLatestFull(nextFull);
      controller.recordView(expandAll, nextFull);
      return;
    }

    // Home/End/⌦：ink3 不解析这些功能键，按原始字节序列识别；Ctrl+A/E 惯例双轨
    const csi = key.raw.startsWith('\u001B') ? key.raw.slice(1) : '';
    if (HOME_SEQS.includes(csi)) {
      setCursor(0);
      return;
    }
    if (END_SEQS.includes(csi)) {
      setCursor(buffer.length);
      return;
    }
    if (csi === '[3~') {
      // ⌦ 前向删除：删光标处字符（与退格区分靠 ESC 序列）
      if (cursor < buffer.length) setBuffer((b) => b.slice(0, cursor) + b.slice(cursor + 1));
      return;
    }
    if (key.ctrl && (input === 'a' || input === 'e')) {
      setCursor(input === 'a' ? 0 : buffer.length);
      return;
    }

    // 光标左右移动（多行缓冲按扁平偏移跨行连续）
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(buffer.length, c + 1));
      return;
    }

    // 纵向命令面板 ↑↓（2026-09-30 对标 CC）：菜单在场即接管方向键，输入历史回填让位（非 / 前缀不受影响）；
    // 回环移动与问询卡同款 moveCursor 语义，光标取 ref 真值（闭包滞后先例）
    if ((key.upArrow || key.downArrow) && menuEntries.length > 0 && (state.status === 'idle' || state.status === 'error')) {
      setSlashCursor(moveCursor(Math.min(slashCursorRef.current, menuEntries.length - 1), menuEntries.length, key.upArrow ? -1 : 1));
      return;
    }

    // 运行中撤回排队（对标 CC「Up from the first row」）：有排队穿插且输入框为空时，Up 取回全部待投递行回输入框编辑或清空丢弃
    // （awaiting-approval 态在 handler 前部已被审批卡分流 return，此处只可能是 running）
    if (key.upArrow && state.status === 'running' && buffer.length === 0) {
      const taken = controller.takeBackQueued();
      if (taken.length > 0) {
        const text = taken.join('\n');
        setBuffer(text);
        setCursor(text.length);
      }
      return;
    }

    // ↑↓：单行缓冲回填输入历史（多行缓冲不劫持，留给后续行内导航）
    if ((key.upArrow || key.downArrow) && (state.status === 'idle' || state.status === 'error') && !buffer.includes('\n')) {
      if (key.upArrow && history.length > 0 && histIdx !== 0) {
        const ni = histIdx === -1 ? history.length - 1 : histIdx - 1;
        setHistIdx(ni);
        setBuffer(history[ni]);
        setCursor(history[ni].length);
      } else if (key.downArrow && histIdx >= 0) {
        const ni = histIdx + 1;
        if (ni < history.length) {
          setHistIdx(ni);
          setBuffer(history[ni]);
          setCursor(history[ni].length);
        } else {
          setHistIdx(-1);
          setBuffer('');
          setCursor(0);
        }
      }
      return;
    }
    if (key.return) {
      // 纵向命令面板 Enter（2026-09-30 对标 CC）：菜单在场即提交选中命令（半 typing '/ne' + Enter 直接跑 '/new'，
      // 不再落「无法识别命令」）；带参形态（含空格）过滤必空、菜单不在场，走既有整行提交
      if (menuEntries.length > 0 && (state.status === 'idle' || state.status === 'error')) {
        const picked = (menuEntries[Math.min(slashCursorRef.current, menuEntries.length - 1)] ?? menuEntries[0])!.cmd;
        setBuffer('');
        setCursor(0);
        setHistIdx(-1);
        setHistory((h) => [...h.filter((x) => x !== picked), picked].slice(-100));
        controller.submit(picked);
        return;
      }
      // 行尾单个反斜杠 = 续行（ink3 无法可靠检测 Shift+Enter，回退方案）
      if (buffer.endsWith('\\') && !buffer.endsWith('\\\\')) {
        setBuffer((b) => b.slice(0, -1) + '\n');
        setCursor(buffer.length);
        return;
      }
      const text = buffer.trim();
      setBuffer('');
      setCursor(0);
      setHistIdx(-1);
      if (text) {
        setHistory((h) => [...h.filter((x) => x !== text), text].slice(-100));
        controller.submit(text);
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (key.raw === '\u001B[3~') {
        // ⌦ 前向删除：删光标处字符（ink3 原版 useInput 清空 input 无法与退格区分，走补丁版原始字节）
        if (cursor < buffer.length) setBuffer((b) => b.slice(0, cursor) + b.slice(cursor + 1));
        return;
      }
      // 退格（\u007F / Ctrl+H）：删光标前字符
      if (cursor > 0) {
        setBuffer((b) => b.slice(0, cursor - 1) + b.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuffer((b) => b.slice(0, cursor) + input + b.slice(cursor));
      setCursor((c) => c + input.length);
    }
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
      ) : (
        <>
      {state.status === 'running' ? (
        // 恒显活动行（对标 CC）：整个任务运行期常驻计时·tokens 跳动行，reasoning 长静默期与正文流式期均有「活着」信号，
        // 消除「疑似卡死」观感；responding 期与流式正文同屏共存
        <Spinner startedAt={state.metrics.turnStartedAt} tokens={state.metrics.turnTokens + state.metrics.turnChildTokens} phase={state.task.phase} calls={state.task.activeCalls} columns={columns} />
      ) : null}
      {browseMode ? (
        // 浏览模式提示行：恒 1 行、仅 idle/error 态存在（此时动态区无流式内容），不构成动态区高度波动源
        <Text backgroundColor="gray"> {t('subagent browse · ↑↓ move · Enter inspect · Esc exit', '子代理浏览 · ↑↓ 移动 · Enter 查看 · Esc 退出')} </Text>
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
        model={info.model}
        effort={state.effort}
        context={{ used: state.metrics.ctxUsed, window: Number(process.env.SUNSHINEX_CONTEXT_WINDOW ?? 0) }}
      />
        </>
      )}
      {/* 暂停确认提示（2026-10-02 两次 Ctrl+C，简化版一行非模态）：主视图与子代理全屏视图都可见——
          第一次 Ctrl+C 出现提示，再按 Ctrl+C 即暂停，Esc 继续跑 */}
      {state.pauseConfirm ? (
        <Text backgroundColor="gray"> {t('Pause? press ctrl+c again to pause · esc to keep running', '确认暂停？再按一次 Ctrl+C 暂停 · Esc 继续运行')} </Text>
      ) : null}
    </Box>
  );
}
