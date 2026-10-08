import * as React from 'react';
import { SessionController, TuiState } from '../session';
import { moveCursor } from './OptionSelector';
import { BoardRow } from './BoardList';
import { t } from '../../i18n';
import type { RawKey } from './use-input';

/** 任务板行序单点（仿 browseRows，P2 spec §10.3）：Object.values 按 id 数值序（t2 < t10 的数值语义，
 *  summaryLines 同款 localeCompare numeric）；label = title + 依赖箭头 ` ← t2,t3`（英文 needs 语义用
 *  箭头省宽度）+ 执行者/指派后缀 `@w1`——↑↓ 键盘分发与动态区列表渲染共用同一函数，两侧永不漂移。
 *  状态符号制（2026-10-06 用户定版：与全 TUI 同一符号语言，替代英文状态词双份口径）——
 *  ○ 待派 / ▸ 执行中 / ◆ 待复核 / ✓ 完成 / ✗ 失败 / ⊘ 取消；gated 后缀 ⚠ 沿用 */
const STATUS_SYMBOL: Record<string, string> = {
  pending: '○', claimed: '▸', 'in-review': '◆', done: '✓', failed: '✗', cancelled: '⊘',
};

export function boardRows(st: TuiState): BoardRow[] {
  return Object.values(st.board.tasks)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((task) => ({
      id: task.id,
      // @ 后缀(2026-10-06 用户定版 Ctrl+T 语义「哪个代理执行的」):实际执行者优先,未执行回落指派者
      label: `${task.title}${task.dependsOn.length > 0 ? ` ← ${task.dependsOn.join(',')}` : ''}${(task.executedBy ?? task.assignee) !== undefined ? ` @${task.executedBy ?? task.assignee}` : ''}`,
      status: STATUS_SYMBOL[task.status] ?? task.status,
      ...(task.gated === true ? { gated: true } : {}),
    }));
}

/** board 模态键分发 hook（Ctrl+T 任务视图，P2 spec §10.3；仿 use-browse-keys 形态）：
 *  收编任务视图整段按键分支（boardMode/boardCursor 状态 + Ctrl+T 进入）与 gate 行内审批——
 *  Enter 于 gated 行 → controller.askUser 问题卡（approve/deny）→ 裁决映射 taskboard.review
 *  （spec §10.3：approve 解锁派发 / deny 维持挂起；review 后板投影经 gate-resolved 事件自更新）；
 *  非 gated 行 Enter 无操作。局部瞬态不入 retain（重挂回落主视图，与 browse 的跨重挂存续不同——
 *  任务视图是检视面非操作现场）；与 Ctrl+B 浏览互斥由 App 判定序保证（browse 在场先吞键，反之亦然） */
export function useBoardKeys({
  controller,
  stateRef,
}: {
  controller: SessionController;
  /** 键分发 ref 真值（App 持有）：板投影节流滞后，行序构造必须读 ref 不读闭包 */
  stateRef: React.MutableRefObject<TuiState>;
}): {
  boardMode: boolean;
  boardCursor: number;
  boardModeRef: React.MutableRefObject<boolean>;
  /** 模态接管（App 判定序 browse 之后）：在场恒吞键、Ctrl+T 进入命中恒 true，否则 false 交下一位 */
  handleKey: (input: string, key: RawKey) => boolean;
} {
  const [boardMode, setBoardMode] = React.useState(false);
  const boardModeRef = React.useRef(false);
  const [boardCursor, setBoardCursor] = React.useState(0);
  const boardCursorRef = React.useRef(0);
  const setBoard = (mode: boolean, cursor = 0): void => {
    boardModeRef.current = mode;
    boardCursorRef.current = cursor;
    setBoardMode(mode);
    setBoardCursor(cursor);
  };
  const handleKey = (input: string, key: RawKey): boolean => {
    if (boardModeRef.current) {
      const st = stateRef.current;
      // gate 审批问题卡在场让键（模态卡优先，规格 §6）：卡裁决后回板视图，板态跨卡存续——
      // 不让键则问询卡键（↑↓/Enter）被板吞死，卡无法作答
      if (st.status === 'awaiting-question' && st.question) return false;
      const rows = boardRows(st);
      if (key.escape) { setBoard(false); return true; }
      // 空板视图不再自退（2026-10-06 用户实机反馈「Ctrl+T 不起作用」：空板静默吞键无任何反馈）——
      // 进入即渲染「任务板为空」提示框（BoardList 组件层契约），按键吞掉待板事件/Esc 退出
      if (rows.length === 0) return true;
      if (key.upArrow || key.downArrow) {
        // 光标移动零 repaint（列表动态区每帧自绘）；窗口按每页 8 行自动平移（BoardList 同口径）；
        // 回环移动（2026-10-02 交互统一）：问询/审批/计划/斜杠/浏览全部 moveCursor 回环，任务视图同款
        setBoard(true, moveCursor(boardCursorRef.current, rows.length, key.upArrow ? -1 : 1));
        return true;
      }
      if (key.return) {
        const row = rows[Math.max(0, Math.min(rows.length - 1, boardCursorRef.current))];
        if (row?.gated === true) {
          // gate 行内审批（spec §10.3）：askUser 问题卡映射 review——approve 解锁派发/deny 维持挂起；
          // dismissed 静默（沿问询卡取消语义）；review 同步裁决（gate-resolved 事件驱动投影自更新）
          void (async () => {
            const req = await controller.askUser({
              question: t(`Approve gate on ${row.id}?`, `放行 ${row.id} 的门？`),
              options: [{ label: 'approve' }, { label: 'deny' }],
            });
            if (req.type === 'dismissed') return;
            const approved = (req.type === 'selected' && req.labels[0] === 'approve') || (req.type === 'custom' && req.text === 'approve');
            controller.runtime.harness.taskboard.review(row.id, { approved });
          })();
        }
        return true; // 非 gated 行 Enter 无操作（仍吞键不落输入缓冲）
      }
      // Ctrl+C：退出任务视图并走暂停确认分流（同主视图/browse 口径——检视态原语义只退视图）
      if (key.ctrl && input === 'c') {
        setBoard(false);
        if (stateRef.current.pauseConfirm) controller.interrupt();
        else controller.requestPause();
        return true;
      }
      return true; // 模态：其余键不落输入缓冲
    }
    // Ctrl+T 进入任务视图（判定序 browse 之后）：空板也进——渲染「任务板为空」提示框给真实反馈
    //（同上用户实机反馈；原来空板静默吞键=「不起作用」观感）；恒吞键（browse 进入分支同口径）
    if (key.ctrl && input === 't') {
      setBoard(true, 0); // 光标缺省落首行（id 数值序最小）
      return true;
    }
    return false;
  };
  return { boardMode, boardCursor, boardModeRef, handleKey };
}
