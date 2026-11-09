import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ClipboardEvent, CompositionEvent, FormEvent, KeyboardEvent, MutableRefObject, ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { canonicalizeRefTokens, tokenSpanAt } from '../pages/chat/mention';

/**
 * 统一 composer 卡(G12 用户裁定「不要两个版本」):欢迎页与会话中共用同一份输入卡实现——
 * 卡面(elevated+radius-composer+海拔,样式单源 app.css `.sx-composer`)内 = textarea(自增高,
 * 行数随换行 1-6)+ footer(左 pills 组/右动作组)。会话中与欢迎页的唯一差异 = 欢迎页在卡外
 * (welcome-dock 内)多一个项目选择条,卡本体零差异。
 * overlays 命令面板/浮层锚定卡根(position:relative);belowInput 承载输入与 footer 之间的
 * 行内内容(错误条)。label 即 textarea 的 aria-label(测试查询锚:'welcome goal'/'message input')。
 * G14.95 高亮层:highlight 在场 → textarea 文字透明,背后同步排版的高亮层着色 token
 * (@文件 //命令 //skill);缺省无层,textarea 正常显字。
 * IME 组字期(2026-11-05 用户实测「组字期芯片消失」根修):不再隐高亮层/实色切换——textarea
 * 恒透明(单绘制无叠影),组字段由调用面经 onCompositionRange 回抛在高亮层压平为普通前景段
 * (既有芯片全程保留);组字下划线由浏览器装饰层绘制,不受透明字影响。
 */
export interface ComposerCardProps {
  /** textarea aria-label(查询锚) */
  label: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  /** 换行数派生 1-6 自增高(调用面算好传入;缺省 1) */
  rows?: number;
  onChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** G14.212 token 原子性守卫(Chat tokenGuardVerdict):beforeinput/paste/composition 三面拦
   *  「token 中间插入/部分删除」——命中即阻止,插入面光标钉 token 尾,删除面扩整删 */
  onBeforeInput?: (e: FormEvent<HTMLTextAreaElement>) => void;
  onPasteGuard?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onCompositionGuard?: (e: CompositionEvent<HTMLTextAreaElement>) => void;
  /** 组字段范围上抛(2026-11-05 用户裁定「组字期芯片消失」根修):组字开始/更新/结束三拍回抛
   *  {start,end}(end=start+data.length;结束=null)——调用面据此把组字段在高亮层压平为普通段,
   *  叠层恒可见(既有芯片不再随组字隐藏),textarea 恒透明(单绘制无叠影) */
  onCompositionRange?: (range: { start: number; end: number } | null) => void;
  /** G14.213 光标不落 token 中间:选区变化归位(↑↓/Home/End 等原生移动的兜底) */
  onSelectGuard?: () => void;
  onCompositionEndGuard?: () => void;
  /** 卡根附加类(会话语境的限宽/贴底在 `.composer`) */
  className?: string;
  /** absolute 浮层(命令面板等),锚卡根渲染在输入之前 */
  overlays?: ReactNode;
  /** 输入与 footer 之间的行内内容(错误条等) */
  belowInput?: ReactNode;
  /** footer 左组(pills)/右组(发送等动作) */
  footLeft?: ReactNode;
  footRight?: ReactNode;
  /** textarea 引用(插入面板收口后焦点回输入框) */
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
  /** 会话私有 ref 内容账本(2026-11-07):规范化重写 token 原文时账本键随迁(真搬)。缺席=只走
   *  全局注册表补缺(不覆盖)——账本缺席面(编辑卡/欢迎页)token 键迁移仅注册表兜底 */
  refLedger?: MutableRefObject<Map<string, string> | null>;
  /** G14.95 token 高亮层(与 textarea 同排版;缺省无层,textarea 正常显字) */
  highlight?: ReactNode;
  /** G14.135 输入区点击(坐标落点已换算 caret):@文件 token 点击开侧栏标签 */
  onInputClick?: () => void;
  /** G14.144 目录树文件拖入:rel 路径落输入框(自动 @文件) */
  onDropFile?: (rel: string) => void;
  /** 图片附件(2026-10-26):待发 dataURL 列(缺省/空=无条);缩略图条在输入框上方 */
  images?: string[];
  onRemoveImage?: (index: number) => void;
  /** 缩略图点击开查看浮层(缩放/复制/下载) */
  onImageOpen?: (src: string) => void;
  /** 粘贴图片文件(clipboardData.files 含图即接管,e.preventDefault 后回调;非图粘贴走 token 守卫) */
  onPasteFiles?: (files: File[]) => void;
}

export function ComposerCard({
  label,
  value,
  placeholder,
  disabled,
  rows = 1,
  onChange,
  onKeyDown,
  onBeforeInput,
  onPasteGuard,
  onCompositionGuard,
  onCompositionRange,
  onSelectGuard,
  onCompositionEndGuard,
  onInputClick,
  onDropFile,
  images,
  onRemoveImage,
  onImageOpen,
  onPasteFiles,
  className,
  overlays,
  belowInput,
  footLeft,
  footRight,
  inputRef,
  refLedger,
  highlight,
}: ComposerCardProps): JSX.Element {
  const hlRef = useRef<HTMLDivElement | null>(null);
  // 自增高(2026-11-05 用户实测「手动输入不长高只有粘贴才长」):rows 随换行数派生,软换行的长行不加 

  // =rows 不变→过早出纵向滚动条;改为按内容实际高度自增(scrollHeight,封顶 240px 与 CSS max-height 同源)
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (ta === null) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [value, rows, highlight]);
  // 滚动同步兜底(2026-11-05 用户实测「复制正常,上下滚动后光标对不齐」):onScroll 同步之外,
  // 渲染后再钉一次——React 提交若瞬态缩短高亮内容,浏览器把 hl.scrollTop 钳到 0 且内容长回
  // 不恢复=层间错位(onScroll 只在滚动事件期救,不救渲染期钳制)
  useLayoutEffect(() => {
    const ta = taRef.current;
    const hl = hlRef.current;
    if (ta === null || hl === null) return;
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  }, [value, rows, highlight]);
  // 草稿 ref token 规范形(2026-11-07 用户实测「清理后再圈选,芯片飞/图标压字」根修):显示层
  // 重编号不改原文→·2 被显示成第 1 枚(短 2 字)=镜像层宽≠原文宽自此错位。此处把草稿原文
  // 规范化为草稿序(注册表键随迁),原文恒等显示;光标越过首个差异位时按长度差平移,落 token
  // 中间则钉尾(tokenSpanAt 同守卫口径)
  useEffect(() => {
    const next = canonicalizeRefTokens(value);
    if (next === null) return;
    // 会话私有账本真搬(rename 清单;全局注册表已在 canonicalize 内只补缺不覆盖)
    const ledger = refLedger?.current;
    if (ledger !== undefined && ledger !== null) {
      for (const { from, to } of next.renames) {
        const c = ledger.get(from);
        if (c !== undefined) {
          ledger.set(to, c);
          ledger.delete(from);
        }
      }
    }
    const ta = inputRef?.current ?? taRef.current;
    const caret = ta?.selectionStart ?? null;
    const selEnd = ta?.selectionEnd ?? null;
    onChange(next.text);
    if (ta !== null && ta !== undefined && caret !== null && caret > next.at) {
      const nc = Math.max(next.at, caret + next.delta);
      const span = tokenSpanAt(next.text, nc);
      const pin = span !== null ? span[1] : nc;
      requestAnimationFrame(() => {
        const el = inputRef?.current ?? taRef.current;
        if (el !== null && el !== undefined) el.setSelectionRange(pin, selEnd !== null && selEnd > caret ? Math.max(pin, selEnd + next.delta) : pin);
      });
    }
  });
  /** IME 组字起点(组字段范围上抛用;null=无组字) */
  const compStartRef = useRef<number | null>(null);
  /** 粘贴分流:剪贴板带图片文件即接管(图片不进文本,token 守卫无意义);纯文本粘贴走守卫 */
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0 && onPasteFiles !== undefined) {
      e.preventDefault();
      onPasteFiles(files);
      return;
    }
    onPasteGuard?.(e);
  };
  const strip = images !== undefined && images.length > 0;
  return (
    <div className={className !== undefined ? `sx-composer ${className}` : 'sx-composer'}>
      {overlays}
      {strip && (
        <div className="sx-img-strip" aria-label={t('Attached images', '附件图片')}>
          {images!.map((src, i) => (
            <div key={`${i}:${src.slice(-24)}`} className="sx-img-thumb">
              <img src={src} alt={`${t('Attached image', '附件图片')} ${i + 1}`} decoding="async" onClick={() => onImageOpen?.(src)} />
              {onRemoveImage !== undefined && (
                <button
                  type="button"
                  className="sx-img-remove"
                  aria-label={t('Remove image', '移除图片')}
                  data-tip={t('Remove', '移除')}
                  onClick={() => onRemoveImage(i)}
                >
                  <X size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {highlight !== undefined ? (
        /* G14.106 包裹式对齐:highlight 与 textarea 同 wrapper 同盒(inset 0 即 textarea 盒),
           天然无错位(此前 inset 挂卡根,少卡的 padding 位移 → 文字偏左上) */
        <div className="sx-composer-inputwrap">
          <div className="sx-composer-highlight" aria-hidden="true" ref={hlRef}>
            {highlight}
          </div>
          <textarea
            ref={(el) => { taRef.current = el; if (inputRef !== undefined) inputRef.current = el; }}
            aria-label={label}
            className="sx-composer-input transparent-text"
            spellCheck={false}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            rows={rows}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onBeforeInput={onBeforeInput}
            onPaste={handlePaste}
            onCompositionStart={(e) => {
              compStartRef.current = e.currentTarget.selectionStart ?? e.currentTarget.value.length;
              onCompositionRange?.({ start: compStartRef.current, end: compStartRef.current });
              onCompositionGuard?.(e);
            }}
            onCompositionUpdate={(e) => {
              const start = compStartRef.current;
              if (start !== null) onCompositionRange?.({ start, end: start + e.data.length });
            }}
            onCompositionEnd={() => {
              compStartRef.current = null;
              onCompositionRange?.(null);
              onCompositionEndGuard?.();
            }}
            onSelect={onSelectGuard}
            onClick={() => onInputClick?.()}
            onDragOver={(e) => {
              // 有 sunshinex-file 即放行放置(拦 text/plain 原生插入绝对路径——欢迎页未接
              // onDropFile 时曾整段路径进框)
              if ([...e.dataTransfer.types].includes('text/sunshinex-file')) e.preventDefault();
            }}
            onDrop={(e) => {
              const rel = e.dataTransfer.getData('text/sunshinex-file');
              if (rel !== '') {
                e.preventDefault();
                e.stopPropagation();
                onDropFile?.(rel);
              }
            }}
            onScroll={(e) => {
              const hl = hlRef.current;
              if (hl !== null) {
                hl.scrollTop = e.currentTarget.scrollTop;
                hl.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
          />
        </div>
      ) : (
        <textarea
          ref={inputRef}
          aria-label={label}
          className="sx-composer-input"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBeforeInput={onBeforeInput}
          onPaste={handlePaste}
          onCompositionStart={(e) => onCompositionGuard?.(e)}
          onCompositionEnd={() => onCompositionEndGuard?.()}
          onSelect={onSelectGuard}
        />
      )}
      {belowInput}
      <div className="sx-composer-foot">
        <div className="sx-composer-foot-left">{footLeft}</div>
        <div className="sx-composer-foot-right">{footRight}</div>
      </div>
    </div>
  );
}
