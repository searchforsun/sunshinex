/** 思考强度档位(G14.14 共享):滑动块 0..5 与档位一一对应(daemon effort 白名单序) */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
import type { CSSProperties } from 'react';
import { t } from './i18n';

/** 档位中文显示名（协议值恒发英文——daemon effort 白名单;此处只管显示面） */
const EFFORT_ZH: Partial<Record<(typeof EFFORTS)[number], string>> = {
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
};

/** 档位显示名单点（滑杆刻度与强度徽标共用）：调用期求值 t()——语言热切换即生效;未知值回显原串 */
export function effortLabel(v: string): string {
  const zh = EFFORT_ZH[v as (typeof EFFORTS)[number]];
  return zh === undefined ? v : t(v, zh);
}

/** 思考强度滑动块(G14.14 共享):欢迎页/会话菜单同一渲染——原生 range + 当值/两端刻度。
 *  2026-10-23:--fill 内联填充比例,轨道/滑钮改显式主题变量绘制(原生 accent-color 的
 *  未填充段不受主题变量控制,亮色下发黑——用户实测病) */
export function EffortSlider({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  const idx = Math.max(0, EFFORTS.indexOf(value as (typeof EFFORTS)[number]));
  const pct = Math.round((idx / (EFFORTS.length - 1)) * 100);
  return (
    <div className="effort-slider">
      <input
        type="range"
        min={0}
        max={EFFORTS.length - 1}
        step={1}
        aria-label="reasoning effort"
        value={idx}
        style={{ '--fill': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(EFFORTS[Number(e.target.value)])}
      />
      <div className="effort-scale" aria-hidden="true">
        <span>{effortLabel(EFFORTS[0])}</span>
        <span className="effort-now">{effortLabel(EFFORTS[idx])}</span>
        <span>{effortLabel(EFFORTS[EFFORTS.length - 1])}</span>
      </div>
    </div>
  );
}

/** 强度徽标(pill 内的档位标识,G14.14:替代 · 分割——特殊样式标识思考强度) */
export function EffortChip({ effort }: { effort: string }): JSX.Element {
  return <span className="model-effort-chip">{effortLabel(effort)}</span>;
}
