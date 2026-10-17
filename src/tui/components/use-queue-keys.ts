import * as React from 'react';
import { SessionController, TuiState } from '../session';
import type { RawKey } from './use-input';

/**
 * 等待队列管理面板键分发 hook（P5 spec §12.3，Ctrl+Q；use-browse-keys 同构模态拆件）：
 * 收编队列面板整段按键分支、Ctrl+Q 进入分支及其专属状态（queueMode / queueCursor / draft）。
 * 面板在场恒吞键；态在内核（controller 队列 API），变更即落档（steer 行）——本 hook 零持久化职责。
 *
 * 键位：↑↓ 选条（回环）/ E 编辑 / D 删除 / I 插入 / N 直接发送（撤条+中断+等 idle+提交，
 * GUI pauseAndSend 同语义）/ F 置首插入 / Ctrl+↑↓ 重排 / Esc 关闭；draft 行内 Backspace 删字、
 * Enter 提交、Esc 撤。任务卡（审批/问询/计划）在场即让位自关（轻模态不压任务交互）。
 */
export function useQueueKeys({
  controller,
  stateRef,
}: {
  controller: SessionController;
  /** 键分发 ref 真值（App 持有）：任务卡在场判定与队列快照读 ref 不读闭包（节流滞后） */
  stateRef: React.MutableRefObject<TuiState>;
}): {
  queueMode: boolean;
  queueCursor: number;
  queueModeRef: React.MutableRefObject<boolean>;
  /** 编辑/插入在途输入行（渲染面；undefined=列表态） */
  draft: string | undefined;
  /** 编辑目标条 seq（undefined=插入新条；draft 为 undefined 时无意义） */
  draftSeq: number | undefined;
  /** 模态接管（判定序第 6 位=面板在场吞键、Ctrl+Q 进入）：任一命中恒 true，否则 false 交下一位 */
  handleKey: (input: string, key: RawKey) => boolean;
} {
  // 本地态 + ref 真值（useInput 处理器经 effect 重挂存在闭包滞后，对标 browseCursorRef 先例）；
  // 面板为轻瞬态不入 retain（检视面非操作现场，board 同口径）
  const [queueMode, setQueueMode] = React.useState(false);
  const queueModeRef = React.useRef(false);
  const [queueCursor, setQueueCursor] = React.useState(0);
  const queueCursorRef = React.useRef(0);
  const [draft, setDraft] = React.useState<string | undefined>(undefined);
  const draftRef = React.useRef<string | undefined>(undefined);
  const [draftSeq, setDraftSeq] = React.useState<number | undefined>(undefined);
  const draftSeqRef = React.useRef<number | undefined>(undefined);
  // 面板内操作自驱重绘（内核队列变更不经 onEvent/notify——App 帧只随会话事件来）：每次操作 +1
  const [, setTick] = React.useState(0);

  const setMode = (mode: boolean, cursor = 0): void => {
    queueModeRef.current = mode;
    queueCursorRef.current = cursor;
    setQueueMode(mode);
    setQueueCursor(cursor);
  };
  const setDraftState = (text: string | undefined, seq: number | undefined): void => {
    draftRef.current = text;
    draftSeqRef.current = seq;
    setDraft(text);
    setDraftSeq(seq);
  };
  /** 任务卡让位判定：审批/问询/计划卡在场即自关面板交键（轻模态不压任务交互） */
  const cardPresent = (): boolean => {
    const st = stateRef.current;
    return st.approval !== undefined || st.question !== undefined || st.status === 'awaiting-plan' || st.status === 'awaiting-approval' || st.status === 'awaiting-question';
  };

  const handleKey = (input: string, key: RawKey): boolean => {
    if (queueModeRef.current) {
      if (cardPresent()) {
        setMode(false);
        setDraftState(undefined, undefined);
        return false; // 键交任务卡分支
      }
      const items = controller.queueItems();
      // ---- draft 行（编辑/插入）----
      if (draftRef.current !== undefined) {
        if (key.escape) {
          setDraftState(undefined, undefined);
          return true;
        }
        if (key.return) {
          const text = draftRef.current;
          const seq = draftSeqRef.current;
          setDraftState(undefined, undefined);
          if (text.trim() !== '') {
            if (seq !== undefined) controller.queueEditAt(seq, text);
            else controller.queueEnqueue(text);
            setTick((x) => x + 1);
          }
          return true;
        }
        if (key.backspace || key.delete) {
          setDraftState(draftRef.current.slice(0, -1), draftSeqRef.current);
          return true;
        }
        if (key.ctrl && input === 'c') {
          setDraftState(undefined, undefined);
          setMode(false);
          if (stateRef.current.pauseConfirm) controller.interrupt();
          else if (stateRef.current.status === 'running') controller.requestPause();
          return true;
        }
        if (!key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab && !key.pageUp && !key.pageDown && !key.newline && input.length > 0 && !input.startsWith('\u001B')) {
          setDraftState(draftRef.current + input, draftSeqRef.current);
        }
        return true; // draft 在场恒吞键
      }
      // ---- 列表态 ----
      const clamp = (n: number): number => Math.max(0, Math.min(items.length - 1, n));
      if (key.escape) {
        setMode(false);
        return true;
      }
      if (key.ctrl && input === 'c') {
        setMode(false);
        if (stateRef.current.pauseConfirm) controller.interrupt();
        else if (stateRef.current.status === 'running') controller.requestPause();
        return true;
      }
      if (items.length === 0) {
        if (input === 'i' || input === 'I') setDraftState('', undefined);
        return true;
      }
      if (key.upArrow && !key.ctrl) {
        setMode(true, (queueCursorRef.current + items.length - 1) % items.length); // 回环（全列表一套肌肉记忆）
        return true;
      }
      if (key.downArrow && !key.ctrl) {
        setMode(true, (queueCursorRef.current + 1) % items.length);
        return true;
      }
      if (key.ctrl && key.upArrow) {
        const from = clamp(queueCursorRef.current);
        if (controller.queueMove(from, from - 1)) setMode(true, from - 1);
        setTick((x) => x + 1);
        return true;
      }
      if (key.ctrl && key.downArrow) {
        const from = clamp(queueCursorRef.current);
        if (controller.queueMove(from, from + 1)) setMode(true, from + 1);
        setTick((x) => x + 1);
        return true;
      }
      const sel = items[clamp(queueCursorRef.current)];
      if (sel === undefined) return true;
      if (input === 'e' || input === 'E') {
        setDraftState(sel.text, sel.seq);
        return true;
      }
      if (input === 'd' || input === 'D') {
        controller.queueRemoveAt(sel.seq);
        setMode(true, clamp(queueCursorRef.current));
        setTick((x) => x + 1);
        return true;
      }
      if (input === 'f' || input === 'F') {
        controller.queueMoveToFront(sel.seq);
        setMode(true, 0);
        setTick((x) => x + 1);
        return true;
      }
      if (input === 'i' || input === 'I') {
        setDraftState('', undefined);
        return true;
      }
      if (input === 'n' || input === 'N') {
        // 直接发送（GUI pauseAndSend 同语义）：撤条 → 中断当前轮 → 等 idle → 立即提交为新轮
        controller.queueRemoveAt(sel.seq);
        setMode(false);
        setTick((x) => x + 1);
        controller.interrupt();
        void (async (): Promise<void> => {
          for (let i = 0; i < 40; i += 1) {
            if (controller.getState().status === 'idle') break;
            await new Promise((r) => setTimeout(r, 100));
          }
          await controller.submit(sel.text);
        })();
        return true;
      }
      return true; // 面板在场恒吞键
    }
    // Ctrl+Q 进入：任务卡在场不抢键（轻模态优先级最低）
    if (key.ctrl && input === 'q' && !cardPresent()) {
      setMode(true, 0);
      return true;
    }
    return false;
  };
  return { queueMode, queueCursor, queueModeRef, draft, draftSeq, handleKey };
}
