import { t } from '../../i18n';
import * as React from 'react';
import { Box, Text } from 'ink';
import { LiveBlock } from '../session';
import { wrapByWidth } from '../text-band';
import { markdownRowCount } from '../markdown';
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
 *  回落固定上限零行为变化
 *  2026-09-30 渲染行数口径接线（markdownRowCount，正文输出跳到中间总根修复）：旧估算按原始行计数，
 *  而 MarkdownText 渲染时块间插 marginTop 空行、表格按 alignTable 实际框线行数——多块正文（段落/列表/
 *  表格交替，恰是模型正文常形态）渲染行数系统性高于估算，动态帧被撑过 stdout.rows 即触发 ink3
 *  outputHeight>=rows 的 clearTerminal 整屏重写路径（视口跳中段 + 滚动缓冲被清）。窗口行数一律以
 *  渲染同源口径收敛：先按原始行粗收敛出候选窗口（快路径），再按 markdownRowCount 逐行推进 cut 至
 *  渲染行数落进预算；末行恒保留兜底（单块超预算时宁超不空） */
export function tailReplyPreview(pending: string, columns: number, maxRows: number): string {
  const lines = pending.split('\n');
  const safe = Math.max(8, columns - 2);
  const budget = Math.max(4, maxRows - 2);
  let total = 0;
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += Math.max(1, wrapByWidth(lines[i]!, safe).length);
    if (total > budget) break;
    cut = i;
  }
  // 渲染行数收敛：块间空行/表格框线等膨胀逐行吐出，直至 markdownRowCount（渲染同源）落进预算
  while (cut < lines.length - 1 && markdownRowCount(lines.slice(cut).join('\n'), columns) > budget) {
    cut += 1;
  }
  return lines.slice(cut).join('\n');
}

export function LiveArea({ live, columns, rows, maxRows: maxRowsOverride }: { live: LiveBlock; columns: number; rows?: number; maxRows?: number }): JSX.Element {
  // maxRows 显式覆盖优先（2026-09-30 App 动态区 chrome 实账直传：子代理面板/多行输入/展开待办等
  // 全部计入后再定预览上限，防帧高触顶）；缺省回落 rows 联动公式（rows 缺省再回落固定上限）
  const maxRows = maxRowsOverride ?? (rows === undefined ? REPLY_PREVIEW_MAX_ROWS : Math.min(REPLY_PREVIEW_MAX_ROWS, Math.max(8, rows - 6)));
  if (live.kind === 'reply') {
    // 长围栏兜底切块后预览续块以开栏行承接：未闭合围栏按围栏开始渲染，代码块高亮呈现跨切块延续
    const pending = (live.fenceOpener ?? '') + live.text.slice(live.committedLen ?? 0);
    // 预览窗高度恒定（2026-09-30 真机「正文输出跳到中间 + 闪」终版根因）：tailReplyPreview 的窗口随
    // 未入档尾段涨落——流式满窗 ~26 行、flushReply 每次切块瞬间塌缩成 ~2 行，动态帧高骤缩 24 行即
    // ink 擦除基线失配（内容跳位/残影/闪一下）。与思考流 6 行补空同构：不足 maxRows 顶部补空行、
    // 内容钉在窗底（末行恒贴输入框上缘），帧高全流恒定，切块只换血不变形；空尾段（切块边界瞬时）
    // 同样恒高，不再 0 行塌陷。±1 行余量吸收 rowCount 估算边界差（小差 ink 帧差分可消化，骤缩不可）
    const preview = pending.trim() === '' ? '' : tailReplyPreview(pending, columns, maxRows);
    const used = preview.length === 0 ? 0 : markdownRowCount(preview, columns);
    const pad = Math.max(0, maxRows - 1 - used);
    return (
      <Box flexDirection="column">
        {Array.from({ length: pad }, (_, i) => (
          <Text key={i}> </Text>
        ))}
        {preview.length > 0 ? <MarkdownText text={preview} columns={columns} /> : <Text> </Text>}
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
