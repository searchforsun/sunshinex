import * as React from 'react';
import { Box, Text } from 'ink';
import { MarkdownText } from './MarkdownText';
import { TOOL_VERBS } from '../tool-verbs';
import { theme } from '../theme';

/**
 * 子代理转录/detail 共享渲染器（2026-09-28 用户裁决「展开与全屏同构」）：
 * 历史区 SPAWN 行展开（ToolRow）与全屏查看视图（ChildInspector）同一分段器同一渲染形态——
 * 连续正文段合并走 MarkdownText（加粗/围栏/表格与主 agent 正文同渲染器，星号不再裸露），
 * 动词行还原 call 形态（● [VERB] target）、⎿ 行还原 result、⏺ 委派行与统计行 dim 呈现。
 */

export type TranscriptSeg =
  | { kind: 'md'; text: string }
  | { kind: 'call'; text: string }
  | { kind: 'result'; text: string; ok: boolean }
  | { kind: 'meta'; text: string };

/** 段行数估算（视口预算用）：md 段按源行数、结构行恒 1 */
export function estimateSegLines(s: TranscriptSeg): number {
  return s.kind === 'md' ? s.text.split('\n').length : 1;
}

/** detail/转录字符串行 → 结构段：⎿ 前缀为 result、首词工具动作为 call、⏺ 委派行与统计尾行为 meta，其余正文合并 */
export function segmentizeLines(lines: string[]): TranscriptSeg[] {
  const segs: TranscriptSeg[] = [];
  for (const l of lines) {
    let seg: TranscriptSeg;
    if (l.startsWith('⎿ ')) {
      seg = { kind: 'result', text: l.slice(2).replace(/^[✓✗] /, ''), ok: !l.startsWith('⎿ ✗') };
    } else if (l.startsWith('⏺ ') || /· \d+ steps · ↑/.test(l)) {
      seg = { kind: 'meta', text: l };
    } else {
      const first = l.split(/\s+/)[0] ?? '';
      seg = TOOL_VERBS.has(first) ? { kind: 'call', text: l } : { kind: 'md', text: l };
    }
    const last = segs[segs.length - 1];
    if (seg.kind === 'md' && last?.kind === 'md') last.text += '\n' + seg.text;
    else segs.push(seg);
  }
  return segs;
}

/** 单段渲染：md → MarkdownText、call → ● [VERB] target（与主 agent ToolRow 调用行同构）、result/meta → dim 行 */
export function TranscriptSegView({ seg, columns }: { seg: TranscriptSeg; columns: number }): JSX.Element {
  if (seg.kind === 'md') return <MarkdownText text={seg.text} columns={Math.max(16, columns)} />;
  if (seg.kind === 'call') {
    const sp = seg.text.indexOf(' ');
    const verb = sp > 0 ? seg.text.slice(0, sp) : seg.text;
    const target = sp > 0 ? seg.text.slice(sp + 1) : '';
    return (
      <Text>
        <Text dimColor>● </Text>
        <Text color={theme.accent}>[{verb}]</Text>
        {target ? <Text color="gray"> {target}</Text> : null}
      </Text>
    );
  }
  if (seg.kind === 'result') {
    return (
      <Text dimColor>
        {'  ⎿ '}
        {seg.ok ? '✓' : '✗'}
        {` ${seg.text}`}
      </Text>
    );
  }
  return <Text dimColor>{seg.text}</Text>;
}

/** 转录行列表渲染：bodyRows 缺省全量（历史区展开），给定时从尾适配（全屏视口有界约束，超预算 md 段按行截尾） */
export function TranscriptLines({ lines, columns, bodyRows }: { lines: string[]; columns: number; bodyRows?: number }): JSX.Element {
  let segs = segmentizeLines(lines);
  if (bodyRows !== undefined && bodyRows > 0) {
    const visible: TranscriptSeg[] = [];
    let used = 0;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      const remain = bodyRows - used;
      if (s.kind === 'md') {
        const ls = s.text.split('\n');
        if (ls.length > remain) {
          visible.unshift({ kind: 'md', text: ls.slice(-remain).join('\n') });
          break;
        }
        visible.unshift(s);
        used += ls.length;
        if (used >= bodyRows) break;
      } else {
        visible.unshift(s);
        used += 1;
        if (used >= bodyRows) break;
      }
    }
    segs = visible;
  }
  return (
    <Box flexDirection="column">
      {segs.map((s, i) => (
        <TranscriptSegView key={i} seg={s} columns={columns} />
      ))}
    </Box>
  );
}
