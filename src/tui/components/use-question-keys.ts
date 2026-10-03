import * as React from 'react';
import type { AskUserRequest } from '../../types';
import { SessionController } from '../session';
import { moveCursor, togglePick, filterOptions, SELECTOR_WINDOW } from './OptionSelector';
import { slashMenuWindow } from './SlashMenu';
import type { RawKey } from './use-input';

/** 问询卡键分发 hook（D17-H2 拆自 App useInput 第 4 层，行为零变化）：
 *  收编 AskQuestion 问询卡的整段按键分支（filterable 筛选卡 / qCustom 自由输入 / 普通卡三形态）及其专属状态
 *  （qCursor / qPicked / qCustom / qText / qFilter + 新卡归位 effect）。
 *  模态在场恒吞键（其余键不落输入缓冲）；分支置于全局键之前（Esc 在此不回落清缓冲）；
 *  取值一律走 ref 真值，不依赖处理器闭包的新鲜度。
 *  注：filterable 视图派生经 filterOptions（App 导出的 deriveFilterableView 即其恒等转发，
 *  该导出被既有测试引用故留在 App，两处永不漂移） */
export function useQuestionKeys({
  controller,
  question,
}: {
  controller: SessionController;
  /** 当前问询卡（state.question）：引用变化即新卡，专属状态全量归位 */
  question: AskUserRequest | undefined;
}): {
  qCursor: number;
  qPicked: number[];
  qCustom: boolean;
  qText: string;
  qFilter: string;
  /** 模态接管（判定序第 4 位）：App 判定 awaiting-question 且 question 在场后调用，恒 true（吞键） */
  handleKey: (q: AskUserRequest, input: string, key: RawKey) => boolean;
} {
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
  // 新问询卡归位：引用变化即新卡，选择器/勾选/自由输入/筛选词全量复位
  const qRef = React.useRef<AskUserRequest | undefined>(undefined);
  React.useEffect(() => {
    if (question && question !== qRef.current) {
      qRef.current = question;
      setQCursor(0);
      setQPicked([]);
      setQCustom(false);
      setQText('');
      setQFilter('');
    }
    if (!question && qRef.current) qRef.current = undefined;
  }, [question]);
  // AskQuestion 问询卡（AskQuestion 线 T2）：模态接管键盘——↑↓ 移动、Space 选定（单选即选即提交、多选为勾选翻转）、
  // Enter 提交（多选提交全部勾选，空勾选=放弃）、数字 1-9 快选（多选为勾选翻转）、Other… 项切自由输入；
  // Esc = 放弃作答（dismissed 属正常观察非错误）；Ctrl+C = 放弃作答并中断任务
  const handleKey = (q: AskUserRequest, input: string, key: RawKey): boolean => {
    // filterable 卡（规格 D6–D8；2026-09-30 翻页口径改命令面板式）：可打印字符（含数字）进筛选词、
    // Backspace 删字、Esc 两段式、词变 cursor 归 0；↑/↓/Space/Enter 作用于全量视图（超窗由渲染层
    // 光标跟随滑窗自动翻页），实项经 map 落原下标
    if (q.filterable) {
      const { view, map } = filterOptions(q.options, qFilterRef.current);
      if (key.ctrl && input === 'c') { controller.resolveAskAnswer({ type: 'dismissed' }); controller.interrupt(); return true; }
      if (key.escape) {
        if (qFilterRef.current.length > 0) { setQFilter(''); setQCursor(0); return true; }
        controller.resolveAskAnswer({ type: 'dismissed' });
        return true;
      }
      if (key.backspace || key.delete) { setQFilter(qFilterRef.current.slice(0, -1)); setQCursor(0); return true; }
      if (key.upArrow) { setQCursor(moveCursor(qCursorRef.current, view.length, -1)); return true; }
      if (key.downArrow) { setQCursor(moveCursor(qCursorRef.current, view.length, 1)); return true; }
      if (key.return || input === ' ') {
        const orig = map[qCursorRef.current] ?? -1;
        if (orig < 0) return true;
        if (key.return) {
          if (q.multiple) {
            const labels = qPickedRef.current.map((i) => q.options[i]?.label).filter((l): l is string => typeof l === 'string');
            controller.resolveAskAnswer(labels.length > 0 ? { type: 'selected', labels } : { type: 'dismissed' });
          } else {
            controller.resolveAskAnswer({ type: 'selected', labels: [q.options[orig]!.label] });
          }
          return true;
        }
        if (q.multiple) setQPicked(togglePick(qPickedRef.current, orig, true));
        else controller.resolveAskAnswer({ type: 'selected', labels: [q.options[orig]!.label] });
        return true;
      }
      if (input && !key.ctrl && !key.meta) { setQFilter(qFilterRef.current + input); setQCursor(0); return true; }
      return true; // 模态：其余键不落输入缓冲
    }
    if (qCustomRef.current) {
      if (key.escape) { setQCustom(false); setQText(''); return true; }
      if (key.return) {
        const text = qTextRef.current.trim();
        if (text !== '') controller.resolveAskAnswer({ type: 'custom', text });
        return true;
      }
      if (key.backspace || key.delete) { setQText(qTextRef.current.slice(0, -1)); return true; }
      if (input && !key.ctrl && !key.meta) { setQText(qTextRef.current + input); return true; }
      return true;
    }
    const submitCustom = (): void => { setQCustom(true); setQText(''); };
    const submitLabels = (labels: string[]): void =>
      controller.resolveAskAnswer(labels.length > 0 ? { type: 'selected', labels } : { type: 'dismissed' });
    if (key.ctrl && input === 'c') {
      controller.resolveAskAnswer({ type: 'dismissed' });
      controller.interrupt();
      return true;
    }
    if (key.escape) { controller.resolveAskAnswer({ type: 'dismissed' }); return true; }
    if (key.upArrow) { setQCursor(moveCursor(qCursorRef.current, q.options.length, -1)); return true; }
    if (key.downArrow) { setQCursor(moveCursor(qCursorRef.current, q.options.length, 1)); return true; }
    if (key.return) {
      if (qCursorRef.current === q.customIndex) { submitCustom(); return true; }
      const pickedNow = q.multiple ? [...qPickedRef.current] : [qCursorRef.current];
      submitLabels(pickedNow.map((i) => q.options[i]?.label).filter((l): l is string => typeof l === 'string'));
      return true;
    }
    if (input === ' ') {
      if (q.multiple) {
        if (qCursorRef.current === q.customIndex) { submitCustom(); return true; }
        setQPicked(togglePick(qPickedRef.current, qCursorRef.current, true));
      } else {
        if (qCursorRef.current === q.customIndex) { submitCustom(); return true; }
        submitLabels([q.options[qCursorRef.current]?.label ?? '']);
      }
      return true;
    }
    // 数字快选（非筛选卡）：序号是窗口内可见行的局部编号（OptionSelector 渲染口径），快选映射同一窗口
    const n = Number.parseInt(input, 10);
    const win = slashMenuWindow(q.options.length, qCursorRef.current, SELECTOR_WINDOW);
    if (Number.isInteger(n) && n >= 1 && n <= win.count) {
      const idx = win.start + n - 1;
      if (idx === q.customIndex) { submitCustom(); return true; }
      if (q.multiple) setQPicked(togglePick(qPickedRef.current, idx, true));
      else submitLabels([q.options[idx].label]);
      return true;
    }
    return true; // 模态：其余键不落输入缓冲
  };
  return { qCursor, qPicked, qCustom, qText, qFilter, handleKey };
}
