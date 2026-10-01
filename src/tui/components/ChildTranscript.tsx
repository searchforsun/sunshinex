import { Box, Text } from 'ink';
import { renderMd } from '../md-ansi';
import { elideByWidth } from '../text-band';
import { TOOL_VERBS } from '../tool-verbs';
import { theme } from '../theme';

/**
 * 子代理转录/detail 共享渲染器（2026-09-28 用户裁决「展开与全屏同构」）：
 * 历史区 SPAWN 行展开（ToolRow）与全屏查看视图（ChildInspector）同一分段器同一渲染形态——
 * 连续正文段合并走 renderMd（markdansi 出口，与主 agent 正文同一渲染器，框线表格/围栏统一形态），
 * 动词行还原 call 形态（● [VERB] target）、⎿ 行还原 result、⏺ 委派行与统计行 dim 呈现。
 */

export type TranscriptSeg =
  | { kind: 'md'; text: string }
  | { kind: 'call'; text: string }
  | { kind: 'result'; text: string; ok: boolean }
  | { kind: 'think'; text: string; detail?: string }
  | { kind: 'meta'; text: string };

/** 段行数估算（视口预算用）：md 段按源行数 + marginBottom 档 1、结构行恒 1（call 与紧随 result 贴排） */
export function estimateSegLines(s: TranscriptSeg): number {
  return s.kind === 'md' ? s.text.split('\n').length + 1 : s.kind === 'call' ? 1 : 2;
}

/** detail/转录字符串行 → 结构段：⎿ 前缀为 result、✻ 前缀为思考摘要（后随 4 空格缩进续行折为其 detail）、
 *  首词工具动作为 call、⏺ 委派行与统计尾行为 meta，其余正文合并 */
export function segmentizeLines(lines: string[]): TranscriptSeg[] {
  const segs: TranscriptSeg[] = [];
  for (const l of lines) {
    let seg: TranscriptSeg;
    if (l.startsWith('⎿ ')) {
      seg = { kind: 'result', text: l.slice(2).replace(/^[✓✗] /, ''), ok: !l.startsWith('⎿ ✗') };
    } else if (l.startsWith('✻ ')) {
      seg = { kind: 'think', text: l.slice(2) };
    } else if (/^ {4}/.test(l) && segs[segs.length - 1]?.kind === 'think') {
      // 思考段 detail 续行（序列化口径：4 空格缩进，与 MessageList ThinkingRow 呈现缩进互为镜像）
      const last = segs[segs.length - 1] as { kind: 'think'; text: string; detail?: string };
      last.detail = last.detail !== undefined ? `${last.detail}\n${l.slice(4)}` : l.slice(4);
      continue;
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

/** 单段渲染：md → renderMd（markdansi 出口，产物无尾随空行——段间单空行由本层 margin 承载，
 *  与主 agent 区域边界同档）、call → ● [VERB] target（与主 agent ToolRow 调用行同构，与紧随其后的
 *  result 行贴排零 margin）、result/meta → dim 行（margin 1，与下一段保持区域间隔） */
export function TranscriptSegView({ seg, columns }: { seg: TranscriptSeg; columns: number }): JSX.Element {
  if (seg.kind === 'md') {
    return (
      <Box marginBottom={1}>
        <Text>{renderMd(seg.text, Math.max(16, columns))}</Text>
      </Box>
    );
  }
  if (seg.kind === 'call') {
    const sp = seg.text.indexOf(' ');
    const verb = sp > 0 ? seg.text.slice(0, sp) : seg.text;
    const target = sp > 0 ? seg.text.slice(sp + 1) : '';
    return (
      <Text>
        <Text dimColor>● </Text>
        <Text color={theme.accent}>[{verb}]</Text>
        {target ? <Text color="gray"> {elideByWidth(target, Math.max(8, columns - 10))}</Text> : null}
      </Text>
    );
  }
  if (seg.kind === 'result') {
    return (
      <Box marginBottom={1}>
        <Text dimColor>
          {'  ⎿ '}
          {seg.ok ? '✓' : '✗'}
          {` ${seg.text}`}
        </Text>
      </Box>
    );
  }
  if (seg.kind === 'think') {
    // 思考摘要行（对标 MessageList ThinkingRow 折叠形态）：✻ 前缀斜体暗色
    return (
      <Box marginBottom={1}>
        <Text dimColor italic>
          {`✻ ${seg.text}`}
        </Text>
      </Box>
    );
  }
  return (
    <Box marginBottom={1}>
      <Text dimColor>{seg.text}</Text>
    </Box>
  );
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
        if (ls.length + 1 > remain) {
          visible.unshift({ kind: 'md', text: ls.slice(-Math.max(1, remain - 1)).join('\n') });
          break;
        }
        visible.unshift(s);
        used += ls.length + 1; // 源行 + marginBottom 档
        if (used >= bodyRows) break;
      } else {
        visible.unshift(s);
        used += s.kind === 'call' ? 1 : 2; // call 与紧随 result 贴排；其余含 marginBottom 档
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
