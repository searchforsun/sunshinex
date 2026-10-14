import type { KeyboardEvent, MutableRefObject, ReactNode } from 'react';

/**
 * 统一 composer 卡(G12 用户裁定「不要两个版本」):欢迎页与会话中共用同一份输入卡实现——
 * 卡面(elevated+radius-composer+海拔,样式单源 app.css `.sx-composer`)内 = textarea(自增高,
 * 行数随换行 1-6)+ footer(左 pills 组/右动作组)。会话中与欢迎页的唯一差异 = 欢迎页在卡外
 * (welcome-dock 内)多一个项目选择条,卡本体零差异。
 * overlays 命令面板/浮层锚定卡根(position:relative);belowInput 承载输入与 footer 之间的
 * 行内内容(错误条)。label 即 textarea 的 aria-label(测试查询锚:'welcome goal'/'message input')。
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
}

export function ComposerCard({
  label,
  value,
  placeholder,
  disabled,
  rows = 1,
  onChange,
  onKeyDown,
  className,
  overlays,
  belowInput,
  footLeft,
  footRight,
  inputRef,
}: ComposerCardProps): JSX.Element {
  return (
    <div className={className !== undefined ? `sx-composer ${className}` : 'sx-composer'}>
      {overlays}
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
      />
      {belowInput}
      <div className="sx-composer-foot">
        <div className="sx-composer-foot-left">{footLeft}</div>
        <div className="sx-composer-foot-right">{footRight}</div>
      </div>
    </div>
  );
}
