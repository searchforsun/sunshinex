import { t } from './i18n';

/**
 * 「/」命令面板(G10-C4,spec §3):Codex 式——命令+双语描述、过滤、↑↓ 导航、Tab 补全、Enter 执行。
 * 数据源 = GET /commands(TUI SLASH_COMMANDS 单点下发);supported 集 == daemon command 通道支持集,
 * 集外项置灰(title 注明缘由,禁假入口)。过滤/键盘归 Chat 的 textarea 处理(焦点恒在输入面),
 * 本组件纯渲染 + hover 选区。
 */
export interface CmdItem {
  cmd: string;
  name: string;
  desc: string;
  /** 前缀匹配 0 分;包含匹配按位置——前缀优先 */
  idx: number;
  ok: boolean;
}

export function filterCommands(
  commands: readonly string[],
  descriptions: Record<string, string>,
  seed: string,
  supported: readonly string[],
): CmdItem[] {
  const q = seed.trim().toLowerCase();
  return commands
    .map((c) => {
      const name = c.slice(1);
      const idx = name.indexOf(q);
      return { cmd: c, name, desc: descriptions[name] ?? '', idx, ok: supported.includes(c) };
    })
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx);
}

export interface CommandPaletteProps {
  readonly items: CmdItem[];
  readonly active: number;
  readonly onHover: (index: number) => void;
  readonly onPick: (item: CmdItem) => void;
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const { items, active, onHover, onPick } = props;
  return (
    <div className="cmd-palette" role="listbox" aria-label={t('command palette', '命令面板')}>
      {items.length === 0 && <div className="cmd-empty">{t('No matching command', '没有匹配的命令')}</div>}
      {items.map((item, i) => (
        <button
          key={item.cmd}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`cmd-item${i === active ? ' active' : ''}${item.ok ? '' : ' disabled'}`}
          title={item.ok ? item.desc : t('Not available in this GUI', '此处不可用(GUI 原生面/TUI 专属/未移植)')}
          onMouseEnter={() => onHover(i)}
          onClick={() => {
            if (!item.ok) return; // 置灰项不可跑(TUI 专属/GUI 原生/未移植)——禁假入口
            onPick(item);
          }}
        >
          <span className="cmd-name">{item.cmd}</span>
          <span className="cmd-desc">{item.desc}</span>
        </button>
      ))}
    </div>
  );
}
