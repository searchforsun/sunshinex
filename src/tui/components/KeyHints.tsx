import { t } from '../../i18n';
import { Text } from 'ink';
import { displayWidth } from '../text-band';
import type { TuiState } from '../session';

/**
 * 恒驻键提示条（2026-10-02 用户裁决「所有交互处显示快捷键、按状态切换、一眼可见」；样式终版裁决
 * 「不要 icon、不要冗余、不要高亮、统一系统提示色」）：单行纯暗灰文本（键名与动作词同色，无前缀
 * 图标、无粗体、无反色底）。条目按状态由 keyHintsFor 矩阵给出（纯函数可单测），超宽按优先序截断
 * （排序即优先级，首位恒保留）。
 * 帧高纪律：本条恒 1 行，调用方（App previewCap / ChildInspector textCap）必须计入 chrome 实账。
 */

export interface KeyHintItem {
  key: string;
  action: string;
}

export interface KeyHintsView {
  items: KeyHintItem[];
}

/** 键提示矩阵单点：状态 → 条目（排序即截断优先序，首位最关键恒保留）。
 *  模态卡（审批/计划/问询）在场返回 undefined=条退场——卡内自带 hint，避免双显。
 *  冗余纪律（2026-10-02 用户裁决）：与输入框占位符重复的引导（/help、Enter 发送）不进本条。 */
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
  // 模态卡在场：条退场（卡 hint 承载）
  if (s.approval !== undefined && s.approval !== null) return undefined;
  if (s.question !== undefined && s.question !== null) return undefined;
  if (s.status === 'awaiting-approval' || s.status === 'awaiting-plan' || s.status === 'awaiting-question') return undefined;
  // 暂停确认（两次 Ctrl+C 第一段）
  if (s.pauseConfirm) {
    return {
      items: [
        { key: t('ctrl+c again', '再按 Ctrl+C'), action: t('pause', '暂停') },
        { key: 'Esc', action: t('keep running', '继续运行') },
      ],
    };
  }
  // 子代理浏览接管
  if (s.browse) {
    return {
      items: [
        { key: '↑↓', action: t('move', '移动') },
        { key: 'Enter', action: t('inspect', '查看') },
        { key: 'Esc', action: t('exit', '退出') },
      ],
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
    return { items };
  }
  // 空闲/出错 + 斜杠菜单在场：面板键（Enter 执行不进条——占位符已引导）
  if (s.menuVisible) {
    return {
      items: [
        { key: '↑↓', action: t('move', '移动') },
        { key: 'Tab', action: t('complete', '补全') },
      ],
    };
  }
  // 空闲/出错缺省（/help 由输入框占位符承载，不重复进条）
  return {
    items: [
      { key: 'Tab', action: t('complete', '补全') },
      { key: '↑', action: t('history', '历史') },
      { key: 'Ctrl+B', action: t('subagents', '子代理') },
    ],
  };
}

/** 宽度适配（纯函数）：贪心保留能放进一行的条目（条目 + 分隔符），首位恒保留（最关键键不被截掉） */
export function fitHints(items: KeyHintItem[], columns: number): KeyHintItem[] {
  const budget = Math.max(12, columns - 2); // 左右留白
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

export function KeyHints({ items, columns }: { items: KeyHintItem[]; columns: number }): JSX.Element {
  const fitted = fitHints(items, columns);
  return (
    // 统一系统提示色（2026-10-02 用户裁决）：整行暗灰，键名与动作词同色同权重——无 icon、无粗体、无反色底
    <Text dimColor>
      {fitted.map((it, i) => `${i > 0 ? ' · ' : ''}${it.key} ${it.action}`)}
    </Text>
  );
}
