import { useRef } from 'react';
import type { ClipboardEvent, CompositionEvent, FormEvent, KeyboardEvent, MutableRefObject, ReactNode } from 'react';

/**
 * 统一 composer 卡(G12 用户裁定「不要两个版本」):欢迎页与会话中共用同一份输入卡实现——
 * 卡面(elevated+radius-composer+海拔,样式单源 app.css `.sx-composer`)内 = textarea(自增高,
 * 行数随换行 1-6)+ footer(左 pills 组/右动作组)。会话中与欢迎页的唯一差异 = 欢迎页在卡外
 * (welcome-dock 内)多一个项目选择条,卡本体零差异。
 * overlays 命令面板/浮层锚定卡根(position:relative);belowInput 承载输入与 footer 之间的
 * 行内内容(错误条)。label 即 textarea 的 aria-label(测试查询锚:'welcome goal'/'message input')。
 * G14.95 高亮层:highlight 在场 → textarea 文字透明,背后同步排版的高亮层着色 token
 * (@文件 //命令 //skill);缺省无层,textarea 正常显字。
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
  /** G14.95 token 高亮层(与 textarea 同排版;缺省无层,textarea 正常显字) */
  highlight?: ReactNode;
  /** G14.135 输入区点击(坐标落点已换算 caret):@文件 token 点击开侧栏标签 */
  onInputClick?: () => void;
  /** G14.144 目录树文件拖入:rel 路径落输入框(自动 @文件) */
  onDropFile?: (rel: string) => void;
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
  onSelectGuard,
  onCompositionEndGuard,
  onInputClick,
  onDropFile,
  className,
  overlays,
  belowInput,
  footLeft,
  footRight,
  inputRef,
  highlight,
}: ComposerCardProps): JSX.Element {
  const hlRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className={className !== undefined ? `sx-composer ${className}` : 'sx-composer'}>
      {overlays}
      {highlight !== undefined ? (
        /* G14.106 包裹式对齐:highlight 与 textarea 同 wrapper 同盒(inset 0 即 textarea 盒),
           天然无错位(此前 inset 挂卡根,少卡的 padding 位移 → 文字偏左上) */
        <div className="sx-composer-inputwrap">
          <div className="sx-composer-highlight" aria-hidden="true" ref={hlRef}>
            {highlight}
          </div>
          <textarea
            ref={inputRef}
            aria-label={label}
            className="sx-composer-input transparent-text"
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            rows={rows}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onBeforeInput={onBeforeInput}
            onPaste={onPasteGuard}
            onCompositionStart={onCompositionGuard}
            onCompositionEnd={onCompositionEndGuard}
            onSelect={onSelectGuard}
            onClick={() => onInputClick?.()}
            onDragOver={(e) => {
              if (onDropFile !== undefined && [...e.dataTransfer.types].includes('text/sunshinex-file')) e.preventDefault();
            }}
            onDrop={(e) => {
              const rel = e.dataTransfer.getData('text/sunshinex-file');
              if (onDropFile !== undefined && rel !== '') {
                e.preventDefault();
                e.stopPropagation();
                onDropFile(rel);
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
          onPaste={onPasteGuard}
          onCompositionStart={onCompositionGuard}
          onCompositionEnd={onCompositionEndGuard}
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
