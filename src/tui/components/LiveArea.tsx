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
 * 此处按尾部滚动窗口预览未入档尾段（2026-09-28 一致性流式裁决：全量预览帧高无界增长、切块瞬间塌缩
 * 再增长即真机闪屏病根，修订 09-25 全量可见口径）——帧高有界恒定，动态区不整屏重排，输入框钉底，
 * 观感为持续向下流式；统一按 Markdown 实时渲染与入档后呈现同构，窗口上方内容入档后经历史区查看；
 * 思考流滚动显示末 6 行（按显示宽度折行取尾、不足补空行）——过程活性反馈，收束后折叠为摘要行。
 */
const REPLY_PREVIEW_MAX_ROWS = 28;

/** 尾部窗口估算：按折行行数自尾累计，超限即从该行截断。折行预算收 2 列安全余量（ink 断行边界差
 *  方向性偏保守）；截断若落在表格内部，缺表头的行经 MarkdownText 按普通段落 1:1 呈现，帧高仍有界。
 *  rows 绑定（2026-09-28 跳到中间修复）：窗口上限随终端行数收缩——固定 28 行窗口 + 输入框/状态栏/
 *  活动行在矮终端超视口，ink 光标上移越顶即「从中段起渲染」；预留 6 行 chrome，rows 缺省（测试/管道）
 *  回落固定上限零行为变化 */
export function tailReplyPreview(pending: string, columns: number, maxRows: number): string {
  const lines = pending.split('\n');
  const safe = Math.max(8, columns - 2);
  const budget = Math.max(4, maxRows - 2);
  let total = 0;
  let cut = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += Math.max(1, wrapByWidth(lines[i]!, safe).length);
    if (total > budget) return lines.slice(i + 1).join('\n');
    cut = i;
  }
  return lines.slice(cut).join('\n');
}

export function LiveArea({ live, columns, rows }: { live: LiveBlock; columns: number; rows?: number }): JSX.Element {
  const maxRows = rows === undefined ? REPLY_PREVIEW_MAX_ROWS : Math.min(REPLY_PREVIEW_MAX_ROWS, Math.max(8, rows - 6));
  if (live.kind === 'reply') {
    // 长围栏兜底切块后预览续块以开栏行承接：未闭合围栏按围栏开始渲染，代码块高亮呈现跨切块延续
    const pending = (live.fenceOpener ?? '') + live.text.slice(live.committedLen ?? 0);
    if (pending.trim() === '') return <Box />;
    return (
      <Box flexDirection="column">
        <MarkdownText text={tailReplyPreview(pending, columns, maxRows)} columns={columns} />
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
