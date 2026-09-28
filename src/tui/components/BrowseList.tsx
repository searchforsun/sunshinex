import * as React from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n';
import { theme } from '../theme';
import { formatDuration } from '../format';

/** 浏览列表行：live（运行中子代理，label 锚定全屏实时视图）与 archived（已完成 spawn 归档行，seq 锚定 detail 回看）两类统一投影 */
export interface BrowseRow {
  id: string;
  label: string;
  /** 运行中子代理行（Enter → 全屏实时视图）；缺省为已完成 spawn 归档行（Enter → detail 回看） */
  running?: boolean;
  /** 归档 spawn 调用行 seq（archived 行回看锚点；live 行缺省） */
  seq?: number;
  meta?: { steps: number; durationMs: number; tokens: number; delegatedAt?: number };
}

/** 每页窗口行数（2026-09-28 用户裁决：每页 8 个窗口，不是上限 8——超出即翻页） */
export const BROWSE_PAGE_ROWS = 8;

/** 子代理统一列表（Ctrl+B 浏览态，动态区承载）：行序由调用方单点口径给定（运行中在前 + 已完成委派时间升序），
 *  每页 8 行窗口、光标行反色——动态区每帧自绘，↑↓ 可见移动零重挂（历史区 Static 打印一次不重绘）；空态零占位 */
export function BrowseList({ rows, cursor }: { rows: BrowseRow[]; cursor: number }): JSX.Element {
  if (rows.length === 0) return <Box />;
  const page = Math.floor(cursor / BROWSE_PAGE_ROWS);
  const start = page * BROWSE_PAGE_ROWS;
  const pages = Math.ceil(rows.length / BROWSE_PAGE_ROWS);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      {rows.slice(start, start + BROWSE_PAGE_ROWS).map((r, i) => {
        const selected = start + i === cursor;
        return (
          <Text key={r.id} backgroundColor={selected ? 'gray' : undefined}>
            <Text dimColor={selected}>{selected ? '❯ ' : '  '}</Text>
            {r.running ? (
              <Text color={selected ? undefined : theme.accent}>
                {`[${r.label}]`} {t('running', '运行中')}
              </Text>
            ) : (
              <Text color={selected ? undefined : 'gray'}>
                {`[${r.label}]`}
                {r.meta
                  ? ` · ${r.meta.steps} steps · ${formatDuration(Math.round(r.meta.durationMs / 1000))}`
                  : ''}
              </Text>
            )}
          </Text>
        );
      })}
      {pages > 1 ? (
        <Text dimColor>{t(`page ${page + 1}/${pages} · ${cursor + 1}/${rows.length}`, `第 ${page + 1}/${pages} 页 · ${cursor + 1}/${rows.length}`)}</Text>
      ) : null}
    </Box>
  );
}
