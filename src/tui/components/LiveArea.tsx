import * as React from 'react';
import { Box, Text } from 'ink';
import { LiveBlock } from '../session';
import { wrapByWidth } from '../text-band';
import { MarkdownText } from './MarkdownText';

/** 思考流滚动固定行数：块高恒定，增量到达时不再上下跳动（对标 Claude Code 思考滚动区） */
const THINK_TAIL_LINES = 6;
/** 答复流式预览固定行数：动态区帧高必须有界；已入档前缀由 committedLen 排除，预览只呈现生成中的未入档尾段 */
const REPLY_PREVIEW_LINES = 8;

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
    const overflow = Math.max(0, lines.length - REPLY_PREVIEW_LINES);
    const tail = lines.slice(-REPLY_PREVIEW_LINES);
    // 预览统一走 Markdown 渲染管线（与入档后同构）：粗体/列表/表格等生成期间即成形，不再按内容类型双轨分叉
    return (
      <Box flexDirection="column">
        {overflow > 0 ? <Text dimColor>… 上文已入档（滚动缓冲可回看）</Text> : null}
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
