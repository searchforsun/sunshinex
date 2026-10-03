import * as React from 'react';
import { SessionController, TuiState } from '../session';
import { moveCursor } from './OptionSelector';
import type { SlashMenuEntry } from './SlashMenu';
import type { RawKey } from './use-input';

/** Home/End 终端转义序列体：ink3 不解析这些功能键，按 ESC 剥离前后的两种形态识别（xterm 与应用模式两族） */
const HOME_SEQS = ['[H', 'OH', '[1~', '[7~'];
const END_SEQS = ['[F', 'OF', '[4~', '[8~'];

/** 输入行编辑键分发 hook（D17-H2 拆自 App useInput 第 11 层终点，行为零变化）：
 *  收编主输入框的整段编辑与提交分支——Home/End/⌦ CSI 序列、Ctrl+A/E 双轨、左右光标、斜杠菜单在场 ↑↓
 *  （接管输入历史回填）、运行中撤回排队 ↑、输入历史 ↑↓、Shift/Alt+Enter 换行、Enter（菜单提交选中命令 /
 *  行尾反斜杠续行 / 整行提交）、退格与 ⌦、可打印字符插入——及其专属状态（history / histIdx）。
 *  本层是判定序终点：任何到达此处的键都由本层终结（含无操作路径），恒返回 true。
 *  共享状态（buffer / cursor / 菜单条目 / 菜单光标）经参数传入，不复制 */
export function useLineEditKeys({
  controller,
  buffer,
  cursor,
  setBuffer,
  setCursor,
  status,
  menuEntries,
  slashCursorRef,
  setSlashCursor,
  initialHistory,
  initialHistIdx,
}: {
  controller: SessionController;
  /** 主输入缓冲（App useState 真值，共享不复制） */
  buffer: string;
  cursor: number;
  setBuffer: React.Dispatch<React.SetStateAction<string>>;
  setCursor: React.Dispatch<React.SetStateAction<number>>;
  status: TuiState['status'];
  /** 纵向命令面板条目（在场即接管 ↑↓ 与 Enter 提交，仅 idle/error 形态） */
  menuEntries: readonly SlashMenuEntry[];
  slashCursorRef: React.MutableRefObject<number>;
  setSlashCursor: (v: number) => void;
  /** retain 现场初值（store.history / store.histIdx）：跨重挂输入历史与召回指针不丢 */
  initialHistory: string[];
  initialHistIdx: number;
}): {
  /** 输入历史（App 回写 retain 用；hook 内部提交时追加） */
  history: string[];
  /** 历史指针（-1=未召回；App Ctrl+C/Esc 清空分支复位用） */
  histIdx: number;
  setHistIdx: (v: number | ((prev: number) => number)) => void;
  /** 判定序终点：恒 true（到达即终结） */
  handleKey: (input: string, key: RawKey) => boolean;
} {
  const [history, setHistory] = React.useState<string[]>(initialHistory);
  const [histIdx, setHistIdxState] = React.useState<number>(initialHistIdx);
  const setHistIdx = (v: number | ((prev: number) => number)): void => { setHistIdxState(v); };
  const handleKey = (input: string, key: RawKey): boolean => {
    // Home/End/⌦：ink3 不解析这些功能键，按原始字节序列识别；Ctrl+A/E 惯例双轨
    const csi = key.raw.startsWith('\u001B') ? key.raw.slice(1) : '';
    if (HOME_SEQS.includes(csi)) {
      setCursor(0);
      return true;
    }
    if (END_SEQS.includes(csi)) {
      setCursor(buffer.length);
      return true;
    }
    if (csi === '[3~') {
      // ⌦ 前向删除：删光标处字符（与退格区分靠 ESC 序列）
      if (cursor < buffer.length) setBuffer((b) => b.slice(0, cursor) + b.slice(cursor + 1));
      return true;
    }
    if (key.ctrl && (input === 'a' || input === 'e')) {
      setCursor(input === 'a' ? 0 : buffer.length);
      return true;
    }

    // 光标左右移动（多行缓冲按扁平偏移跨行连续）
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return true;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(buffer.length, c + 1));
      return true;
    }

    // 纵向命令面板 ↑↓（2026-09-30 对标 CC）：菜单在场即接管方向键，输入历史回填让位（非 / 前缀不受影响）；
    // 回环移动与问询卡同款 moveCursor 语义，光标取 ref 真值（闭包滞后先例）
    if ((key.upArrow || key.downArrow) && menuEntries.length > 0 && (status === 'idle' || status === 'error')) {
      setSlashCursor(moveCursor(Math.min(slashCursorRef.current, menuEntries.length - 1), menuEntries.length, key.upArrow ? -1 : 1));
      return true;
    }

    // 运行中撤回排队（对标 CC「Up from the first row」）：有排队穿插且输入框为空时，Up 取回全部待投递行回输入框编辑或清空丢弃
    // （awaiting-approval 态在 handler 前部已被审批卡分流 return，此处只可能是 running）
    if (key.upArrow && status === 'running' && buffer.length === 0) {
      const taken = controller.takeBackQueued();
      if (taken.length > 0) {
        const text = taken.join('\n');
        setBuffer(text);
        setCursor(text.length);
      }
      return true;
    }

    // ↑↓：单行缓冲回填输入历史（多行缓冲不劫持，留给后续行内导航）
    if ((key.upArrow || key.downArrow) && (status === 'idle' || status === 'error') && !buffer.includes('\n')) {
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
      return true;
    }
    // Shift+Enter / Alt+Enter（\x1b\r、\x1b\n、kitty CSI-u）= 输入框内换行（多行缓冲按扁平偏移插入）；
    // 主链提交仍走单 Enter（\r）。终端缺省 Shift+Enter 与 Enter 同发 \r，需键位绑定发送 \x1b\r
    if (key.newline) {
      setBuffer((b) => b.slice(0, cursor) + '\n' + b.slice(cursor));
      setCursor((c) => c + 1);
      return true;
    }
    if (key.return) {
      // 纵向命令面板 Enter（2026-09-30 对标 CC）：菜单在场即提交选中命令（半 typing '/ne' + Enter 直接跑 '/new'，
      // 不再落「无法识别命令」）；带参形态（含空格）过滤必空、菜单不在场，走既有整行提交
      if (menuEntries.length > 0 && (status === 'idle' || status === 'error')) {
        const picked = (menuEntries[Math.min(slashCursorRef.current, menuEntries.length - 1)] ?? menuEntries[0])!.cmd;
        setBuffer('');
        setCursor(0);
        setHistIdx(-1);
        setHistory((h) => [...h.filter((x) => x !== picked), picked].slice(-100));
        controller.submit(picked);
        return true;
      }
      // 行尾单个反斜杠 = 续行（ink3 无法可靠检测 Shift+Enter，回退方案）
      if (buffer.endsWith('\\') && !buffer.endsWith('\\\\')) {
        setBuffer((b) => b.slice(0, -1) + '\n');
        setCursor(buffer.length);
        return true;
      }
      const text = buffer.trim();
      setBuffer('');
      setCursor(0);
      setHistIdx(-1);
      if (text) {
        setHistory((h) => [...h.filter((x) => x !== text), text].slice(-100));
        controller.submit(text);
      }
      return true;
    }
    if (key.backspace || key.delete) {
      if (key.raw === '\u001B[3~') {
        // ⌦ 前向删除：删光标处字符（ink3 原版 useInput 清空 input 无法与退格区分，走补丁版原始字节）
        if (cursor < buffer.length) setBuffer((b) => b.slice(0, cursor) + b.slice(cursor + 1));
        return true;
      }
      // 退格（\u007F / Ctrl+H）：删光标前字符
      if (cursor > 0) {
        setBuffer((b) => b.slice(0, cursor - 1) + b.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
      }
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuffer((b) => b.slice(0, cursor) + input + b.slice(cursor));
      setCursor((c) => c + input.length);
    }
    return true;
  };
  return { history, histIdx, setHistIdx, handleKey };
}
