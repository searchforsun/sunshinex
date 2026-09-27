import * as React from 'react';
import { Box, Text } from 'ink';
import { ChildLine, ChildLiveState } from '../session';
import { formatTokens, formatDuration } from '../format';
import { wrapByWidth } from '../text-band';
import { MarkdownText } from './MarkdownText';
import { TOOL_VERBS } from '../tool-verbs';
import { t } from '../../i18n';
import { theme } from '../theme';

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
  // 视口预算（2026-09-28 真机溢出修复）：按「实际渲染行数」估算——MarkdownText 按 textBudget 折行，
  // 长行（CJK 正文/长路径）1 源行 → 数显示行，按源行数计预算即帧超高溢出动态区（残影/碎片/重复观感的根因）。
  // 折行数经 wrapByWidth 精确预折（与 MarkdownText 同宽度口径），取尾适配后帧高永不超视口；
  // 委派 prompt 段另设上限（超长委派词整段挤占正文视口，取尾 + … 标记，2026-09-28 真机截图实锤）
  const MAX_PROMPT_ROWS = 6;
  const promptWrapped = child?.prompt ? wrapByWidth(child.prompt, Math.max(8, columns - 4)) : [];
  const promptClipped = promptWrapped.length > MAX_PROMPT_ROWS;
  const promptSegs = promptClipped ? [...promptWrapped.slice(-MAX_PROMPT_ROWS), '…'] : promptWrapped;
  const promptRows = promptSegs.length > 0 ? promptSegs.length + 1 : 0; // ⏺ 委派行 1 行 + prompt 折行行数
  // 边框 2 行 + 头部 1 行 + 1 行安全余量（MarkdownText 块间距等未建模项的缓冲）
  const bodyRows = Math.max(1, rows - 4 - promptRows);
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
  // 段实际渲染行数：md 段按折行口径（wrapByWidth 与 MarkdownText 同宽度）、结构行恒 1
  const segRows = (s: Seg): number =>
    s.kind === 'md' ? s.text.split('\n').reduce((n, l) => n + wrapByWidth(l, textBudget).length, 0) : 1;
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const remain = bodyRows - used;
    if (s.kind === 'md') {
      const n = segRows(s);
      if (n > remain) {
        // 段尾截取（折行口径）：md 段超预算时按折行后行数保留最新部分（视口永不溢出）
        const wrapped = s.text
          .split('\n')
          .flatMap((l) => wrapByWidth(l, textBudget))
          .slice(-remain);
        visible.unshift({ kind: 'md', text: wrapped.join('\n') });
        break;
      }
      visible.unshift(s);
      used += n + 1; // +1：MarkdownText 块间空的保守预留，多段转录下预算不低估
      if (used >= bodyRows) break;
    } else {
      visible.unshift(s);
      used += 1;
      if (used >= bodyRows) break;
    }
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} dimColor>
        {head}
        {promptSegs.length > 0
          ? `\n⏺ ${t('delegated prompt', '委派提示词')}：${promptClipped ? '\n' : ''}${promptSegs.join('\n')}`
          : ''}
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
      <Text color={theme.accent}>[{verb}]</Text>
      {target ? <Text color="gray"> {target}</Text> : null}
    </Text>
  );
}
