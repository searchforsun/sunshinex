import { baseModelName } from '../pages/Chat';
import { EffortSlider } from '../effort-slider';

/** 欢迎页模型菜单（D62 批D 自 WelcomeComposer 外提——行为零变化）：模型清单（当前项 ✓+强调色，
 *  显示名比对——defaultModel 带前缀/变体尾串而 choice id 裸名，精确 id 比对恒 false）+思考强度滑块
 *  （2026-11-06 用户裁定「思考强度文字全局去掉」：仅留滑块，标题行退役）。选中派发经 onPick。 */
export function WelcomeModelMenu({
  choices,
  current,
  effort,
  onPick,
  onEffort,
}: {
  choices: Array<{ id: string; effort?: string }>;
  /** 当前生效模型（selModel ?? defaultModel；undefined=全走缺省兜底显示面） */
  current: string | undefined;
  effort: string;
  onPick: (id: string, effort?: string) => void;
  onEffort: (e: string) => void;
}): JSX.Element {
  return (
    <div className="sx-menu-pop pill-pop pill-pop-right" role="menu" aria-label="model menu">
      {choices.map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitem"
          className={`sx-menuitem${current !== undefined && baseModelName(c.id) === baseModelName(current) ? ' current' : ''}`}
          data-tip={c.id}
          onClick={() => onPick(c.id, c.effort)}
        >
          {baseModelName(c.id)}
        </button>
      ))}
      <EffortSlider value={effort} onChange={onEffort} />
    </div>
  );
}
