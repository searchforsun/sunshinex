import { useRef, useState } from 'react';
import { t } from './i18n';
import { fmtTokens } from './ui-util';

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
  const pct = win > 0 ? Math.min(100, Math.round((used / win) * 100)) : 0;
  // 弧长与示数分离:占用 >0 即画最短 3% 弧(大窗口小会话真值四舍五入为 0% 时圆环不可辨);
  // 弹层示数仍用真实 pct
  const arc = used > 0 ? Math.max(pct, 3) : 0;
  const lv = level(pct);
  const fmt = (n: number): string => n.toLocaleString('en-US');

  const show = (): void => {
    window.clearTimeout(timer.current);
    onOpen?.(); // 每次展开拉新(本地端点零负担,弹层恒见刚落的数据)
    setOpen(true);
  };
  const hide = (): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 150); // 越缝宽限:锚与弹层间隙不闪收
  };

  return (
    <div className="ctx-ring" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className="ctx-ring-btn"
        aria-label={t('Context usage', '上下文占用')}
        aria-expanded={open}
        title={t('Context usage', '上下文占用')}
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
        <div className="sx-menu-pop pill-pop pill-pop-right ctx-pop" role="status" aria-label={t('Context details', '上下文详情')}>
          <div className="ctx-pop-row">
            <span className="k">{t('Context', '上下文')}</span>
            <span className="v">{`${fmt(used)} / ${fmt(win)} · ${pct}%`}</span>
          </div>
          {parts.length > 0 && (
            <>
              <div className="ctx-pop-sec">{t('Composition', '上下文组成')}</div>
              {parts.map((p) => (
                <div className="ctx-pop-row sub" key={p.id}>
                  <span className="k">{partName(p.id)}</span>
                  <span className="v">
                    {fmt(p.tokens)}
                    {p.count > 1 ? <span className="dim">{` · ${p.count}`}</span> : null}
                  </span>
                </div>
              ))}
            </>
          )}
          <div className="ctx-pop-row">
            <span className="k">{t('Turns / Steps', '轮次 / 步数')}</span>
            <span className="v">{`${runs} / ${steps}`}</span>
          </div>
          <div className="ctx-pop-row">
            <span className="k">Tokens</span>
            <span className="v">{fmt(tokens)}</span>
          </div>
          <div className="ctx-pop-row">
            <span className="k">{t('Cache hits', '缓存命中')}</span>
            <span className="v">{fmt(cacheTokens)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
