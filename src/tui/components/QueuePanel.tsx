import { Box, Text } from 'ink';
import { t } from '../../i18n';
import { theme } from '../theme';
import type { SteerItem } from '../../session/kernel';

/** 每页窗口行数（BrowseList 同口径：每页 8 个窗口，超出即翻页） */
export const QUEUE_PAGE_ROWS = 8;

/** 等待队列管理面板（P5 spec §12.3，Ctrl+Q 开合；键分发收编 use-queue-keys，本组件纯渲染）：
 *  查看（序号 + 插入发送标记 + 文本）/ 编辑 E（draft 行内联，Enter 提交）/ 删除 D / 插入 I /
 *  直接发送 N / 置首 F / 重排 Ctrl+↑↓。动态区每帧自绘（选中行反色对标 BrowseList），空态零占位。 */
export function QueuePanel({
  items,
  cursor,
  draft,
  draftSeq,
  paused = false,
}: {
  items: SteerItem[];
  cursor: number;
  /** 编辑/插入在途输入行（undefined=列表态）；draftSeq=编辑目标条 seq，undefined=插入新条 */
  draft?: string;
  draftSeq?: number;
  /** 队列暂停态（2026-10-19「中断不丢弃队列」配套）：暂停中不自动发送,面板标示 + R 恢复 */
  paused?: boolean;
}): JSX.Element {
  const page = Math.floor(cursor / QUEUE_PAGE_ROWS);
  const start = page * QUEUE_PAGE_ROWS;
  const pages = Math.ceil(Math.max(items.length, 1) / QUEUE_PAGE_ROWS);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text dimColor>
        {t('Queued messages', '等待队列')} · {items.length}
        {paused ? <Text color={theme.warn}>{t(' · PAUSED (R to resume)', ' · 已暂停（R 恢复自动发送）')}</Text> : null}
      </Text>
      {items.length === 0 ? (
        <Text dimColor>{t('empty — press I to insert', '空 — 按 I 插入新条')}</Text>
      ) : (
        items.slice(start, start + QUEUE_PAGE_ROWS).map((it, i) => {
          const selected = start + i === cursor;
          return (
            <Text key={it.seq} backgroundColor={selected ? 'gray' : undefined}>
              <Text dimColor={selected}>{selected ? '❯ ' : '  '}</Text>
              <Text color={selected ? undefined : it.front ? theme.accent : 'gray'}>
                {it.seq + 1}. {it.front ? t('[inject] ', '[插入发送] ') : ''}
                {it.text}
              </Text>
            </Text>
          );
        })
      )}
      {draft !== undefined ? (
        <Text>
          {draftSeq !== undefined ? t('edit', '编辑') : t('insert', '插入')} ❯ {draft}▊
        </Text>
      ) : null}
      {pages > 1 ? (
        <Text dimColor>{t(`page ${page + 1}/${pages} · ${cursor + 1}/${items.length}`, `第 ${page + 1}/${pages} 页 · ${cursor + 1}/${items.length}`)}</Text>
      ) : null}
    </Box>
  );
}
