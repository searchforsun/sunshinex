import { useEffect, useId, useRef, useState } from 'react';

/**
 * 设置页自绘控件（设置重构轮）：下拉 Select 与建议 Combo——弹层制（非原生 <select>），
 * 弹层样式与项目 sx-menu-pop 同语言（elevated 面+prominent 阴影+圆角+menuitem 行 hover）。
 * - Select：受控单选。trigger 按钮显当值+chevron；弹层 listbox（role=option 行，当值高亮+
 *   check 标），键面 ↑↓ 移动/Enter 选中/Esc 收、外点收；disabled（env 覆盖行）禁触发。
 * - Combo：自由文本输入+动态建议面（模型 id 等开放值集——建议自 providers 动态来，自由
 *   键入恒合法）；过滤大小写不敏感包含序，点击建议即落值，Esc/外点收。
 * 两件皆纯受控（值与 onChange 全由上层持——表单引擎统一 values 表），弹层内滚
 * （max-height+overflow）不出设置主区滚动面。
 */

export interface SelectOption {
  readonly v: string;
  readonly l: string;
}

export function Select(props: {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly disabled?: boolean;
  /** env 覆盖禁编提示（data-tip 全局单例气泡面，§13.1 规则 2） */
  readonly title?: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly onChange: (v: string) => void;
}): JSX.Element {
  const { value, options, disabled = false, title, ariaLabel, placeholder, onChange } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  /** 外点收：mousedown 在包裹外即收（trigger 点击自身由 toggle 先行，不双触发） */
  useEffect(() => {
    if (!open) return;
          // 外点收语义(与 SessionRowMenu 弹层/归档 morph 各表其面):本件=容器外 mousedown 即收,
          // 不监听滚动/resize(下拉锚定文档流内,无 fixed 裁切面)

    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /** 开弹层即激活当值行并滚入视口（键盘导航起点=当前值） */
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.v === value);
    setActive(idx >= 0 ? idx : 0);
    activeRef.current?.scrollIntoView?.({ block: 'nearest' }); // jsdom 无此 API——可选调用(真实浏览器内滚动定位)
    // options/value 在场期不变（弹层开着上层不改值），只随 open 跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (v: string): void => {
    setOpen(false);
    onChange(v);
  };

  const onTriggerKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[active];
      if (o !== undefined) pick(o.v);
    }
  };

  const current = options.find((o) => o.v === value);
  const listId = useId();
  return (
    <div className="sx-dd" ref={wrapRef}>
      <button
        type="button"
        className="sx-dd-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        data-tip={title}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
      >
        <span className={`sx-dd-value${current === undefined ? ' placeholder' : ''}`}>{current?.l ?? placeholder ?? ''}</span>
        <span className={`sx-dd-chevron${open ? ' up' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <ul className="sx-dd-pop" role="listbox" id={listId} aria-label={ariaLabel} onKeyDown={onListKey}>
          {options.map((o, i) => (
            <li key={o.v}>
              <button
                type="button"
                role="option"
                aria-selected={o.v === value}
                className={`sx-dd-opt${i === active ? ' active' : ''}`}
                ref={o.v === value ? activeRef : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.v)}
              >
                <span className="sx-dd-opt-label">{o.l}</span>
                {o.v === value && <span className="sx-dd-opt-check" aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Combo 建议面容量（开放值集只提示不穷举——自由键入恒合法） */
const COMBO_SUGGEST_CAP = 8;

export function Combo(props: {
  readonly value: string;
  readonly suggestions: readonly string[];
  readonly disabled?: boolean;
  readonly title?: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly onChange: (v: string) => void;
  /** 提交回调(自动保存轮):失焦/Enter 时携带当值上抛——文本类控件不逐键保存,落焦即存 */
  readonly onCommit?: (v: string) => void;
}): JSX.Element {
  const { value, suggestions, disabled = false, title, ariaLabel, placeholder, onChange, onCommit } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /** 建议=当值非空按包含过滤，空值全量（截前 8）；当值已在集内仍显示（可改选他项） */
  const needle = value.trim().toLowerCase();
  const filtered = (needle === '' ? suggestions : suggestions.filter((s) => s.toLowerCase().includes(needle))).slice(0, COMBO_SUGGEST_CAP);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="sx-dd sx-combo" ref={wrapRef}>
      <input
        type="text"
        className="sx-setting-input sx-combo-input"
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        data-tip={title}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          onCommit?.(value);
        }}
        onChange={(e) => {
          setOpen(true);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); // Enter=提交(经 blur 单路径)
        }}
      />
      {open && !disabled && filtered.length > 0 && (
        <ul className="sx-dd-pop sx-combo-pop" role="listbox" aria-label={`${ariaLabel} suggestions`}>
          {filtered.map((s) => (
            <li key={s}>
              <button type="button" role="option" aria-selected={s === value} className="sx-dd-opt" onMouseDown={(e) => e.preventDefault()} onClick={() => {
                setOpen(false);
                onChange(s);
              }}>
                <span className="sx-dd-opt-label">{s}</span>
                {s === value && <span className="sx-dd-opt-check" aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
