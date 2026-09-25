import { t } from '../../i18n';
import * as React from 'react';
import { Box, Text } from 'ink';
import { LiveBlock } from '../session';
import { wrapByWidth } from '../text-band';
import { MarkdownText } from './MarkdownText';

/** 思考流滚动固定行数：块高恒定，增量到达时不再上下跳动（对标 Claude Code 思考滚动区） */
const THINK_TAIL_LINES = 6;

/**
 * 动态实时区：流式正文按安全点切块增量入档（session.flushReply，段落边界优先、围栏不切、超长段兜底），
 * 此处全量预览未入档尾段（用户裁决：生成期间内容完整可见，不设行数封顶），统一按 Markdown 实时渲染
 * ——与入档后呈现同构，生成期间即所见即所得；思考流滚动显示末 6 行（按显示宽度折行取尾、不足补空行）
 * ——过程活性反馈，收束后折叠为摘要行，全文经 Tab 切换历史展开查看。
 */
export function LiveArea({ live, columns }: { live: LiveBlock; columns: number }): JSX.Element {
  if (live.kind === 'reply') {
    // 长围栏兜底切块后预览续块以开栏行承接：未闭合围栏按围栏开始渲染，代码块高亮呈现跨切块延续
    const pending = (live.fenceOpener ?? '') + live.text.slice(live.committedLen ?? 0);
    if (pending.trim() === '') return <Box />;
    const lines = pending.split('\n');
    // 全量渲染未入档尾段（无裁切窗口）：表格行实时成形、正文逐行长高，所见即生成所得
    return (
      <Box flexDirection="column">
        <MarkdownText text={lines.join('\n')} columns={columns} />
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
