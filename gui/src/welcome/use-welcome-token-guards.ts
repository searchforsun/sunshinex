import { useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { atomicRange, tokenGuardVerdict, tokenSpanAt } from '../pages/Chat';

/** D62 批E 自 WelcomeComposer 平移的输入卡 token 原子性守卫簇(G14.212/213,与会话内同构):
 *  onBeforeInput 兜底/paste 守卫/IME 组合三件/onSelect 归位;闭包随 goal 重挂,行为零变化。 */
export function useWelcomeTokenGuards(goal: string, goalRef: RefObject<HTMLTextAreaElement | null>, setGoal: Dispatch<SetStateAction<string>>): {
  goalComposingRef: React.MutableRefObject<boolean>;
  onBeforeInput: (e: React.FormEvent<HTMLTextAreaElement>) => void;
  onPasteGuard: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onCompositionGuard: (e: React.CompositionEvent<HTMLTextAreaElement>) => void;
  onCompositionEndGuard: () => void;
  onSelectGuard: () => void;
} {
  /** G14.213 IME 组合中标记:onSelect 归位在组合期跳过(防打断输入法) */
  const goalComposingRef = useRef(false);
  return {
    goalComposingRef,
    onBeforeInput: (e) => {
      // G14.212 token 原子性兜底面(与会话内同构)
      const ev = e.nativeEvent as InputEvent;
      const ta = e.currentTarget;
      const s = ta.selectionStart ?? 0;
      const en = ta.selectionEnd ?? 0;
      const v = tokenGuardVerdict(goal, s, en, ev.inputType ?? '');
      if (v.action === 'redirectEnd') {
        e.preventDefault();
        ta.setSelectionRange(v.to, v.to);
      } else if (v.action === 'splice') {
        e.preventDefault();
        setGoal((prev) => prev.slice(0, v.s) + prev.slice(v.e));
        requestAnimationFrame(() => ta.setSelectionRange(v.s, v.s));
      }
    },
    onPasteGuard: (e) => {
      const ta = e.currentTarget;
      const s = ta.selectionStart ?? 0;
      const en = ta.selectionEnd ?? 0;
      const [as, ae] = atomicRange(goal, s, en);
      if (as !== s || ae !== en) {
        e.preventDefault();
        ta.setSelectionRange(ae, ae);
      }
    },
    onCompositionGuard: (e) => {
      goalComposingRef.current = true; // G14.213 组合中:onSelect 归位跳过
      const ta = e.currentTarget;
      const s = ta.selectionStart ?? 0;
      const en = ta.selectionEnd ?? 0;
      const [as, ae] = atomicRange(goal, s, en);
      if (as !== s || ae !== en) e.preventDefault();
    },
    onCompositionEndGuard: () => {
      goalComposingRef.current = false;
    },
    onSelectGuard: () => {
      // G14.213 光标不落 token 中间:↑↓/Home/End 等原生移动后的兜底归位(IME 组合中跳过)
      if (goalComposingRef.current) return;
      const ta = goalRef.current;
      if (ta === null) return;
      const s = ta.selectionStart ?? 0;
      const en = ta.selectionEnd ?? 0;
      if (s !== en) return;
      const span = tokenSpanAt(ta.value, s);
      if (span !== null) ta.setSelectionRange(span[1], span[1]);
    },
  };
}
