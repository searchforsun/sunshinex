import * as React from 'react';
import { SessionController, TuiState } from '../session';
import { ApprovalDecision } from '../../types';
import { moveCursor } from './OptionSelector';
import type { RawKey } from './use-input';

/** 审批键盘映射：y 放行一次 / a 本会话放行 / n 拒绝（纯函数，独立单测；App re-export 供既有测试导入） */
export function approvalKeyToDecision(input: string): ApprovalDecision | undefined {
  if (input === 'y') return 'allow';
  if (input === 'a') return 'always';
  if (input === 'n') return 'deny';
  return undefined;
}

/** 审批选择器下标 → 裁决值（渲染层提交映射单点，防两处漂移；App re-export 供既有测试导入） */
export function approvalDecisionByIndex(idx: number): ApprovalDecision {
  return (['allow', 'always', 'deny'] as const)[idx] ?? 'deny';
}

/** 审批/plan 卡键分发 hook（D17-H2 拆自 App useInput 第 7/8 层，行为零变化）：
 *  收编审批卡与 plan 确认卡两段按键分支及其专属状态（aCursor / pCursor + 状态转入归位 effect）。
 *  两卡模态在场恒吞键（其余键不落输入缓冲）；Ctrl+C/Esc 全局分流在本层之前已截获，故此处
 *  Ctrl+C/Esc 不可达（既有判定序原样）。快捷键映射复用 App 导出的纯函数单点，两侧永不漂移 */
export function useApprovalKeys({
  controller,
  status,
}: {
  controller: SessionController;
  status: TuiState['status'];
}): {
  /** 审批选择器光标（渲染） */
  aCursor: number;
  /** plan 确认选择器光标（渲染） */
  pCursor: number;
  /** 模态接管（判定序第 7/8 位）：awaiting-approval / awaiting-plan 在场恒 true（吞键），否则 false 交下一位 */
  handleKey: (input: string, key: RawKey) => boolean;
} {
  // 审批/plan 选择器光标（T3 迁移）：ref 真值 + state 渲染；状态转入时归位首项
  const [aCursor, setACursorState] = React.useState(0);
  const aCursorRef = React.useRef(0);
  const setACursor = (v: number): void => { aCursorRef.current = v; setACursorState(v); };
  const [pCursor, setPCursorState] = React.useState(0);
  const pCursorRef = React.useRef(0);
  const setPCursor = (v: number): void => { pCursorRef.current = v; setPCursorState(v); };
  const statusRef = React.useRef(status);
  React.useEffect(() => {
    if (status !== statusRef.current) {
      if (status === 'awaiting-approval') setACursor(0);
      if (status === 'awaiting-plan') setPCursor(0);
      statusRef.current = status;
    }
  }, [status]);
  const handleKey = (input: string, key: RawKey): boolean => {
    // 审批卡（T3 选择器迁移）：y/a/n 单键快捷并存，↑↓ 移动 / Space·Enter 提交 / 数字 1-3 快选 / Esc=拒绝
    if (status === 'awaiting-approval') {
      const quick = approvalKeyToDecision(input);
      if (quick) { controller.resolveApproval(quick); return true; }
      if (key.escape) { controller.resolveApproval('deny'); return true; }
      if (key.upArrow) { setACursor(moveCursor(aCursorRef.current, 3, -1)); return true; }
      if (key.downArrow) { setACursor(moveCursor(aCursorRef.current, 3, 1)); return true; }
      if (key.return || input === ' ') { controller.resolveApproval(approvalDecisionByIndex(aCursorRef.current)); return true; }
      const an = Number.parseInt(input, 10);
      if (Number.isInteger(an) && an >= 1 && an <= 3) { controller.resolveApproval(approvalDecisionByIndex(an - 1)); return true; }
      return true;
    }
    // plan 确认卡（T3 选择器迁移）：y/n 单键并存，↑↓ 移动 / Space·Enter 提交 / 1-2 快选 / Esc=放弃
    if (status === 'awaiting-plan') {
      if (input === 'y') { void controller.confirmPlan(true); return true; }
      if (input === 'n') { void controller.confirmPlan(false); return true; }
      if (key.escape) { void controller.confirmPlan(false); return true; }
      if (key.upArrow) { setPCursor(moveCursor(pCursorRef.current, 2, -1)); return true; }
      if (key.downArrow) { setPCursor(moveCursor(pCursorRef.current, 2, 1)); return true; }
      if (key.return || input === ' ') { void controller.confirmPlan(pCursorRef.current === 0); return true; }
      const pn = Number.parseInt(input, 10);
      if (pn === 1 || pn === 2) { void controller.confirmPlan(pn === 1); return true; }
      return true;
    }
    return false;
  };
  return { aCursor, pCursor, handleKey };
}
