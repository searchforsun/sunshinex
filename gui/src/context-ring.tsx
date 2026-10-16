import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { fmtTokens } from './ui-util';
import { zoomScale } from './ui-zoom';

/**
 * G14.18 上下文圆环(composer 模型 pill 左侧):SVG donut 示上文占用率(ctx 面 used/window),
 * hover(或点击/聚焦)弹回溯小层——占用总量+上下文构成明细(ctx 面 parts 逐段 tokens/条数)
 * +轮次步数/累计 tokens/缓存命中。G14.21 裁定:模型·强度行去除(pill 就在圆环旁,冗余)。
 * 纯展示组件:数据由 Chat 注入(sessionContext 拉取 + reducer 累计面),onOpen 供悬停时
 * 拉新(弹层永远看刚落的数据)。色阶随占用率:<70% 常态(accent)、<90% 预警(warn)、
 * 其余高危(err)。弹层复用 pill-pop 定位面(锚右上,展开向左不越卡沿)。
 */

export interface ContextRingProps {
  /** 当前上文占用 tokens(ctx 面估算/水位) */
  used: number;
  /** 窗口预算 tokens(resolveRunWindow 同源) */
  window: number;
  /** 上下文构成明细(ctx 面分段:stable/instructions/skills/memory/compacted/chain/skill) */
  parts: ReadonlyArray<{ id: string; tokens: number; count: number }>;
  /** 会话任务轮数(run 条计数) */
  runs: number;
  /** 会话累计步数 */
  steps: number;
  /** 会话累计 tokens(usage 面) */
  tokens: number;
  /** 会话累计缓存命中 tokens */
  cacheTokens: number;
  /** 弹层将显示(悬停进入/聚焦/点开)——调用方拉新数据 */
  onOpen?: () => void;
}

/** 分段标识 → 展示名(G14.21;id 与 harness contextBreakdown BreakdownPartId 对齐) */
function partName(id: string): string {
  switch (id) {
    case 'stable':
      return t('System', '系统段');
    case 'instructions':
      return t('Instructions', '指令快照');
    case 'skills':
      return t('Skills', '技能快照');
    case 'memory':
      return t('Memory', '记忆');
    case 'compacted':
      return t('Compacted', '压缩块');
    case 'chain':
      return t('Chain', '会话链');
    case 'skill':
      return t('Pending skill', '待注入技能');
    default:
      return id;
  }
}

const R = 7;
const CIRC = 2 * Math.PI * R;

/** 占用率 → 色阶档(0 常态/1 预警/2 高危) */
function level(pct: number): 0 | 1 | 2 {
  if (pct >= 90) return 2;
  if (pct >= 70) return 1;
  return 0;
}

export function ContextRing(props: ContextRingProps): JSX.Element {
  const { used, window: win, parts, runs, steps, tokens, cacheTokens, onOpen } = props;
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const popRef = useRef<HTMLDivElement | null>(null);
  // G14.62:弹层锚圆环向左展开,窄主区会压过菜单分界——展开后量主区左界,越界即右移收回。
  // 用 translateX(right:0 锚定下 margin-left 会被 auto 边吸收,不位移)
  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const main = document.querySelector('.sx-main');
    if (pop === null || main === null) return;
    pop.style.transform = '';
    const over = main.getBoundingClientRect().left + 8 - pop.getBoundingClientRect().left;
    // over 是视觉 px(gBCR 同域),transform 写本地空间=视觉/根放缩(ui-zoom.ts 跨空间契约)
    if (over > 0) pop.style.transform = `translateX(${Math.round(over / zoomScale())}px)`;
  }, [open]);
  const pct = win > 0 ? Math.min(100, Math.round((used / win) * 100)) : 0;
  // 弧长与示数分离:占用 >0 即画最短 3% 弧(大窗口小会话真值四舍五入为 0% 时圆环不可辨);
  // 弹层示数仍用真实 pct
  const arc = used > 0 ? Math.max(pct, 3) : 0;
  const lv = level(pct);
  // G14.77:数值 k/m 单位化(1.2k / 1m;整位 .0 去尾)
  const fmt = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
  };

  const show = (): void => {
    window.clearTimeout(timer.current);
    onOpen?.(); // 每次展开拉新(本地端点零负担,弹层恒见刚落的数据)
    setOpen(true);
  };
  const hide = (): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 150); // 越缝宽限:锚与弹层间隙不闪收
  };

  // G14.97 百分比一位小数(00.0%);token k/m 同 fmt
  const pct1 = (n: number): string => `${(Math.round(n * 10) / 10).toFixed(1)}%`;

  return (
    <div className="ctx-ring" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className="ctx-ring-btn tip-right"
        aria-label={t('Context usage', '上下文占用')}
        aria-expanded={open}
        onFocus={show}
        onBlur={hide}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="ctx-ring-track" cx="9" cy="9" r={R} fill="none" strokeWidth="2" />
          <circle
            className={`ctx-ring-bar lv${lv}`}
            cx="9"
            cy="9"
            r={R}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(arc / 100) * CIRC} ${CIRC}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </button>
      {open && (
        <div
          ref={popRef}
          className="sx-menu-pop pill-pop pill-pop-right ctx-pop"
          role="status"
          aria-label={t('Context details', '上下文详情')}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          {/* G14.97 三分区横线分割:上下文(构成含 token+百分比) / 轮次步数 / 缓存命中率(含具体量) */}
          <div className="ctx-pop-row">
            <span className="k">{t('Context', '上下文')}</span>
            <span className="v">{`${fmt(used)} / ${fmt(win)} · ${pct1((used / Math.max(1, win)) * 100)}`}</span>
          </div>
          {parts.length > 0 && (
            <>
              <div className="ctx-pop-sec">{t('Composition', '上下文组成')}</div>
              {parts.map((p) => (
                <div className="ctx-pop-row sub" key={p.id}>
                  <span className="k">{partName(p.id)}</span>
                  <span className="v">
                    {`${fmt(p.tokens)} · ${pct1((p.tokens / Math.max(1, used)) * 100)}`}
                    {p.count > 1 ? <span className="dim">{` · ${p.count}`}</span> : null}
                  </span>
                </div>
              ))}
            </>
          )}
          <div className="ctx-pop-sep" />
          <div className="ctx-pop-row">
            <span className="k">{t('Turns / Steps', '轮次 / 步数')}</span>
            <span className="v">{`${runs} / ${steps}`}</span>
          </div>
          <div className="ctx-pop-sep" />
          <div className="ctx-pop-row">
            <span className="k">{t('Cache hit rate', '缓存命中率')}</span>
            <span className="v">
              {tokens > 0
                ? `${pct1((cacheTokens / tokens) * 100)} · ${fmt(cacheTokens)}/${fmt(tokens)}`
                : '0.0%'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
