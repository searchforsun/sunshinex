import * as React from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n';
import { theme } from '../theme';
import { displayWidth, elideByWidth } from '../text-band';

/** 纵向命令面板单行（2026-09-30 对标 Claude Code）：cmd 含 / 前缀；kind 区分内置与技能（技能排序由调用方给定） */
export interface SlashMenuEntry {
  cmd: string;
  description: string;
  kind: 'builtin' | 'skill';
}

/** 菜单可见行数上限（用户裁决 2026-09-30：最多 20 条）：矮终端经调用方随视口收缩传入更小值 */
export const SLASH_MENU_MAX_ROWS = 20;

/** 选区驱动可视窗口（对标 BrowseList 每页翻页口径）：光标行恒可见，跨页随光标平移 */
export function slashMenuWindow(total: number, cursor: number, maxRows: number): { start: number; count: number } {
  if (total <= maxRows) return { start: 0, count: total };
  const page = Math.floor(cursor / maxRows);
  const start = page * maxRows;
  return { start, count: Math.min(maxRows, total - start) };
}

/** 纵向命令面板（对标 Claude Code）：一行一命令、命令名列左 + 描述列右（窗口内左对齐）、选中行反色
 *  （❯ 指示 + 灰底，BrowseList 同款视觉语言）、≤maxRows 行窗口随光标翻页；空态零占位。
 *  键盘语义（App 分发）：↑↓ 移动选区、Tab 补全选中、Enter 提交选中；过滤由调用方按 buffer 前缀预筛 */
export function SlashMenu({
  entries,
  cursor,
  columns,
  maxRows = SLASH_MENU_MAX_ROWS,
}: {
  entries: SlashMenuEntry[];
  cursor: number;
  columns: number;
  maxRows?: number;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  const { start, count } = slashMenuWindow(entries.length, cursor, maxRows);
  const visible = entries.slice(start, start + count);
  // 命令列宽：可见行最宽命令 + 2 空格档位（窗口内对齐；技能 /<id> 偏长时随窗口浮动，不按全量钉死）
  const cmdWidth = Math.min(24, Math.max(...visible.map((e) => displayWidth(e.cmd))));
  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((e, i) => {
        const idx = start + i;
        const selected = idx === cursor;
        const descBudget = Math.max(8, columns - cmdWidth - 6);
        return (
          <Text key={e.cmd} backgroundColor={selected ? 'gray' : undefined}>
            <Text dimColor={selected ? false : true}>{selected ? '❯ ' : '  '}</Text>
            <Text color={selected ? undefined : theme.accent}>{e.cmd}</Text>
            {' '.repeat(Math.max(2, cmdWidth - displayWidth(e.cmd) + 2))}
            <Text dimColor={selected ? false : true}>{elideByWidth(e.description, descBudget)}</Text>
          </Text>
        );
      })}
      {entries.length > count ? (
        <Text dimColor>{t(`… ${entries.length - count} more · ↑↓ move`, `… 还有 ${entries.length - count} 条 · ↑↓ 移动`)}</Text>
      ) : null}
    </Box>
  );
}
