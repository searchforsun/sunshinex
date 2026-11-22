import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { t } from '../i18n';

/**
 * 设置页自绘控件（设置重构轮）：下拉 Select 与建议 Combo——弹层制（非原生 <select>），
 * 弹层样式与项目 sx-menu-pop 同语言（elevated 面+prominent 阴影+圆角+menuitem 行 hover）。
 * - Select：受控单选。trigger 按钮显当值+chevron；弹层 listbox（role=option 行，当值高亮+
 *   check 标），键面 ↑↓ 移动/Enter 选中/Esc 收、外点收；disabled（env 覆盖行）禁触发。
 * - Combo：自由文本输入+动态建议面（模型 id 等开放值集——建议自 providers 动态来，自由
 *   键入恒合法）；过滤大小写不敏感包含序，点击建议即落值，Esc/外点收。
 * - SecretInput：密钥回显输入（2026-11-22 用户裁定「密钥可回显」）——password/明文显隐切换
 *   （Eye/EyeOff），值受控上层持。布局复用 sx-setting-path（输入+右缘钮，路径行同款）。
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
  /** 包裹层附加类(2026-10-29 用户裁定:工具栏作用域/项目下拉定宽——sx-dd-fixed 150px,
   *  超长项目名 ellipsis 截断;不随内容伸缩) */
  readonly className?: string;
  readonly onChange: (v: string) => void;
}): JSX.Element {
  const { value, options, disabled = false, title, ariaLabel, placeholder, className, onChange } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  /** 弹层翻转(2026-11-22 用户裁定「下拉显示不全就翻转显示到上面」):下方空间不足容纳弹层
   *  时向上弹(.sx-dd-pop-up)。open 后实测弹层底缘 vs 视口底缘,越界即翻转 */
  const [dropUp, setDropUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLUListElement | null>(null);
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

  /** 开弹层即激活当值行并滚入视口（键盘导航起点=当前值）+ 翻转测量（2026-11-22 用户裁定
   *  「下拉显示不全就翻转显示到上面」）:按**最近的滚动容器**(弹窗体/设置主区)量上下空间——
   *  下放不下且上空间更大即翻转。按打开瞬间的容器位置判定,不随滚动抖动;jsdom 无布局
   *  (全 0 rect)不触发,测试面零影响 */
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.v === value);
    setActive(idx >= 0 ? idx : 0);
    activeRef.current?.scrollIntoView?.({ block: 'nearest' }); // jsdom 无此 API——可选调用(真实浏览器内滚动定位)
    setDropUp(false);
    const raf = requestAnimationFrame(() => {
      const wrap = wrapRef.current;
      const pop = popRef.current;
      if (wrap === null || pop === null) return;
      // 最近的可滚动祖先(弹窗体/设置主区)——弹层被谁裁切就对谁量空间
      let scroller: HTMLElement | null = null;
      let el: HTMLElement | null = wrap.parentElement;
      while (el !== null && el !== document.body) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') { scroller = el; break; }
        el = el.parentElement;
      }
      const wrapRect = wrap.getBoundingClientRect();
      const estH = Math.min(pop.scrollHeight, 264) + 16;
      let spaceBelow: number;
      let spaceAbove: number;
      if (scroller !== null) {
        const cRect = scroller.getBoundingClientRect();
        spaceBelow = cRect.bottom - wrapRect.bottom;
        spaceAbove = wrapRect.top - cRect.top;
      } else {
        spaceBelow = window.innerHeight - wrapRect.bottom;
        spaceAbove = wrapRect.top;
      }
      setDropUp(spaceBelow < estH && spaceAbove > spaceBelow);
    });
    return () => cancelAnimationFrame(raf);
    // options/value 在场期不变（弹层开着上层不改值），只随 open 跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (v: string): void => {
    setOpen(false);
    onChange(v);
  };

  const onTriggerKey = (e: React.KeyboardEvent): void => {
    // Esc 收弹层（2026-11-20）：焦点在 trigger 时 list 的 onKeyDown 收不到，不能让 Esc 冒泡到
    // 页面级监听（定时任务配置页会误退回列表）
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
      return;
    }
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
    <div className={className === undefined ? 'sx-dd' : `sx-dd ${className}`} ref={wrapRef}>
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
        <ul ref={popRef} className={`sx-dd-pop${dropUp ? ' sx-dd-pop-up' : ''}`} role="listbox" id={listId} aria-label={ariaLabel} onKeyDown={onListKey}>
          {options.map((o, i) => (
            <li key={o.v}>
              <button
                type="button"
                role="option"
                aria-selected={o.v === value}
                className={`sx-dd-opt${i === active ? ' active' : ''}`}
                ref={o.v === value ? activeRef : undefined}
                data-tip={o.l} /* 长项目名省略后 hover 显全名(2026-10-31 用户裁定);data-tip=
                                  项目统一气泡面(全局单例层),title 原生提示与项目风格不合已退役 */
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

/** SecretInput 密钥回显输入（2026-11-22 用户裁定「密钥可回显」）：password/明文显隐切换（眼睛钮）；
 *  值受控上层持——回显已存值由上层播种。布局复用路径行 sx-setting-path（输入+右缘钮） */
export function SecretInput(props: {
  readonly value: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly autoComplete?: string;
  readonly onChange: (v: string) => void;
}): JSX.Element {
  const { value, ariaLabel, placeholder, disabled = false, autoComplete = 'off', onChange } = props;
  const [shown, setShown] = useState(false);
  return (
    <div className="sx-setting-path">
      <input
        type={shown ? 'text' : 'password'}
        className="sx-setting-input"
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="sx-setting-path-btn"
        aria-label={`${shown ? t('Hide', '隐藏') : t('Show', '显示')} ${ariaLabel}`}
        aria-pressed={shown}
        disabled={disabled}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={14} strokeWidth={1.75} aria-hidden="true" />}
      </button>
    </div>
  );
}

/**
 * MultiSelect 多选下拉（2026-11-22 用户裁定「聊天命令配置——一个下拉多选（每项的命令以及
 * 说明）」）：Select 同构弹层克隆——trigger 显摘要（全选=「全部」/空=「不开启」/部分=已选名
 * 逗号连），弹层 checkbox 行（Check 图标勾选标），点击行即翻转勾选（弹层不收，连续多选）；
 * 外点收/Esc 收；翻转测量与 Select 同款（最近滚动容器上下空间,jsdom 零 rect 不触发）。纯受控。
 */
export function MultiSelect(props: {
  readonly values: readonly string[];
  readonly options: readonly SelectOption[];
  readonly ariaLabel: string;
  readonly allLabel: { en: string; zh: string };
  readonly noneLabel: { en: string; zh: string };
  readonly onChange: (next: string[]) => void;
}): JSX.Element {
  const { values, options, ariaLabel, allLabel, noneLabel, onChange } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLUListElement | null>(null);
  const [dropUp, setDropUp] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /** 翻转测量（Select 同款:最近滚动容器上下空间,开瞬间判定不随滚动抖动） */
  useEffect(() => {
    if (!open) return;
    setDropUp(false);
    const raf = requestAnimationFrame(() => {
      const wrap = wrapRef.current;
      const pop = popRef.current;
      if (wrap === null || pop === null) return;
      let scroller: HTMLElement | null = null;
      let el: HTMLElement | null = wrap.parentElement;
      while (el !== null && el !== document.body) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') { scroller = el; break; }
        el = el.parentElement;
      }
      const wrapRect = wrap.getBoundingClientRect();
      const estH = Math.min(pop.scrollHeight, 264) + 16;
      let spaceBelow: number;
      let spaceAbove: number;
      if (scroller !== null) {
        const cRect = scroller.getBoundingClientRect();
        spaceBelow = cRect.bottom - wrapRect.bottom;
        spaceAbove = wrapRect.top - cRect.top;
      } else {
        spaceBelow = window.innerHeight - wrapRect.bottom;
        spaceAbove = wrapRect.top;
      }
      setDropUp(spaceBelow < estH && spaceAbove > spaceBelow);
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const toggle = (v: string): void => {
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  };
  /** trigger 摘要:全选=「全部」/空=「不开启」/部分=已选项名逗号连 */
  const summary =
    values.length === options.length
      ? t(allLabel.en, allLabel.zh)
      : values.length === 0
        ? t(noneLabel.en, noneLabel.zh)
        : options
            .filter((o) => values.includes(o.v))
            .map((o) => o.l)
            .join('、');
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
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sx-dd-value">{summary}</span>
        <span className={`sx-dd-chevron${open ? ' up' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <ul ref={popRef} className={`sx-dd-pop${dropUp ? ' sx-dd-pop-up' : ''}`} role="listbox" aria-multiselectable="true" id={listId} aria-label={ariaLabel}>
          {options.map((o) => {
            const on = values.includes(o.v);
            return (
              <li key={o.v}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`sx-dd-opt${on ? ' selected' : ''}`}
                  title={o.l} /* 命令+说明双段:原生 title 折行展示说明(data-tip 单例气泡不折行) */
                  onClick={() => toggle(o.v)}
                >
                  <span className={`sx-dd-multi-box${on ? ' on' : ''}`} aria-hidden="true">
                    {on && <span className="sx-dd-multi-check">✓</span>}
                  </span>
                  <span className="sx-dd-opt-label">{o.l}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
