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
  /** 2026-11-06 用户裁定 P4/P5 插入通道作用域化:全局广播只被目标面消费('main'=主对话,'side'=辅助
   *  会话[草稿+真会话])——此前无目标全局广播,主/侧两 composer 同时挂载=「添加到主对话两边都加」 */
  readonly target?: 'main' | 'side';
}): { onInputClick: () => void } {
  const { pickRelRef, refContents, inputRef, setInput, input, resolveFileRef, onOpenFile, target = 'main' } = deps;
/** G14.139 文件标签选区「添加到会话」:接收插入事件(文件图标+文件名(L30-L35) token 落输入框) */
useEffect(() => {
  const onInsert = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ text?: string; rel?: string; kind?: string; token?: string; content?: string; target?: 'main' | 'side' }>).detail;
    // 作用域过滤(2026-11-06 P4/P5):事件目标≠本面即忽略(undefined=历史派发默认主对话)
    if ((detail?.target ?? 'main') !== target) return;
    // 2026-11-04 元素/终端片段引用:token 落输入框(⟦…⟧ 高亮芯片),全量内容入账本发送期展开;
    // 同步写全局注册表(refContentRegistry)——气泡/队列等无账本 prop 的渲染面 hover 取数源
    if (detail !== undefined && detail.kind === 'ref' && typeof detail.token === 'string' && detail.token !== '' && typeof detail.content === 'string') {
      const token: string = detail.token;
      refContents.current.set(token, detail.content);
      refContentRegister(token, detail.content);
      // 2026-11-05 用户裁定「光标贴 chip」:ref token 不再补尾随空格——光标钉在 token 末即贴芯片
      // (用户自己决定是否敲空格续写)。分隔符退回半角空格(原全角　是旧尾悬图标吃空格的补偿,
      // 图标已收进头部占位区,半角即可;全角在气泡 markdown 管线被吞=芯片粘连、且间距过大)
      // 2026-11-06 用户裁定「圈选进辅助会话不应累积之前的」:side 目标=整替(新圈选即新问题,
      // 此前 append 多次圈选全堆叠);main(文件标签「添加到会话」)保持追加
      setInput(target === 'side' ? token : (prev) => (prev.trim() === '' ? token : `${prev.replace(/\s+$/, '')} ${token}`));
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
    // 整条即 ref token(正文圈选 {text} 通道)同款不补尾随空格,光标贴芯片;分隔符半角空格(同上)
    setInput(target === 'side' ? text : (prev) => (prev.trim() === '' ? text : `${prev.replace(/\s+$/, '')} ${text}`));
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
