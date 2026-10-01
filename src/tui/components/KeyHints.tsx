import { t } from '../../i18n';
import { Text } from 'ink';
import { displayWidth } from '../text-band';
import type { TuiState } from '../session';

/**
 * 恒驻键提示条（2026-10-02 用户裁决「所有交互处显示快捷键、按状态切换、样式统一、一眼可见」）：
 * 单一组件承载全部快捷键提示——常态暗灰一行（键名亮、动作暗），emphasized 态灰底反显
 * （浏览接管/暂停确认等需要用户决断的瞬态）。条目按状态由 keyHintsFor 矩阵给出（纯函数可单测），
 * 超宽按优先序截断（排序即优先级，首位恒保留）。
 * 帧高纪律：本条恒 1 行，调用方（App previewCap / ChildInspector textCap）必须计入 chrome 实账。
 */

export interface KeyHintItem {
  key: string;
  action: string;
}

export interface KeyHintsView {
  items: KeyHintItem[];
  /** true=灰底反显（瞬态决断：暂停确认/浏览接管）；false=常态暗灰 */
  emphasized: boolean;
}

/** 键提示矩阵单点：状态 → 条目（排序即截断优先序，首位最关键恒保留）。
 *  模态卡（审批/计划/问询）在场返回 undefined=条退场——卡内自带 hint，避免双显。 */
export function keyHintsFor(s: {
  status: TuiState['status'];
  approval?: unknown;
  question?: unknown;
  pauseConfirm?: boolean;
  browse?: boolean;
  inspect?: boolean;
  menuVisible?: boolean;
  hasChildren?: boolean;
}): KeyHintsView | undefined {
  // 模态卡在场：条退场（卡 hint 承载，样式同源由调用方统一）
  if (s.approval !== undefined && s.approval !== null) return undefined;
  if (s.question !== undefined && s.question !== null) return undefined;
  if (s.status === 'awaiting-approval' || s.status === 'awaiting-plan' || s.status === 'awaiting-question') return undefined;
  // 暂停确认（两次 Ctrl+C 第一段）：灰底强调，需要用户决断
  if (s.pauseConfirm) {
    return {
      items: [
        { key: t('ctrl+c again', '再按 Ctrl+C'), action: t('pause', '暂停') },
        { key: 'Esc', action: t('keep running', '继续运行') },
      ],
      emphasized: true,
    };
  }
  // 子代理浏览接管：灰底强调
  if (s.browse) {
    return {
      items: [
        { key: '↑↓', action: t('move', '移动') },
        { key: 'Enter', action: t('inspect', '查看') },
        { key: 'Esc', action: t('exit', '退出') },
      ],
      emphasized: true,
    };
  }
  // 子代理全屏视图：head 只留元数据，键提示由本条承载
  if (s.inspect) {
    return {
      items: [
        { key: 'Tab', action: t('timeline', '时间线') },
        { key: 'Ctrl+C', action: t('pause', '暂停') },
        { key: 'Esc', action: t('exit', '退出') },
      ],
      emphasized: false,
    };
  }
  // 运行中：暂停（两次 Ctrl+C）· 待办展开 · 最近轮详情（子代理在场追加浏览）
  if (s.status === 'running') {
    const items: KeyHintItem[] = [
      { key: 'Ctrl+C', action: t('pause', '暂停') },
      { key: 'Tab', action: t('todo', '待办') },
      { key: 'Ctrl+O', action: t('detail', '详情') },
    ];
    if (s.hasChildren) items.push({ key: 'Ctrl+B', action: t('subagents', '子代理') });
    return { items, emphasized: false };
  }
  // 空闲/出错 + 斜杠菜单在场：面板键
  if (s.menuVisible) {
    return {
      items: [
        { key: '↑↓', action: t('move', '移动') },
        { key: 'Tab', action: t('complete', '补全') },
        { key: 'Enter', action: t('run', '执行') },
      ],
      emphasized: false,
    };
  }
  // 空闲/出错缺省：补全 · 历史 · 子代理浏览 · /help（banner 快捷键行退役后的唯一承载）
  return {
    items: [
      { key: 'Tab', action: t('complete', '补全') },
      { key: '↑', action: t('history', '历史') },
      { key: 'Ctrl+B', action: t('subagents', '子代理') },
      { key: '/help', action: t('commands', '命令') },
    ],
    emphasized: false,
  };
}

/** 宽度适配（纯函数）：贪心保留能放进一行的条目（前缀 + 条目 + 分隔符），首位恒保留（最关键键不被截掉） */
export function fitHints(items: KeyHintItem[], columns: number): KeyHintItem[] {
  const budget = Math.max(12, columns - 4); // 前缀 ⌨ 与左右留白
  const sep = 3; // ' · '
  const width = (it: KeyHintItem): number => displayWidth(`${it.key} ${it.action}`);
  const out: KeyHintItem[] = [];
  let used = 0;
  for (const it of items) {
    const add = out.length === 0 ? width(it) : sep + width(it);
    if (out.length > 0 && used + add > budget) break; // 超预算即止（后续更低优先级不再考察）
    used += add;
    out.push(it);
  }
  return out.length > 0 ? out : [items[0]!];
}

export function KeyHints({ items, emphasized, columns }: { items: KeyHintItem[]; emphasized?: boolean; columns: number }): JSX.Element {
  const fitted = fitHints(items, columns);
  const sep = <Text dimColor={emphasized ? false : undefined}>{' · '}</Text>;
  return (
    <Text backgroundColor={emphasized ? 'gray' : undefined}>
      {' ⌨ '}
      {fitted.map((it, i) => (
        <Text key={i}>
          {i > 0 ? sep : null}
          <Text bold>{it.key}</Text>
          <Text dimColor={emphasized ? false : undefined}>{` ${it.action}`}</Text>
        </Text>
      ))}
    </Text>
  );
}
