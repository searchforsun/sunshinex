import { useEffect, useRef } from 'react';
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
  /** G14.213 命令=走命令通道;skill=纯文本语义(有参数已敲时 Enter 落普通发送,不 runCommand) */
  kind: 'cmd' | 'skill';
}

/** 内置命令描述 zh 面(2026-10-31 用户裁定「/命令也要支持 i18n」,自 ComposerPlusPanel 上移单源):
 *  daemon /commands 描述随 **daemon** 语言(settings 链)装配,GUI 语言独立时英文穿透——
 *  本表渲染期 t(原文, zh) 求值随语言切换,unknown 命令回落 daemon 原文;键=去斜杠命令词,
 *  与 src/tui/slash-commands.ts 同源口径 */
const CMD_DESC_ZH: Record<string, string> = {
  help: '查看可用命令',
  init: '分析生成/完善 SUNSHINE.md',
  status: '会话与账本摘要',
  'terminal-setup': '配置终端键位（Shift+Enter 换行，Windows Terminal）',
  tasks: '列出后台任务',
  skill: '加载技能进上下文',
  new: '新会话（软重置）',
  resume: '恢复已保存会话',
  rewind: '回退到更早的任务轮',
  fork: '分叉出平行会话',
  btw: '辅助问答（fork 旁路，不进主链）：/btw <问题>',
  side: '辅助问答（/btw 别名）',
  archive: '归档当前会话（移出主列表）',
  unarchive: '撤销归档（选择卡）',
  delete: '删除当前会话（须先归档）',
  compact: '压缩上下文',
  context: '上下文各段占比与大小',
  plan: '先规划后执行',
  goal: '运行完整验收修正环',
  model: '切换模型（多源清单）',
  'model-tier': '切换模型档位',
  'model-effort': '切换思考强度',
  mcp: 'MCP 服务器面板（清单/启停/批准/拒绝）',
  agents: '子智能体面板（清单/启停）',
  plugins: '插件面板（清单/启停）',
  providers: '模型提供方面板（只读清单）',
  'add-dir': '扩展信任目录',
  'kb-index': '构建知识库索引',
  memory: '列出持久记忆',
  'memory-add': '添加记忆',
  'memory-rm': '删除记忆（多选卡）',
  'memory-gc': '立即整理记忆',
  'memory-on': '本会话开启持久记忆',
  'memory-off': '本会话关闭持久记忆',
};

/** 命令描述本地化单点(渲染期求值):/name 与裸名双容错;zh 表未登记=回落 daemon 原文。
 *  「/」聊天面板与 composer「+」面板共用(同数据源同口径) */
export function cmdDescOf(name: string, daemonDesc: string): string {
  const bare = name.startsWith('/') ? name.slice(1) : name;
  const zh = CMD_DESC_ZH[bare];
  return zh === undefined ? daemonDesc : t(daemonDesc, zh);
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
      return { cmd: c, name, desc: descriptions[name] ?? '', idx, ok: supported.includes(c), kind: 'cmd' as const };
    })
    // G14.160 不可用命令不展示(supported 过滤;曾经灰化+划线,用户裁定直接不列)
    .filter((x) => x.idx >= 0 && x.ok)
    .sort((a, b) => a.idx - b.idx);
}

export interface CommandPaletteProps {
  readonly items: CmdItem[];
  readonly active: number;
  readonly onHover: (index: number) => void;
  readonly onPick: (item: CmdItem) => void;
  /** 首行域标(2026-11-05 用户裁定:弹层第一行示「/ 命令 技能」——命令/技能上下分组说明) */
  readonly header?: string;
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const { items, active, onHover, onPick } = props;
  // G14.163 ↑↓ 移动时选中项滚入可视区(block:nearest 最小滚动;items 变化即过滤后 active 行也换)
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, items]);
  return (
    <div className="cmd-palette" role="listbox" aria-label={t('command palette', '命令面板')}>
      {props.header !== undefined && <div className="ref-palette-head">{props.header}</div>}
      {items.length === 0 && <div className="cmd-empty">{t('No matching command', '没有匹配的命令')}</div>}
      {items.map((item, i) => {
        const desc = cmdDescOf(item.name, item.desc); // 渲染期本地化(内置命令 zh 表;技能项回落原文)
        return (
          <button
            key={item.cmd}
            ref={i === active ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`cmd-item${i === active ? ' active' : ''}${item.ok ? '' : ' disabled'}`}
            data-tip={item.ok ? desc : t('Not available in this GUI', '此处不可用(GUI 原生面/TUI 专属/未移植)')}
            onMouseEnter={() => onHover(i)}
            onClick={() => {
              if (!item.ok) return; // 置灰项不可跑(TUI 专属/GUI 原生/未移植)——禁假入口
              onPick(item);
            }}
          >
            <span className="cmd-name">{item.cmd}</span>
            <span className="cmd-desc">{desc}</span>
          </button>
        );
      })}
    </div>
  );
}
