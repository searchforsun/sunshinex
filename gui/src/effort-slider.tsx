/** 思考强度档位(G14.14 共享):滑动块 0..5 与档位一一对应(daemon effort 白名单序) */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 思考强度滑动块(G14.14 共享):欢迎页/会话菜单同一渲染——原生 range + 当值/两端刻度 */
export function EffortSlider({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  const idx = Math.max(0, EFFORTS.indexOf(value as (typeof EFFORTS)[number]));
  return (
    <div className="effort-slider">
      <input
        type="range"
        min={0}
        max={EFFORTS.length - 1}
        step={1}
        aria-label="reasoning effort"
        value={idx}
        onChange={(e) => onChange(EFFORTS[Number(e.target.value)])}
      />
      <div className="effort-scale" aria-hidden="true">
        <span>{EFFORTS[0]}</span>
        <span className="effort-now">{EFFORTS[idx]}</span>
        <span>{EFFORTS[EFFORTS.length - 1]}</span>
      </div>
    </div>
  );
}

/** 强度徽标(pill 内的档位标识,G14.14:替代 · 分割——特殊样式标识思考强度) */
export function EffortChip({ effort }: { effort: string }): JSX.Element {
  return <span className="model-effort-chip">{effort}</span>;
}
