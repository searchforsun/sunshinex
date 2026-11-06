import type { ClipboardEvent, CompositionEvent, Dispatch, FormEvent, KeyboardEvent, MutableRefObject, SetStateAction } from 'react';
import type { Connection } from '../../connection';
import type { CmdItem } from '../../CommandPalette';
import { pathBasename } from '../../ui-util';
import { atomicRange, rankFileHits, slashTokenAt, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './mention';
import type { RefEntries, RefPal } from './ref-palette';
import { flatRefItems, refTokenAt } from './ref-palette';
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
  /** $/# 引用面板态（agents-teams P1 Task 4，spec §3.2——形态/活性锚/键控全镜像 @ 面板） */
  readonly refPal: RefPal | null;
  readonly setRefPal: Dispatch<SetStateAction<RefPal | null>>;
  /** 两目录缓存（agents+teams id/name 投影；Chat 首触懒拉,失败静默空列） */
  readonly refEntries: RefEntries;
  readonly refActive: number;
  readonly setRefActive: Dispatch<SetStateAction<number>>;
  /** 首触懒加载（Chat 提供,内部自缓存——每次命中调它,重复触发零网络） */
  readonly loadRefEntries: () => void;
  readonly cmdData: ComposerCmdData | null;
  readonly setCmdData: Dispatch<SetStateAction<ComposerCmdData | null>>;
  readonly cmdActive: number;
  readonly setCmdActive: Dispatch<SetStateAction<number>>;
  /** 技能引用行(2026-11-05 用户裁定:技能回归 / 触发面板——与渲染面 slashPanelItems 同源,
   *  键盘清单与 DOM 清单防漂移) */
  readonly skills: Array<{ id: string; desc: string }>;
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
  // conn/sessionId 随整行直跑分支退役(2026-11-06)自解构移除,接口字段保留(调用面零改)
  const { input, setInput, inputRef, composingRef, filePal, setFilePal, filePalFiles, setFilePalFiles, filePalActive, setFilePalActive, loadWorkspaceFiles, pickRelRef, refPal, setRefPal, refEntries, refActive, setRefActive, loadRefEntries, cmdData, setCmdData, cmdActive, setCmdActive, skills, send, onOpenMemory } = deps;

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
    // agents-teams P1 §3.2 $/# 引用面板(双组单游标,优先于 @// 键面):caret 前 $/# token 命中
    // 即开面板 + 首触懒加载(loadRefEntries 自缓存,重复命中零网络);活性锚镜像 G14.211 @(锚位
    // 非 $/# 即关——键面 preventDefault 直改输入不触发 onChange,残锚面板在此收口)。命中符号
    // token 与 @// 后缀互斥(同一 caret 前缀不可能同时以 @词与 $/#词 收尾),故此处收口的键
    // (↑↓/Esc/Enter)不会再落入下方 @// 面板分支
    const refTok = refTokenAt(input, caret);
    if (refTok !== null) {
      setRefPal(refTok);
      // 游标重置只住 Chat onChange(查询变更点)——键面不重置(评审 2026-11-04):refTok 在
      // caret 贴 token 时每次键击都命中,此处若 setRefActive(0) 会排在方向键函数式更新之前,
      // ↑↓ 恒落第二行/末行,跨组循环死;@ 键控面同款先例(从不重置 filePalActive)
      loadRefEntries();
    } else if (refPal !== null && input[refPal.from] !== '$' && input[refPal.from] !== '#') {
      setRefPal(null);
    }
    const effRefPal = refTok ?? refPal;
    if (effRefPal !== null && (refTok !== null || input[effRefPal.from] === '$' || input[effRefPal.from] === '#')) {
      // $/# 拆开各自单域(2026-11-05 用户裁定)——与渲染面 slashPanelItems/refPanelItems 同源防漂移
      const items = flatRefItems(refEntries, effRefPal.query, effRefPal.sym);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length > 0) {
          setRefActive((a) => (e.key === 'ArrowDown' ? (a + 1) % items.length : (a - 1 + items.length) % items.length));
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setRefPal(null);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && items.length > 0) {
        e.preventDefault();
        // R4 裁定:插入 `$id `/`#id `(尾随空格)即终态——无 @ 的 pickRelRef 记账语义,
        // 发送期零展开;替换区间=from..query 尾(镜像 @ 键控插入面)
        const item = items[Math.min(refActive, items.length - 1)];
        const from = effRefPal.from;
        const end = from + 1 + effRefPal.query.length;
        setInput((prev) => prev.slice(0, from) + `${item.sym}${item.id} ` + prev.slice(Math.max(end, from)));
        setRefPal(null);
        return;
      }
    }
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
    // G14.95 / 面板:内置命令清单 + 技能引用行(2026-11-05 用户裁定回归;kind='skill' 插入语义,
    // 命令通道退役口径不变);无匹配(items 空)面板不开=自动关
    const slashToken = atMatch === null ? slashTokenAt(input, caret) : null;
    const slashItems = slashItemsFor(cmdData, slashToken, skills);
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
        // 2026-11-06 用户裁定「撤整行直跑:不要自动发出去,真伪判定单点在 submitText」续:
        // 面板在场(光标处于 /query 且有匹配项)时 Enter=插入高亮项(替换 query+尾随空格,光标钉
        // 插入尾沿)——第二个 / 的选同样正常添加,绝不落发送;无匹配(面板自动关)才落 send()=
        // 普通文本,命令真伪判定仍单点在 submitText
        const item: CmdItem | undefined = slashItems[Math.min(cmdActive, slashItems.length - 1)];
        if (slashToken !== null && item !== undefined) {
          e.preventDefault();
          const from = slashToken.from;
          setInput((prev) => prev.slice(0, from) + item.cmd + ' ' + prev.slice(Math.max(caret, from)));
          requestAnimationFrame(() => {
            const ta = inputRef.current;
            if (ta !== null) {
              const to = Math.min(from + item.cmd.length + 1, ta.value.length);
              ta.setSelectionRange(to, to);
            }
          });
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
