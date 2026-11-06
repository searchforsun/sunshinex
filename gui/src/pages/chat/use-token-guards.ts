import type { ClipboardEvent, CompositionEvent, Dispatch, FormEvent, KeyboardEvent, MutableRefObject, SetStateAction } from 'react';
import { useRef } from 'react';
import { atomicRange, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './mention';

/**
 * token 原子性守卫·面板无关精简面(2026-11-05 用户裁定「编辑页没有把这些当做一个整体」):
 * 自 use-composer-keys 剥离 token 五面守卫(keydown 跨 token+整删/beforeinput 兜底/paste/
 * composition/select 归位)供编辑卡等次级输入面复用——编辑卡此前零守卫,退格逐字剥芯片
 * 定界符露出 ⟦ 原文=「能直接删除掉 chip」根因。面板键控(文件//命令/$#)不在此面:编辑卡
 * 无面板;IME 组合中 onSelect 归位跳过防打断,组合旗由本 hook 自持。
 */
export function useTokenGuards(deps: {
  /** 受控缓冲真值(useState 共享不复制) */
  readonly value: string;
  readonly setValue: Dispatch<SetStateAction<string>>;
  readonly taRef: MutableRefObject<HTMLTextAreaElement | null>;
}): {
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBeforeInput: (e: FormEvent<HTMLTextAreaElement>) => void;
  onPasteGuard: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onCompositionGuard: (e: CompositionEvent<HTMLTextAreaElement>) => void;
  onCompositionEndGuard: () => void;
  onSelectGuard: () => void;
} {
  const { value, setValue, taRef } = deps;
  const composingRef = useRef(false);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 不可在 token 中间落字(字符键/空格/IME Process):阻止并钉 token 尾(边界编辑放行)
    if ((e.key.length === 1 || e.key === 'Process') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ta = e.currentTarget as HTMLTextAreaElement;
      const cs = ta.selectionStart ?? value.length;
      const ce = ta.selectionEnd ?? cs;
      const [as, ae] = atomicRange(value, cs, ce);
      if (as !== cs || ae !== ce) {
        e.preventDefault();
        ta.setSelectionRange(ae, ae);
        return;
      }
    }
    // ←/→ 单击跨整个 token(有选区时原生移动)
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const ta = e.currentTarget as HTMLTextAreaElement;
      const c = ta.selectionStart ?? 0;
      const ce = ta.selectionEnd ?? c;
      if (c === ce) {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const nc = c + dir;
        if (nc >= 0 && nc <= ta.value.length) {
          const span = tokenSpanAt(ta.value, nc);
          if (span !== null) {
            e.preventDefault();
            ta.setSelectionRange(dir < 0 ? span[0] : span[1], dir < 0 ? span[0] : span[1]);
          }
        }
      }
    }
    if (e.key !== 'Process' && e.nativeEvent.isComposing !== true) composingRef.current = false;
    // token 内 Backspace/Delete 整删不逐字符(「能直接删除掉 chip」根修面)
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const ta = e.currentTarget as HTMLTextAreaElement;
      const caret = ta.selectionStart ?? value.length;
      if (ta.selectionStart === ta.selectionEnd) {
        const range = tokenDeleteRange(value, caret, e.key);
        if (range !== null) {
          e.preventDefault();
          const [s, e2] = range;
          setValue((prev) => prev.slice(0, s) + prev.slice(e2));
          requestAnimationFrame(() => {
            taRef.current?.setSelectionRange(s, s);
          });
          return;
        }
      }
    }
  };

  const onBeforeInput = (e: FormEvent<HTMLTextAreaElement>): void => {
    // 兜底面:键入/IME/粘贴/拖放的部分命中 token 即拦(插入=钉尾;删除=扩整删)
    const ev = e.nativeEvent as InputEvent;
    const ta = e.currentTarget;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    const v = tokenGuardVerdict(value, s, en, ev.inputType ?? '');
    if (v.action === 'redirectEnd') {
      e.preventDefault();
      ta.setSelectionRange(v.to, v.to);
    } else if (v.action === 'splice') {
      e.preventDefault();
      setValue((prev) => prev.slice(0, v.s) + prev.slice(v.e));
      requestAnimationFrame(() => ta.setSelectionRange(v.s, v.s));
    }
  };

  const onPasteGuard = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const ta = e.currentTarget;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    const [as, ae] = atomicRange(value, s, en);
    if (as !== s || ae !== en) {
      e.preventDefault();
      ta.setSelectionRange(ae, ae);
    }
  };

  const onCompositionGuard = (e: CompositionEvent<HTMLTextAreaElement>): void => {
    composingRef.current = true;
    const ta = e.currentTarget;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    const [as, ae] = atomicRange(value, s, en);
    if (as !== s || ae !== en) e.preventDefault();
  };

  const onCompositionEndGuard = (): void => {
    composingRef.current = false;
  };

  const onSelectGuard = (): void => {
    // 光标不落 token 中间:原生移动(↑↓/Home/End)后的兜底归位;IME 组合中跳过防打断
    if (composingRef.current) return;
    const ta = taRef.current;
    if (ta === null) return;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    if (s !== en) return;
    const span = tokenSpanAt(ta.value, s);
    if (span !== null) ta.setSelectionRange(span[1], span[1]);
  };

  return { onKeyDown, onBeforeInput, onPasteGuard, onCompositionGuard, onCompositionEndGuard, onSelectGuard };
}
