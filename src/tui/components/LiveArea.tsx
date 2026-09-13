import * as React from 'react';
import { Box, Text } from 'ink';
import { LiveBlock } from '../session';
import { wrapByWidth } from '../text-band';
import { MarkdownText } from './MarkdownText';

/** 尾部表格块收集：从末行向前收集连续 | 行（空行/非表格行截断）；末行非 | 行即无表格在生成 */
function tailTableBlock(lines: string[]): { start: number; rows: string[] } | null {
  const last = lines.length - 1;
  if (last < 0 || !lines[last].trimStart().startsWith('|')) return null;
  let start = last;
  while (start > 0 && lines[start - 1].trimStart().startsWith('|')) start--;
  return { start, rows: lines.slice(start) };
}

/** 思考流滚动固定行数：块高恒定，增量到达时不再上下跳动（对标 Claude Code 思考滚动区） */
const THINK_TAIL_LINES = 6;
/** 答复流式预览固定行数：动态区帧高必须有界；已入档前缀由 committedLen 排除，预览只呈现生成中的未入档尾段 */
const REPLY_PREVIEW_LINES = 8;
/** 生成中表格封顶阈值：表格行数超此值即转「表头 + 尾部窗口」实时预览，帧高封顶不随生成逐帧长高 */
const MAX_BLOCK_PREVIEW_LINES = 6;

/**
 * 动态实时区：流式正文按安全点切块增量入档（session.flushReply，段落边界优先、围栏不切、超长段兜底），
 * 此处预览未入档尾段（末 N 行），统一按 Markdown 实时渲染——与入档后呈现同构，生成期间即所见即所得；
 * 思考流滚动显示末 6 行（按显示宽度折行取尾、不足补空行）——过程活性反馈，收束后折叠为摘要行，全文经 Tab 切换历史展开查看。
 */
export function LiveArea({ live, columns }: { live: LiveBlock; columns: number }): JSX.Element {
  if (live.kind === 'reply') {
    const pending = live.text.slice(live.committedLen ?? 0);
    if (pending.trim() === '') return <Box />;
    const lines = pending.split('\n');
    const table = tailTableBlock(lines);
    // 长表格生成中：表头 + 尾部窗口实时渲染（框线逐行成形、帧高封顶恒定）。
    // 不整表渲染的原因：行数逐帧长高会带动动态区整体推移（整窗闪动），且中间行本就超出窗口不可见；
    // 溢出提示如实报「生成中」——pending 是未入档尾段，谎称「已入档」会误导用户以为内容丢失
    if (table !== null && table.rows.length > MAX_BLOCK_PREVIEW_LINES) {
      const before = lines.slice(0, table.start);
      const head = table.rows.slice(0, 2); // 表头 + 分隔行：列结构始终可见
      const tailRows = table.rows.slice(-3); // 尾部最新行：逐行成形
      const omitted = Math.max(0, before.length - 2) + (table.rows.length - head.length - tailRows.length);
      return (
        <Box flexDirection="column">
          {omitted > 0 ? <Text dimColor>{`… 上方 ${omitted} 行生成中`}</Text> : null}
          {before.slice(-2).map((l, i) => (
            <Text key={'b' + i}>{l}</Text>
          ))}
          <MarkdownText text={[...head, ...tailRows].join('\n')} columns={columns} />
          <Text dimColor>{`⎇ 表格生成中 · 已 ${table.rows.length} 行`}</Text>
        </Box>
      );
    }
    // 预览统一走 Markdown 渲染管线（与入档后同构）：粗体/列表/表格等生成期间即成形，不再按内容类型双轨分叉
    const overflow = Math.max(0, lines.length - REPLY_PREVIEW_LINES);
    const tail = lines.slice(-REPLY_PREVIEW_LINES);
    return (
      <Box flexDirection="column">
        {overflow > 0 ? <Text dimColor>{`… 上方 ${overflow} 行生成中`}</Text> : null}
        <MarkdownText text={tail.join('\n')} columns={columns} />
      </Box>
    );
  }
  const wrapped = live.text.split('\n').flatMap((seg) => wrapByWidth(seg, Math.max(16, columns - 8)));
  const tail = wrapped.slice(-THINK_TAIL_LINES);
  while (tail.length < THINK_TAIL_LINES) tail.unshift('');
  return (
    <Box flexDirection="column">
      {tail.map((l, i) => (
        <Text key={i} dimColor italic>
          {l.length > 0 ? `✻ ${l}` : ' '}
        </Text>
      ))}
    </Box>
  );
}
