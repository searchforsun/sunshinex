import { Box, Text } from 'ink';
import { t } from '../../i18n';
import { theme } from '../theme';

/** 任务板行（Ctrl+T 任务视图，spec §10.3）：由 TuiState.board 经 boardRows（use-board-keys.ts 单点）派生——
 *  label = title + 依赖箭头 ` ← t2,t3`（英文 needs 语义用箭头省宽度）+ assignee 后缀 `@w1` */
export interface BoardRow {
  id: string;
  label: string;
  status: string;
  /** gate 挂起行：Enter 行内审批（approve/deny 问题卡映射 review）；渲染为 ⚠ 高亮 */
  gated?: boolean;
}

/** 每页窗口行数（BrowseList 同款滑窗口径）：每页 8 行，超出即翻页 */
export const BOARD_PAGE_ROWS = 8;

/** 任务板列表（Ctrl+T 任务视图，动态区承载）：行形态 `${id} <符号>${gated?' ⚠':''} ${label}`（符号由 boardRows 单点映射）、
 *  每页 8 行窗口、光标行反色（❯ + 灰底，BrowseList 先例）——动态区每帧自绘，↑↓ 可见移动零重挂；
 *  空板渲染提示行（board 模态空板自退，此形态为组件层契约/防御） */
export function BoardList({ rows, cursor }: { rows: BoardRow[]; cursor: number }): JSX.Element {
  if (rows.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text dimColor>{t('(task board empty — Ctrl+T to toggle)', '（任务板为空——Ctrl+T 切换）')}</Text>
      </Box>
    );
  }
  const page = Math.floor(cursor / BOARD_PAGE_ROWS);
  const start = page * BOARD_PAGE_ROWS;
  const pages = Math.ceil(rows.length / BOARD_PAGE_ROWS);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      {rows.slice(start, start + BOARD_PAGE_ROWS).map((r, i) => {
        const selected = start + i === cursor;
        return (
          <Text key={r.id} backgroundColor={selected ? 'gray' : undefined}>
            <Text dimColor={selected}>{selected ? '❯ ' : '  '}</Text>
            {`${r.id} ${r.status}`}
            {r.gated === true ? <Text color={selected ? undefined : theme.warn}>{' ⚠'}</Text> : null}
            {` ${r.label}`}
          </Text>
        );
      })}
      {pages > 1 ? (
        <Text dimColor>{t(`page ${page + 1}/${pages} · ${cursor + 1}/${rows.length}`, `第 ${page + 1}/${pages} 页 · ${cursor + 1}/${rows.length}`)}</Text>
      ) : null}
    </Box>
  );
}
