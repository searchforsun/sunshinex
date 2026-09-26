import * as React from 'react';
import { Box, Text } from 'ink';
import { ChildLine, ChildLiveState } from '../session';
import { formatTokens, formatDuration } from '../format';
import { MarkdownText } from './MarkdownText';
import { TOOL_VERBS } from '../tool-verbs';
import { t } from '../../i18n';

/** 全屏查看视图（规格 §3.3）：运行中实时流式 / 完成态 detail 回看双模式；
 *  整体渲染在动态区（有界=视口高度，取尾适配）+ 特殊边框整屏框定（2026-09-27 用户裁决对标 CC）；
 *  内部渲染与主 agent 同构——连续 text 段合并走 MarkdownText（高亮/表格/围栏同渲染器），
 *  call 行对齐 ToolRow 调用行形态（● [VERB] target）、result 行 ⎿ ✓/✗；
 *  头部状态行携带委派 prompt（规格 §4.2），Esc 退出提示常驻 */
export function ChildInspector(props: {
  child?: ChildLiveState;
  archived?: { label: string; lines: string[]; steps?: number; durationMs?: number };
  columns: number;
  rows: number;
}): JSX.Element {
  const { child, archived, columns, rows } = props;
  const label = child?.label ?? archived?.label ?? '';
  const steps = child?.steps ?? archived?.steps;
  const tokens = child?.tokens;
  const secs = child
    ? Math.max(0, Math.round((Date.now() - child.startedAt) / 1000))
    : archived?.durationMs !== undefined
      ? Math.round(archived.durationMs / 1000)
      : undefined;
  const body: ChildLine[] = child
    ? child.transcript
    : (archived?.lines ?? []).map((l) => {
        if (l.startsWith('⎿ ')) {
          return { kind: 'result' as const, text: l.slice(2).replace(/^[✓✗] /, ''), ok: !l.startsWith('⎿ ✗') };
        }
        // archived detail 的非 ⎿ 行按「首词是否工具动词」分流：动词行还原 call 形态，正文行走 Markdown
        const first = l.split(/\s+/)[0] ?? '';
        return TOOL_VERBS.has(first)
          ? { kind: 'call' as const, text: l }
          : { kind: 'text' as const, text: l };
      });
  const head =
    `✻ [${label}] ${t('subagent view', '子代理视图')}` +
    `${typeof steps === 'number' ? ` · step ${steps}` : ''}` +
    `${tokens !== undefined ? ` · ↑${formatTokens(tokens)} tokens` : ''}` +
    `${secs !== undefined ? ` · ${formatDuration(secs)}` : ''}` +
    ` · ${t('Esc exit', 'Esc 退出')}`;
  // 视口预算：边框 2 行 + 头部 1 行 + 委派 prompt 段（按换行行数计）从内容行数中扣除，取尾适配
  const promptLines = (child?.prompt ? child.prompt.split('\n').length : 0) + (child?.prompt ? 1 : 0);
  const bodyRows = Math.max(1, rows - 3 - promptLines);
  const textBudget = Math.max(8, columns - 4);

  // text 段合并（同构渲染的关键）：连续 text 行视作一段 Markdown 交 MarkdownText，调用/结果行打断分段；
  // 合并段整体参与取尾（按段粒度），单段超出剩余预算时按行截取段尾（视口有界约束，长转录只保留最新部分）
  type Seg = { kind: 'md'; text: string } | { kind: 'line'; line: ChildLine };
  const segs: Seg[] = [];
  for (const l of body) {
    if (l.kind === 'text') {
      const last = segs[segs.length - 1];
      if (last?.kind === 'md') last.text += '\n' + l.text;
      else segs.push({ kind: 'md', text: l.text });
    } else {
      segs.push({ kind: 'line', line: l });
    }
  }
  const visible: Seg[] = [];
  let used = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const remain = bodyRows - used;
    if (s.kind === 'md') {
      const lines = s.text.split('\n');
      if (lines.length > remain) {
        // 段尾截取：Markdown 段超预算时只保留最新 remain 行（长转录取尾适配，视口永不溢出）
        visible.unshift({ kind: 'md', text: lines.slice(-remain).join('\n') });
        break;
      }
      visible.unshift(s);
      used += lines.length + Math.max(0, lines.length - 1);
      if (used >= bodyRows) break;
    } else {
      visible.unshift(s);
      used += 1;
      if (used >= bodyRows) break;
    }
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" dimColor>
        {head}
        {child?.prompt ? `\n⏺ ${t('delegated prompt', '委派提示词')}：${child.prompt}` : ''}
      </Text>
      {visible.map((s, i) =>
        s.kind === 'md' ? (
          <MarkdownText key={i} text={s.text} columns={textBudget} />
        ) : s.line.kind === 'call' ? (
          <CallRow key={i} line={s.line} columns={textBudget} />
        ) : (
          <Text key={i} dimColor>
            {'  ⎿ '}
            {s.line.ok === false ? '✗' : '✓'}
            {` ${s.line.text}`}
          </Text>
        ),
      )}
    </Box>
  );
}

/** 调用行：与主 agent ToolRow 调用行同构（● [VERB] target，工具名青色高亮、target 灰、按列宽自然省略） */
function CallRow({ line, columns }: { line: ChildLine; columns: number }): JSX.Element {
  const sp = line.text.indexOf(' ');
  const verb = sp > 0 ? line.text.slice(0, sp) : line.text;
  const target = sp > 0 ? line.text.slice(sp + 1) : '';
  return (
    <Text>
      <Text dimColor>● </Text>
      <Text color="cyan">[{verb}]</Text>
      {target ? <Text color="gray"> {target}</Text> : null}
    </Text>
  );
}
