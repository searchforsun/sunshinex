import type { ClipboardEvent, CompositionEvent, Dispatch, FormEvent, KeyboardEvent, MutableRefObject, SetStateAction } from 'react';
import type { Connection } from '../../connection';
import type { CmdItem } from '../../CommandPalette';
import { pathBasename } from '../../ui-util';
import { atomicRange, rankFileHits, slashTokenAt, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './mention';
import { slashItemsFor } from './use-command-palette';

/**
 * Composer 输入面键分发与守卫（D32 批G 补批：自 Chat.tsx 内联 props 平移，行为零变化）——
 * token 原子性三面（keydown 跨 token/beforeinput 兜底/paste-composition-select 归位）、@ 文件面板
 * 键控（方向循环/Enter 选中/Esc）、/ 命令面板键控（补全/整行直跑）、/memory 精确键、退格 token 整删、
 * Enter 提交分流。判定序与各分支语义注记随码保留；共享状态（input/cursor 面板态/记账表）经参数传入
 * 不复制——hook 仅收编分支本体，渲染面（overlays/belowInput）仍留宿主。
 */

/** @ 文件面板态（Chat useState 真值，共享不复制） */
export interface ComposerFilePal {
  query: string;
  from: number;
}

/** 命令池快照（useCommandPalette 返回的 cmdData 形态） */
interface ComposerCmdData {
  commands: string[];
  descriptions: Record<string, string>;
  supported: string[];
}

export function useComposerKeys(deps: {
  /** 主输入缓冲（App/Chat useState 真值，共享不复制） */
  readonly input: string;
  readonly setInput: Dispatch<SetStateAction<string>>;
  readonly inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** IME 组合中标记（组合期跳过 onSelect 归位，防打断输入法） */
  readonly composingRef: MutableRefObject<boolean>;
  readonly filePal: ComposerFilePal | null;
  readonly setFilePal: Dispatch<SetStateAction<ComposerFilePal | null>>;
  readonly filePalFiles: string[];
  readonly setFilePalFiles: Dispatch<SetStateAction<string[]>>;
  readonly filePalActive: number;
  readonly setFilePalActive: Dispatch<SetStateAction<number>>;
  /** 工作区文件索引懒加载（@ 面板每次命中即拉） */
  readonly loadWorkspaceFiles: () => Promise<string[]>;
  /** @短写 → 相对路径记账表（发送期 expandFileRefs 解析第一优先） */
  readonly pickRelRef: MutableRefObject<Map<string, string>>;
  readonly cmdData: ComposerCmdData | null;
  readonly setCmdData: Dispatch<SetStateAction<ComposerCmdData | null>>;
  /** 技能池快照(useCommandPalette 形态:{id,description};slashItemsFor 消费侧) */
  readonly skillCmds: Array<{ id: string; description: string }>;
  readonly cmdActive: number;
  readonly setCmdActive: Dispatch<SetStateAction<number>>;
  readonly conn: Connection;
  readonly sessionId: string;
  readonly send: () => void;
  readonly onOpenMemory?: () => void;
}): {
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBeforeInput: (e: FormEvent<HTMLTextAreaElement>) => void;
  onPasteGuard: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onCompositionGuard: (e: CompositionEvent<HTMLTextAreaElement>) => void;
  onCompositionEndGuard: () => void;
  onSelectGuard: () => void;
} {
  const { input, setInput, inputRef, composingRef, filePal, setFilePal, filePalFiles, setFilePalFiles, filePalActive, setFilePalActive, loadWorkspaceFiles, pickRelRef, cmdData, setCmdData, skillCmds, cmdActive, setCmdActive, conn, sessionId, send, onOpenMemory } = deps;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // G14.212 token 原子性:不可在 token 中间落字(字符键/空格/IME Process)——阻止并把
    // 光标钉到 token 尾,下一击落边界;边界编辑(:L 行锚续写)放行
    if ((e.key.length === 1 || e.key === 'Process') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const taA = e.currentTarget as HTMLTextAreaElement;
      const cs = taA.selectionStart ?? input.length;
      const ce = taA.selectionEnd ?? cs;
      const [as, ae] = atomicRange(input, cs, ce);
      if (as !== cs || ae !== ce) {
        e.preventDefault();
        taA.setSelectionRange(ae, ae);
        return;
      }
    }
    // G14.213 ←/→ 单击跨整个 token(尾→头 / 头→尾,不逐字走进中间);有选区时原生移动
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const taA = e.currentTarget as HTMLTextAreaElement;
      const c = taA.selectionStart ?? 0;
      const ce = taA.selectionEnd ?? c;
      if (c === ce) {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const nc = c + dir;
        if (nc >= 0 && nc <= taA.value.length) {
          const span = tokenSpanAt(taA.value, nc);
          if (span !== null) {
            e.preventDefault();
            const to = dir < 0 ? span[0] : span[1];
            taA.setSelectionRange(to, to);
          }
        }
      }
    }
    if (e.key !== 'Process' && e.nativeEvent.isComposing !== true) composingRef.current = false; // 组合结束兜底复位(合成事件无 isComposing,取原生)
    // G14.148 /memory(-rm) 精确输入 + Enter → 开记忆标签(不进面板补全循环/命令通道;
    // TUI 交互多选在 GUI 的同位=记忆标签的勾选删除面)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && /^\/memory(-rm)?\s*$/.test(input)) {
      e.preventDefault();
      setInput('');
      onOpenMemory?.();
      return;
    }
    // G14.156 @/技能 token 整体删除:无选区时 token 内 Backspace/Delete 整删不逐字符
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const ta = e.currentTarget as HTMLTextAreaElement;
      const caret = ta.selectionStart ?? input.length;
      if (ta.selectionStart === ta.selectionEnd) {
        const range = tokenDeleteRange(input, caret, e.key);
        if (range !== null) {
          e.preventDefault();
          const [s, e2] = range;
          setInput((prev) => prev.slice(0, s) + prev.slice(e2));
          requestAnimationFrame(() => { inputRef.current?.setSelectionRange(s, s); });
          return;
        }
      }
    }
    // G14.85 @ 工作区文件选择:光标前 @token → 文件面板(方向循环/Enter 选中/Esc 关闭)
    // G14.121 token 兼容绝对路径(:\ /);选中插入绝对路径(底层索引统一绝对路径口径)
    // G14.211 面板活性=锚点仍在(input[filePal.from]==='@'):键面 preventDefault 直改
    // 输入(token 整删等)不触发 onChange,残锚面板在此收口——否则空输入仍按残 query
    // 命中旧文件,面板滞留且 Enter 可幽灵插入
    const taEl = e.currentTarget as HTMLTextAreaElement;
    const caret = taEl.selectionStart ?? input.length;
    const atMatch = /@([\w./:\\-]*)$/.exec(input.slice(0, caret));
    if (atMatch !== null) {
      setFilePal({ query: atMatch[1] ?? '', from: caret - (atMatch[1]?.length ?? 0) - 1 });
      void loadWorkspaceFiles().then((files) => setFilePalFiles(files));
    } else if (filePal !== null && input[filePal.from] !== '@') {
      setFilePal(null);
    }
    if (atMatch !== null || (filePal !== null && input[filePal.from] === '@')) {
      const items = rankFileHits(filePalFiles, filePal?.query ?? '');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length > 0) {
          setFilePalActive((a) => (e.key === 'ArrowDown' ? (a + 1) % items.length : (a - 1 + items.length) % items.length));
          setFilePal((fp) => fp ?? { query: '', from: 0 });
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setFilePal(null);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && items.length > 0) {
        e.preventDefault();
        const rel = items[Math.min(filePalActive, items.length - 1)];
        // G14.126 选中只插短写 @文件名(输入框显形=图标+文件名);相对路径记入账本,
        // 发送期 expandFileRefs 据此展开为 md 绝对链接;按 @token 区间替换。
        // 目录项(尾斜杠内部标记):插入文本不带斜杠,记账保标记——芯片/展开面判目录
        const base = pathBasename(rel);
        pickRelRef.current.set(base, rel);
        const atFrom = filePal?.from ?? caret - (atMatch?.[1]?.length ?? 0) - 1;
        const atEnd = atFrom + 1 + (filePal?.query ?? '').length;
        setInput((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
        setFilePal(null);
        return;
      }
    }
    // G14.95 / 面板:开头=命令+技能;中间=仅技能;无匹配(items 空)面板不开=自动关
    const slashToken = atMatch === null ? slashTokenAt(input, caret) : null;
    const slashItems = slashItemsFor(cmdData, skillCmds, slashToken);
    if (slashToken !== null && slashItems.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCmdActive((a) => (e.key === 'ArrowDown' ? (a + 1) % slashItems.length : (a - 1 + slashItems.length) % slashItems.length));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCmdData(null); // 本次收起(重开输入 / 即回)
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        // 2026-10-26 用户报障「/ 面板回车直接发送」:cmdActive 是上次面板残留索引,过滤后
        // 列表变短即越界 undefined→Enter 两分支全跳过落 send()。取值一律钳制到界内
        const item = slashItems[Math.min(cmdActive, slashItems.length - 1)];
        if (item !== undefined) setInput((prev) => prev.slice(0, slashToken.from) + item.cmd + ' ' + prev.slice(caret));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        const item: CmdItem | undefined = slashItems[Math.min(cmdActive, slashItems.length - 1)];
        // G14.213 命令项+参数已敲:整行直跑(supported 判定在清单);skill 项不在此列——
        // 落底部纯文本发送(daemon 已 400,skills 普通文本语义)
        if (item !== undefined && item.kind === 'cmd' && input.includes(' ') && item.ok && slashToken.atStart) {
          e.preventDefault();
          setInput('');
          // 命令回执/错误经 WS notice 帧可见化(命令气泡已入档);catch 只兜 HTTP 层——网络失败=命令未执行零回执,输入已清空的轻损失(D30 口径:可见化由主提交路径承担)
          conn.runCommand(sessionId, input).catch(() => {});
          return;
        }
        // 补全仅当 / 词尚未敲完(无参数);skill 项参数已敲同样落底部纯文本发送
        if (item !== undefined && !input.includes(' ')) {
          e.preventDefault();
          setInput((prev) => prev.slice(0, slashToken.from) + item.cmd + ' ' + prev.slice(caret)); // 补全,面板续开收参数
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault(); // 提交不分流换行进内容面(受控清空,防闪换行)
      send();
    }
  };

  const onBeforeInput = (e: FormEvent<HTMLTextAreaElement>): void => {
    // G14.212 token 原子性兜底面:键入/IME/粘贴/拖放的 beforeinput 部分命中 token 即拦
    // (插入=光标钉 token 尾;删除=扩整删)——keydown 网之外的编辑面在此收口
    const ev = e.nativeEvent as InputEvent;
    const ta = e.currentTarget;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    const v = tokenGuardVerdict(input, s, en, ev.inputType ?? '');
    if (v.action === 'redirectEnd') {
      e.preventDefault();
      ta.setSelectionRange(v.to, v.to);
    } else if (v.action === 'splice') {
      e.preventDefault();
      setInput((prev) => prev.slice(0, v.s) + prev.slice(v.e));
      requestAnimationFrame(() => ta.setSelectionRange(v.s, v.s));
    }
  };

  const onPasteGuard = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const ta = e.currentTarget;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    const [as, ae] = atomicRange(input, s, en);
    if (as !== s || ae !== en) {
      e.preventDefault();
      ta.setSelectionRange(ae, ae);
    }
  };

  const onCompositionGuard = (e: CompositionEvent<HTMLTextAreaElement>): void => {
    composingRef.current = true; // G14.213 组合中:onSelect 归位跳过
    const ta = e.currentTarget;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    const [as, ae] = atomicRange(input, s, en);
    if (as !== s || ae !== en) e.preventDefault();
  };

  const onCompositionEndGuard = (): void => {
    composingRef.current = false;
  };

  const onSelectGuard = (): void => {
    // G14.213 光标不落 token 中间:↑↓/Home/End 等原生移动后的兜底归位(钉 token 尾;
    // ←→ 在 keydown 已跨 token);IME 组合中跳过防打断
    if (composingRef.current) return;
    const ta = inputRef.current;
    if (ta === null) return;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    if (s !== en) return;
    const span = tokenSpanAt(ta.value, s);
    if (span !== null) ta.setSelectionRange(span[1], span[1]);
  };

  return { onKeyDown, onBeforeInput, onPasteGuard, onCompositionGuard, onCompositionEndGuard, onSelectGuard };
}
