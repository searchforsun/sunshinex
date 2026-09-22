import { moveCursor, OptionSelector, togglePick, filterOptions } from './OptionSelector';
import type { AskUserRequest } from '../../types';
import { t } from '../../i18n';
import * as React from 'react';
import { Box, Text, useStdout } from 'ink';
import useInput, { RawKey } from './use-input';
import { ApprovalDecision } from '../../types';
import { SessionController, TuiState, paginateOptions } from '../session';
import { initialRetained, RetainedUiState } from '../ui-state';
import { BannerInfo, buildBannerInfo } from '../banner-info';
import { MessageList } from './MessageList';
import { InputBox } from './InputBox';
import { TodoList } from './TodoList';
import { StatusBar } from './StatusBar';
import { Spinner } from './Spinner';
import { ChildPanel } from './ChildPanel';

/** 审批键盘映射：y 放行一次 / a 本会话放行 / n 拒绝（纯函数，独立单测） */
export function approvalKeyToDecision(input: string): ApprovalDecision | undefined {
  if (input === 'y') return 'allow';
  if (input === 'a') return 'always';
  if (input === 'n') return 'deny';
  return undefined;
}

/** 斜杠命令清单（补全候选，顺序即 Tab 循环顺序） */
export const SLASH_COMMANDS = ['/help', '/init', '/status', '/tasks', '/new', '/resume', '/rewind', '/fork', '/compact', '/plan', '/goal', '/model', '/model-effort', '/memory', '/memory-add', '/memory-rm', '/memory-gc', '/memory-on', '/memory-off'];

/** 斜杠补全候选：按 buffer（已 trim）前缀匹配命令清单；非 / 前缀或无匹配返回空 */
export function slashCandidates(buffer: string): string[] {
  const t = buffer.trim();
  if (!t.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((c) => c.startsWith(t));
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

/** filterable 卡视图派生单点（规格 D8）：空词=全量分页视图（More…/Back… 导航行无映射席位）；有词=全量过滤直出、无导航行。
 *  map[i]=视图第 i 行对应的 q.options 原下标；moreIdx/backIdx=-1 表示该导航行不在场 */
export function deriveFilterableView(
  full: Array<{ label: string; description?: string }>,
  query: string,
  page: number,
): { view: Array<{ label: string; description?: string }>; map: number[]; moreIdx: number; backIdx: number } {
  if (query.length > 0) {
    const { view, map } = filterOptions(full, query);
    return { view, map, moreIdx: -1, backIdx: -1 };
  }
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(full.length / pageSize));
  const realCount = Math.max(0, Math.min(pageSize, full.length - page * pageSize));
  const map: number[] = [];
  for (let i = 0; i < realCount; i++) map.push(page * pageSize + i);
  let moreIdx = -1;
  let backIdx = -1;
  let navAt = map.length;
  if (page + 1 < totalPages) { moreIdx = navAt; navAt += 1; }
  if (page > 0) { backIdx = navAt; }
  return { view: paginateOptions(full, page).options, map, moreIdx, backIdx };
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
  /** 宿主注入的「请求整屏重绘」出口：Tab 切换展开模式后经此卸载→清屏→重挂，Static 按新模式重放 */
  onRequestRepaint?: () => void;
  /** 空闲态 Ctrl+C 的退出请求出口（entry 注入优雅退出：flush→dispose→unmount→exit）；缺省无退出通道 */
  onExit?: () => void;
}): JSX.Element {
  const localRetain = React.useRef<RetainedUiState>(initialRetained());
  const store = retain ?? localRetain.current;
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
  // filterable 卡筛选态（规格 D6/D7）：词与页码 ref 真值 + state 渲染，随新问询卡归位清零
  const [qFilter, setQFilterState] = React.useState('');
  const [qPage, setQPageState] = React.useState(0);
  const qFilterRef = React.useRef('');
  const qPageRef = React.useRef(0);
  const setQFilter = (v: string): void => { qFilterRef.current = v; setQFilterState(v); };
  const setQPage = (v: number): void => { qPageRef.current = v; setQPageState(v); };
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
      setQPage(0);
    }
    if (!state.question && qRef.current) qRef.current = undefined;
  }, [state.question]);
  const [buffer, setBuffer] = React.useState(store.buffer);
  const [cursor, setCursor] = React.useState(store.cursor);
  // 两层展开视图（Tab/Ctrl+O 正交，均经 tui-loop 卸载→清屏→重挂整屏重放，视口永远只有一份历史）：
  // expandAll=第一层行折叠（历史阶段组只留「正文+首个工具对+首个思考行」↔ 全行）；
  // latestFull=第二层内容深度（最近正文锚点阶段的思考与工具结果全文 ↔ 摘要）；无状态门槛，运行中随时可切
  const [expandAll, setExpandAll] = React.useState(store.expandAll ?? false);
  const [latestFull, setLatestFull] = React.useState(store.latestFull ?? false);
  // 子代理浏览模式（Ctrl+B）：本地态 + ref 真值（useInput 处理器经 effect 重挂存在闭包滞后，对标 qCursor 先例）
  const [browseMode, setBrowseMode] = React.useState(false);
  const browseModeRef = React.useRef(false);
  const [browseCursor, setBrowseCursor] = React.useState(0);
  const browseCursorRef = React.useRef(0);
  const [spawnExpanded, setSpawnExpanded] = React.useState<number[]>(store.spawnExpanded);
  const setBrowse = (mode: boolean, cursor = 0): void => {
    browseModeRef.current = mode;
    browseCursorRef.current = cursor;
    setBrowseMode(mode);
    setBrowseCursor(cursor);
  };
  /** 已归档 SPAWN 调用行 seq 列表（键盘分发与高亮透传共用同一过滤口径） */
  const spawnCallSeqs = (msgs: TuiState['messages']): number[] =>
    msgs.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.detail).map((m) => m.seq);
  const [history, setHistory] = React.useState<string[]>(store.history);
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
    store.spawnExpanded = spawnExpanded;
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
    onRequestRepaint?.();
  }, [expandAll, latestFull, browseMode, spawnExpanded]);
  // 段锚点自动重绘：段数变化即新锚点落定（正文/▶ 行/用户输入各自开段）——上一段从全显转折叠。
  // 防闪烁两层：①被收拢段不含思考/工具行时重绘前后画面零变化，直接跳过（连续 ▶ 行、计划卡、
  // 上一任务正文段等无效触发全部过滤）；②400ms 防抖合并，锚点连续落定只画一次；
  // Static 只增不删，折叠必须经重挂重放；首评只记录不触发（挂载本身即一次重放）
  const segInitRef = React.useRef(false);
  const segCountRef = React.useRef(0);
  const segDebounceRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => {
    let seg = -1;
    const segHasProcess: boolean[] = [];
    const msgs = state.messages;
    for (let i = 0; i < msgs.length; i++) {
      const role = msgs[i].role;
      if (role === 'assistant') {
        const prevIsAssistant = i > 0 && msgs[i - 1].role === 'assistant';
        if (!prevIsAssistant) {
          seg += 1;
          segHasProcess[seg] = false;
        }
      } else if (role !== 'thinking' && role !== 'tool') {
        seg += 1;
        segHasProcess[seg] = false;
      } else if (seg < 0) {
        seg = 0;
        segHasProcess[seg] = false;
      } else {
        segHasProcess[seg] = true;
      }
    }
    const segCount = seg + 1;
    const changed = segInitRef.current && segCount !== segCountRef.current;
    // 被收拢的段：上次计数与本次计数之间的旧尾段——只有含过程行时收拢才有画面变化
    let collapseWorthy = false;
    if (changed) {
      const from = Math.max(0, segCountRef.current - 1);
      for (let k = from; k < segCount - 1; k++) {
        if (segHasProcess[k]) {
          collapseWorthy = true;
          break;
        }
      }
    }
    segInitRef.current = true;
    segCountRef.current = segCount;
    if (!changed || !collapseWorthy) return;
    if (segDebounceRef.current) clearTimeout(segDebounceRef.current);
    segDebounceRef.current = setTimeout(() => {
      segDebounceRef.current = undefined;
      onRequestRepaint?.();
    }, 400);
  }, [state.messages]);
  const info = React.useMemo(() => banner ?? buildBannerInfo(), [banner]);
  const columns = useStdout().stdout?.columns ?? 80;
  const fq = state.question?.filterable ? deriveFilterableView(state.question.options, qFilter, qPage) : undefined;

  useInput((input: string, key: RawKey) => {

    // 子代理浏览模式（Ctrl+B 进入）：短接管 ↑/↓/Enter/Esc；其余按键一律吞掉不落输入缓冲。
    // 光标与模式取 ref 真值（处理器经 effect 重挂存在闭包滞后，对标 qCursor 先例）；仅 idle/error 可进入。
    if (browseModeRef.current) {
      const spawnSeqs = spawnCallSeqs(state.messages);
      if (spawnSeqs.length === 0) { setBrowse(false); return; }
      const clamp = (n: number): number => Math.max(0, Math.min(spawnSeqs.length - 1, n));
      if (key.escape) { setBrowse(false); return; }
      if (key.upArrow) { setBrowse(true, clamp(browseCursorRef.current - 1)); return; }
      if (key.downArrow) { setBrowse(true, clamp(browseCursorRef.current + 1)); return; }
      if (key.return) {
        const seq = spawnSeqs[clamp(browseCursorRef.current)];
        setSpawnExpanded((list) => (list.includes(seq) ? list.filter((s) => s !== seq) : [...list, seq]));
        return;
      }
      if (key.ctrl && input === 'c') { setBrowse(false); return; }
      return;
    }
    // Ctrl+B 进入子代理浏览模式：仅 idle/error 态、且场上存在已归档 SPAWN 行；无 SPAWN 行/运行中静默 no-op
    if (key.ctrl && input === 'b') {
      if ((state.status === 'idle' || state.status === 'error') && spawnCallSeqs(state.messages).length > 0) {
        setBrowse(true, spawnCallSeqs(state.messages).length - 1); // 光标缺省落最近一条
      }
      return;
    }

    // AskQuestion 问询卡（AskQuestion 线 T2）：模态接管键盘——↑↓ 移动、Space 选定（单选即选即提交、多选为勾选翻转）、
    // Enter 提交（多选提交全部勾选，空勾选=放弃）、数字 1-9 快选（多选为勾选翻转）、Other… 项切自由输入；
    // Esc = 放弃作答（dismissed 属正常观察非错误）；Ctrl+C = 放弃作答并中断任务。
    // 分支置于全局键之前（Esc 在此不回落清缓冲）；取值一律走 ref 真值，不依赖处理器闭包的新鲜度
    if (state.status === 'awaiting-question' && state.question) {
      const q = state.question;
      // filterable 卡（规格 D6–D8）：可打印字符（含数字）进筛选词、Backspace 删字、Esc 两段式、
      // 词变 cursor 归 0；↑/↓/Space/Enter 作用于视图，导航行翻页、实项经 map 落原下标
      if (q.filterable) {
        const { view, map, moreIdx, backIdx } = deriveFilterableView(q.options, qFilterRef.current, qPageRef.current);
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
          if (qCursorRef.current === moreIdx) { setQPage(qPageRef.current + 1); setQCursor(0); return; }
          if (qCursorRef.current === backIdx) { setQPage(qPageRef.current - 1); setQCursor(0); return; }
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
      const n = Number.parseInt(input, 10);
      if (Number.isInteger(n) && n >= 1 && n <= q.options.length) {
        const idx = n - 1;
        if (idx === q.customIndex) { submitCustom(); return; }
        if (q.multiple) setQPicked(togglePick(qPickedRef.current, idx, true));
        else submitLabels([q.options[idx].label]);
        return;
      }
      return; // 模态：其余键不落输入缓冲
    }
    // Ctrl+C 分流（对标 Claude Code）：运行/等待态=中断当前任务；空闲且输入非空=清空输入；空闲且输入空=请求退出
    if (key.ctrl && input === 'c') {
      if (controller.interrupt()) return;
      if (buffer.length > 0) {
        setBuffer('');
        setCursor(0);
        return;
      }
      onExit?.();
      return;
    }
    // Esc 同源分流：运行/等待态=中断；空闲且有输入=清空输入（空闲空输入不退出）
    if (key.escape) {
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
        const token = buffer.trim();
        const exactIdx = SLASH_COMMANDS.indexOf(token);
        const next =
          exactIdx >= 0
            ? SLASH_COMMANDS[(exactIdx + 1) % SLASH_COMMANDS.length] + ' '
            : slashCandidates(token).length > 0
              ? slashCandidates(token)[0] + ' '
              : undefined;
        if (next !== undefined) {
          setBuffer(next);
          setCursor(next.length);
        }
      } else {
        // 第一层切换（行折叠）：翻转后经重挂整屏重放（Static 按新形态整体重建，视口永远只有一份），运行中随时可切
        const nextExpand = !expandAll;
        setExpandAll(nextExpand);
        controller.recordView(nextExpand, latestFull);
      }
      return;
    }

    // Ctrl+O：第二层切换（内容深度）——最近正文锚点阶段的思考与工具结果展开/收起为全文
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
      <MessageList
        banner={info}
        messages={state.messages}
        live={state.live}
        columns={columns}
        expandAll={expandAll}
        latestFull={latestFull}
        spawnExpandedSeqs={spawnExpanded}
        spawnHighlightSeq={browseMode ? (spawnCallSeqs(state.messages)[browseCursor] ?? undefined) : undefined}
      />
      {state.status === 'running' && state.task.phase !== 'responding' ? (
        <Spinner startedAt={state.metrics.turnStartedAt} tokens={state.metrics.turnTokens} phase={state.task.phase} calls={state.task.activeCalls} />
      ) : null}
      {browseMode ? (
        // 浏览模式提示行：恒 1 行、仅 idle/error 态存在（此时动态区无流式内容），不构成动态区高度波动源
        <Text backgroundColor="gray"> {t('subagent browse · ↑↓ move · Enter toggle · Esc exit', '子代理浏览 · ↑↓ 移动 · Enter 切换 · Esc 退出')} </Text>
      ) : null}
      {state.children.length > 0 ? <ChildPanel childrenState={state.children} columns={columns} /> : null}
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
      <InputBox
        buffer={buffer}
        cursor={cursor}
        placeholder={inputPlaceholder(state.status)}
        active={state.status === 'idle' || state.status === 'error'}
      />
      <TodoList todos={state.todos} expanded={expandAll || state.status !== 'running'} columns={columns} />
      <StatusBar
        metrics={state.metrics}
        status={state.status}
        todos={state.todos}
        model={info.model}
        effort={state.effort}
        context={{ used: state.metrics.ctxUsed, window: Number(process.env.SUNSHINEX_CONTEXT_WINDOW ?? 0) }}
      />
    </Box>
  );
}

