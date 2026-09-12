import * as React from 'react';
import { Box, Text } from 'ink';
import { MdBlock, MdInline, parseMarkdown, inlineText, alignTable, stripVariationSelector } from '../markdown';
import { highlightLine, HiKind } from '../highlight';

/** 行内节点 → Ink JSX：加粗/斜体/删除线/行内代码（原色不铺底）/裸文本 */
function Inline({ nodes }: { nodes: MdInline[] }): JSX.Element {
  return (
    <Text>
      {nodes.map((n, i) => {
        if (n.kind === 'text') return <Text key={i}>{n.text}</Text>;
        if (n.kind === 'code') return <Text key={i}>{n.text}</Text>;
        if (n.kind === 'bold') return <Text key={i} bold><Inline nodes={n.children} /></Text>;
        if (n.kind === 'italic') return <Text key={i} italic><Inline nodes={n.children} /></Text>;
        return <Text key={i} strikethrough><Inline nodes={n.children} /></Text>;
      })}
    </Text>
  );
}

/** 标题分级：与正文同色不加彩，仅字形层级（1/4 加粗、5/6 加粗暗灰） */
function Heading({ level, inlines }: { level: number; inlines: MdInline[] }): JSX.Element {
  if (level <= 4) return <Text bold><Inline nodes={inlines} /></Text>;
  return <Text bold dimColor><Inline nodes={inlines} /></Text>;
}

/** diff 行着色：行首 + 绿 / - 红 / @@ 青 / 其余（含空格上下文）暗灰 */
export function diffLineColor(line: string): 'green' | 'red' | 'cyan' | 'gray' {
  if (line.startsWith('+')) return 'green';
  if (line.startsWith('-')) return 'red';
  if (line.startsWith('@@')) return 'cyan';
  return 'gray';
}

/** HiKind → ink 前景色映射（高亮 token 着色） */
const HI_COLOR: Record<HiKind, string> = {
  keyword: 'magenta',
  string: 'green',
  comment: 'gray',
  number: 'yellow',
  plain: '',
};

/** 围栏代码块：原色不铺底 + 首行语言标签；diff/patch 按行首 +/-/@@ 着色，其余已知语言按 token 高亮 */
function Fence({ lang, code, columns }: { lang: string; code: string; columns: number }): JSX.Element {
  const lines = code.split('\n');
  const isDiff = lang === 'diff' || lang === 'patch';
  return (
    <Box flexDirection="column">
      {lang ? <Text dimColor>{lang}</Text> : null}
      {lines.map((line, i) => {
        if (isDiff) {
          return (
            <Text key={i} color={diffLineColor(line)}>
              {line}
            </Text>
          );
        }
        const spans = highlightLine(lang, line);
        const known = spans.length > 1 || spans[0].kind !== 'plain';
        return (
          <Text key={i} dimColor={!known}>
            {spans.map((s, j) => (
              <Text key={j} color={HI_COLOR[s.kind] || undefined} dimColor={s.kind === 'comment'}>{s.text}</Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}

/** 列表：无序 `• `、有序 `n. ` 连续重排 + 缩进 */
function List({ ordered, items }: { ordered: boolean; items: MdInline[][] }): JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={i}>
          {ordered ? `${i + 1}. ` : '  • '}
          <Inline nodes={item} />
        </Text>
      ))}
    </Box>
  );
}

/** 引用：每行前缀 │ + 缩进 */
function Quote({ inlines }: { inlines: MdInline[] }): JSX.Element {
  const lines = inlineText(inlines).split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>│ {l}</Text>
      ))}
    </Box>
  );
}

/** 表格行拆段渲染：纯框线行（顶边/分隔/底边）整行暗色；内容行的 │ 边框字符暗色、单元格常规。
 * 对标 Claude Code 输出：框线弱化不喧宾夺主，表头由调用方 bold 加粗 */
function TableLine({ line, bold }: { line: string; bold?: boolean }): JSX.Element {
  if (!line.includes('│')) {
    return <Text dimColor bold={bold}>{line}</Text>;
  }
  const segs = line.split('│');
  return (
    <Text bold={bold}>
      {segs.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Text dimColor>│</Text> : null}
          {seg}
        </React.Fragment>
      ))}
    </Text>
  );
}

/** 表格：alignTable 圆角框线输出（表头加粗、边框暗色）；超宽降级为逐行原文 */
function Table({ headers, rows, columns }: { headers: MdInline[][]; rows: MdInline[][][]; columns: number }): JSX.Element {
  const headerTexts = headers.map(inlineText);
  const rowTexts = rows.map((r) => r.map(inlineText));
  const aligned = alignTable(headerTexts, rowTexts, columns);
  if (aligned.length === 0) {
    // 超宽降级：逐行输出原始单元格（` | ` 连接，不强制对齐；与对齐路径同口径去 VS16）
    const all = [headerTexts, ...rowTexts];
    return (
      <Box flexDirection="column">
        {all.map((cells, i) => (
          <Text key={i} bold={i === 0}>{cells.map(stripVariationSelector).join(' | ')}</Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {aligned.map((line, i) => (
        <TableLine key={i} line={line} bold={i === 1} />
      ))}
    </Box>
  );
}

/** Markdown 正文渲染：文本 → IR → Ink JSX（纯渲染，零 IO）；流式未闭合块已由解析器降级为段落 */
export function MarkdownText({ text, columns }: { text: string; columns: number }): JSX.Element {
  const blocks = parseMarkdown(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': return <Heading key={i} level={b.level} inlines={b.inlines} />;
          case 'fence': return <Fence key={i} lang={b.lang} code={b.code} columns={columns} />;
          case 'list': return <List key={i} ordered={b.ordered} items={b.items} />;
          case 'quote': return <Quote key={i} inlines={b.inlines} />;
          case 'table': return <Table key={i} headers={b.headers} rows={b.rows} columns={columns} />;
          case 'hr': return <Text key={i} dimColor>{'─'.repeat(Math.max(1, columns))}</Text>;
          default: return <Text key={i}><Inline nodes={b.inlines} /></Text>;
        }
      })}
    </Box>
  );
}
