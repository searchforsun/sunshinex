import { useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { pathBasename } from '../../ui-util';
import { refContentRegister, splitMentionTokens, tokenSpanAt } from './mention';

/** composer 侧挂面(D32 第六批批F-7b 自 Chat.tsx 平移,行为零变化):文件标签「添加到会话」
 *  插入事件(G14.139,短写 token 记账+光标钉尾)/输入区点击 @token 开文件标签(G14.135,解析同
 *  发送期口径)。@ 面板键链留宿主(第二十轮裁定不动)。 */
export function useChatComposerSide(deps: {
  readonly pickRelRef: MutableRefObject<Map<string, string>>;
  /** 2026-11-04 元素/终端片段引用账本(token 全文⟦…⟧→全量内容;发送期 expandRefContents 展开) */
  readonly refContents: MutableRefObject<Map<string, string>>;
  readonly inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly setInput: Dispatch<SetStateAction<string>>;
  readonly input: string;
  readonly resolveFileRef: (name: string) => string | undefined;
  readonly onOpenFile?: (p: string) => void;
}): { onInputClick: () => void } {
  const { pickRelRef, refContents, inputRef, setInput, input, resolveFileRef, onOpenFile } = deps;
/** G14.139 文件标签选区「添加到会话」:接收插入事件(文件图标+文件名(L30-L35) token 落输入框) */
useEffect(() => {
  const onInsert = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ text?: string; rel?: string; kind?: string; token?: string; content?: string }>).detail;
    // 2026-11-04 元素/终端片段引用:token 落输入框(⟦…⟧ 高亮芯片),全量内容入账本发送期展开;
    // 同步写全局注册表(refContentRegistry)——气泡/队列等无账本 prop 的渲染面 hover 取数源
    if (detail !== undefined && detail.kind === 'ref' && typeof detail.token === 'string' && detail.token !== '' && typeof detail.content === 'string') {
      const token: string = detail.token;
      refContents.current.set(token, detail.content);
      refContentRegister(token, detail.content);
      // 2026-11-05 用户裁定「光标贴 chip」:ref token 不再补尾随空格——⟧ 定界符自身占位,
      // 光标钉在 token 末即贴芯片(用户自己决定是否敲空格续写)
      setInput((prev) => (prev.trim() === '' ? token : `${prev.replace(/\s+$/, '')} ${token}`));
      inputRef.current?.focus();
      requestAnimationFrame(() => {
        const ta = inputRef.current;
        if (ta !== null) ta.setSelectionRange(ta.value.length, ta.value.length);
      });
      return;
    }
    if (detail === undefined || typeof detail.text !== 'string' || detail.text === '') return;
    const text: string = detail.text;
    // G14.211 短写 token(@文件名:L):全相对路径入账本,发送期 expandFileRefs 据此展开
    if (typeof detail.rel === 'string' && detail.rel !== '') {
      const base = detail.rel.split(/[\\/]/).pop() ?? detail.rel;
      pickRelRef.current.set(base, detail.rel);
    }
    // 整条即 ref token(正文圈选 {text} 通道)同款不补尾随空格,光标贴芯片
    const bareRef = /^⟦[^⟧]{1,120}⟧$/.test(text);
    setInput((prev) => (prev.trim() === '' ? text : `${prev.replace(/\s+$/, '')} ${text}${bareRef ? '' : ' '}`));
    inputRef.current?.focus();
    // G14.211 光标钉尾:focus 恢复的是 textarea 旧光标位(此前离开输入框时留在原处),
    // 渲染提交后一帧再设到末尾——否则光标落回旧位=token 中间(「不挨着文件」)
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (ta !== null) ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  };
  window.addEventListener('sunshinex:insert-ref', onInsert);
  return () => window.removeEventListener('sunshinex:insert-ref', onInsert);
}, []);
/** G14.135 输入区点击 @文件 token → 解析并开侧栏 file 标签(click 后 caret 已落在 textarea,
 *  按 token 区间命中判定;解析同发送期口径:记账/索引兜底/带目录直用) */
const onInputClick = (): void => {
  const ta = inputRef.current;
  if (ta === null) return;
  const caret = ta.selectionStart ?? 0;
  // G14.213 点击落在 token 中间 → 光标钉 token 尾(file token 命中开标签的行为在先,不变)
  const span0 = tokenSpanAt(input, caret);
  if (span0 !== null) ta.setSelectionRange(span0[1], span0[1]);
  if (onOpenFile === undefined) return;
  let pos = 0;
  for (const tk of splitMentionTokens(input)) {
    const s = pos;
    const e = pos + tk.text.length;
    pos = e;
    if (tk.kind !== 'file' || caret <= s || caret > e) continue;
    const token = tk.text.slice(1);
    const anchor = /^(.*):(L\d+(?:-L\d+)?)$/.exec(token);
    const name = anchor !== null ? anchor[1] : token;
    const rel = resolveFileRef(pathBasename(name)) ?? (name.includes('/') ? name : undefined);
    if (rel !== undefined) onOpenFile(rel);
    return;
  }
};
  return { onInputClick };
}
