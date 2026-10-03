import * as React from 'react';
import { Box, Text } from 'ink';
import { MdBlock, MdInline, parseMarkdown, inlineText, alignTable, stripVariationSelector } from '../markdown';
import { wrapByWidth, displayWidth } from '../text-band';
import { highlightLine } from '../highlight';
import { hiInkName, MD_HR_CHAR } from '../md-theme';

/** 超长行硬折预算（2026-09-30 崩溃根治）：ink/yoga 对无空格超长 token（minified 代码/长 URL/base64）不可
 *  软折——yoga 宽度天文数字，ink Output 的 String.repeat 即 RangeError: Invalid string length（整个 CLI
 *  崩溃退出，真机子代理全屏视图实锤）。所有可能含超长行的文本在进 JSX 前按列宽硬折——折行预算与
 *  markdownRowCount 的 safe 口径（columns-2）同源，估算与渲染行数不漂移 */
function hardWrap(text: string, columns: number): string[] {
  const budget = Math.max(4, columns - 2);
  return text.split('\n').flatMap((l) => wrapByWidth(l, budget));
}

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

/** 段落级超宽降级：常规行走 Inline（保留粗体/斜体/行内代码样式）；任一源行超列宽即纯文本硬折——
 *  样式让位于不崩溃（无空格超长 token ink/yoga 不可软折，RangeError 实锤见 hardWrap 注）。
 *  降级路径必须返回单个 <Text>（折行以 \n 承载，ink 原生支持 Text 内多行）：本组件被嵌在
 *  <Text bold>/<Text> 之内（Heading/List 前缀），返回 <Box> 即「Box nested in Text」渲染崩溃 */
function SafeInline({ nodes, columns }: { nodes: MdInline[]; columns: number }): JSX.Element {
  const plain = inlineText(nodes);
  const overflow = plain.split('\n').some((l) => displayWidth(l) > Math.max(4, columns - 2));
  if (!overflow) return <Inline nodes={nodes} />;
  return <Text>{hardWrap(plain, columns).join('\n')}</Text>;
}

/** 标题分级：与正文同色不加彩，仅字形层级（1/4 加粗、5/6 加粗暗灰） */
function Heading({ level, inlines, columns }: { level: number; inlines: MdInline[]; columns: number }): JSX.Element {
  if (level <= 4) return <Text bold><SafeInline nodes={inlines} columns={columns} /></Text>;
  return <Text bold dimColor><SafeInline nodes={inlines} columns={columns} /></Text>;
}

/** diff 行着色：行首 + 绿 / - 红 / @@ 青 / 其余（含空格上下文）暗灰 */
export function diffLineColor(line: string): 'green' | 'red' | 'cyan' | 'gray' {
  if (line.startsWith('+')) return 'green';
  if (line.startsWith('-')) return 'red';
  if (line.startsWith('@@')) return 'cyan';
  return 'gray';
}

/** 高亮 token → ink 前景色映射（高亮 token 着色）：色名取双链同源表 md-theme 的 inkName 形态，
 *  与 md-ansi 主链的 SGR 码形态同源——改色只动 md-theme.ts 一处 */

/** 围栏代码块：原色不铺底 + 首行语言标签；diff/patch 按行首 +/-/@@ 着色，其余已知语言按 token 高亮；
 *  每行先按列宽硬折（超长 minified 行不经折行即 yoga 宽度爆栈——CLI 崩溃源头，见 hardWrap） */
function Fence({ lang, code, columns }: { lang: string; code: string; columns: number }): JSX.Element {
  const lines = hardWrap(code, columns);
  const isDiff = lang === 'diff' || lang === 'patch';
  // 语言标签行去掉（用户裁决：围栏顶上的语言头是噪声——高亮已足够表意）
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (isDiff) {
          return (
            <Text key={i} color={diffLineColor(line)}>
              {line}
            </Text>
          );
        }
        const spans = highlightLine(lang, line);
        return (
          <Text key={i}>
            {spans.map((s, j) => (
              <Text key={j} color={hiInkName(s.kind) || undefined}>{s.text}</Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}

/** 列表：无序 `• `、有序 `n. ` 连续重排 + 缩进（项内超宽行降级硬折，见 SafeInline）；
 *  start=有序列表真实首号（markdown-it start 属性）——流式分裂的列表续块承接编号：
 *  「11. …」起的续块渲染 11. 起而非重排 1.（真机「1./1./1.」实锤的修复） */
function List({ ordered, items, columns, start }: { ordered: boolean; items: MdInline[][]; columns: number; start?: number }): JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={i}>
          {ordered ? `${(start ?? 1) + i}. ` : '  • '}
          <SafeInline nodes={item} columns={Math.max(8, columns - 4)} />
        </Text>
      ))}
    </Box>
  );
}

/** 引用：每行前缀 │ + 缩进（超宽行硬折，续行顶格——安全优先） */
function Quote({ inlines, columns }: { inlines: MdInline[]; columns: number }): JSX.Element {
  const lines = hardWrap(inlineText(inlines), columns);
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
  // 加粗只落在单元格文本段：边框 │ 恒暗色不加粗——bold 传染到边框会出现「加粗竖条」（列分隔处一条亮线）
  return (
    <Text>
      {segs.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Text dimColor>│</Text> : null}
          <Text bold={bold}>{seg}</Text>
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
        const block = renderBlock(b, columns);
        // 块间一个空行档位：段落/标题/表格/列表之间的呼吸感（对标 Claude Code 版式，多块长文不再挤作一团）；
        // 首块贴消息行首（消息级已有 marginBottom 分隔）
        return i > 0 ? (
          <Box key={i} marginTop={1}>
            {block}
          </Box>
        ) : (
          <React.Fragment key={i}>{block}</React.Fragment>
        );
      })}
    </Box>
  );
}

/** 单块渲染（key 由 MarkdownText 的包装层提供） */
function renderBlock(b: MdBlock, columns: number): JSX.Element {
  switch (b.type) {
    case 'heading': return <Heading level={b.level} inlines={b.inlines} columns={columns} />;
    case 'fence': return <Fence lang={b.lang} code={b.code} columns={columns} />;
    case 'list': return <List ordered={b.ordered} items={b.items} columns={columns} start={b.start} />;
    case 'quote': return <Quote inlines={b.inlines} columns={columns} />;
    case 'table': return <Table headers={b.headers} rows={b.rows} columns={columns} />;
    case 'hr': return <Text dimColor>{MD_HR_CHAR.repeat(Math.max(1, columns))}</Text>;
    default: return <SafeInline nodes={b.inlines} columns={columns} />;
  }
}
