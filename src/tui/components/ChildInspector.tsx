import { Box, Static, Text } from 'ink';
import { ChildLiveState, pairChildResults } from '../session';
import { formatTokens, formatDuration } from '../format';
import { bandLines, wrapByWidth, elideByWidth, displayWidth } from '../text-band';
import { renderMd } from '../md-ansi';
import { segmentizeLines } from './ChildTranscript';
import { t } from '../../i18n';
import { theme } from '../theme';

/** 思考流滚动固定行数（与 LiveArea 同源）：块高恒定不跳动，流式预览窗口 */
const THINK_TAIL_LINES = 6;
/** 正文尾段预览上限（与 LiveArea 同源口径）：随终端行数联动收缩 */
const REPLY_PREVIEW_MAX_ROWS = 28;

/** 时间线条目（Static 打印一次进滚动缓冲，永不取尾截断——「不压缩」的机制保证）：
 *  与主 agent MessageRow 同构——md 段走 renderMd（markdansi 出口，与主链正文同一渲染器）、call 行 ● [VERB] target、result 行 ⎿ ✓/✗、
 *  think 行 ✻ 摘要（Tab 展开 detail 全文，对标 ThinkingRow） */
type TimelineItem =
  | { kind: 'md'; text: string }
  | { kind: 'call'; text: string }
  | { kind: 'result'; text: string; ok: boolean }
  | { kind: 'think'; text: string; detail?: string }
  | { kind: 'meta'; text: string };

/** 全屏查看视图（2026-09-29 用户裁决重构：视作独立主 agent session）——
 *  与主 agent MessageList+LiveArea 同构三层：委派 prompt 作用户输入带（灰底，只是有输入、不支持再次会话）+
 *  Static 时间线（打印一次进滚动缓冲，完整时间线不取尾不压缩）+ 动态区（未闭合正文尾段 markdown 预览、
 *  思考流 6 行滚动窗——流式可观测）+ 尾部状态行（label/step/tokens/耗时/Tab/Esc）；无外框，Esc 退出。 */
export function ChildInspector(props: {
  child?: ChildLiveState;
  archived?: { label: string; lines: string[]; steps?: number; durationMs?: number; prompt?: string; tokens?: number };
  columns: number;
  rows: number;
  /** Tab 两态（经 tui-loop 整屏重放，对标主 agent Tab）：缺省折叠（思考 ✻ 摘要行、结果单行省略）、
   *  展开完整时间线（思考 detail 全文、结果全文逐行） */
  expanded?: boolean;
}): JSX.Element {
  const { child, archived, columns, rows, expanded = false } = props;
  const label = child?.label ?? archived?.label ?? '';
  const steps = child?.steps ?? archived?.steps;
  const tokens = child?.tokens ?? archived?.tokens;
  const done = child?.done === true || archived !== undefined;
  const secs = child
    ? Math.max(0, Math.round(((child.doneAt ?? Date.now()) - child.startedAt) / 1000))
    : archived?.durationMs !== undefined
      ? Math.round(archived.durationMs / 1000)
      : undefined;

  // —— 时间线归一：live 取 transcript 结构行（先并行结果归位）；archived 经 ChildTranscript 同一分段器解析 detail 行 ——
  let prompt: string | undefined = child?.prompt ?? archived?.prompt;
  let items: TimelineItem[] = [];
  // 未闭合正文尾段（live 运行中）：留动态区实时预览（对标主 agent「已入档段进 Static、未入档尾段走 LiveArea」）
  let openTail: string[] = [];
  if (child) {
    // 正文段闭合规则（Static append-only 不变式）：段后出现结构行（call/result/think）或段内空行即闭合；
    // 空行随段入档（Markdown 段落语义保留，亦是增量入 Static 的稳态切割点——对标 flushReply 空行优先）
    let run: string[] = [];
    const flushRun = (): void => {
      if (run.length === 0) return;
      const text = run.join('\n');
      if (text.trim().length > 0) items.push({ kind: 'md', text });
      run = [];
    };
    for (const l of pairChildResults(child.transcript)) {
      if (l.kind === 'text') {
        run.push(l.text);
        if (l.text.trim() === '') flushRun();
        continue;
      }
      flushRun();
      if (l.kind === 'call') items.push({ kind: 'call', text: l.text });
      else if (l.kind === 'result') items.push({ kind: 'result', text: l.text, ok: l.ok !== false });
      else items.push({ kind: 'think', text: l.text, detail: l.detail });
    }
    if (done) flushRun();
    else openTail = run;
  } else if (archived) {
    // ⏺ 委派行恒过滤（2026-09-30 真机重复项修复）：archiveInto 同一委派词写两份（subagentMeta.prompt 驱动输入带
    // + detail ⏺ 行），meta 形态再渲染即开头双显；委派词由输入带单点承载。旧档 meta 缺 prompt 时回退取该行。
    const lines = archived.lines.filter((l) => {
      if (l.startsWith('⏺ ')) {
        if (prompt === undefined) prompt = l.replace(/^⏺ [^：]*：/, '');
        return false;
      }
      return true;
    });
    for (const s of segmentizeLines(lines)) {
      if (s.kind === 'md') items.push({ kind: 'md', text: s.text });
      else if (s.kind === 'call') items.push({ kind: 'call', text: s.text });
      else if (s.kind === 'result') items.push({ kind: 'result', text: s.text, ok: s.ok });
      else if (s.kind === 'think') items.push({ kind: 'think', text: s.text, detail: s.detail });
      else items.push({ kind: 'meta', text: s.text });
    }
  }

  // call+results 组块化（2026-09-30 对标主 agent ToolRow）：pairChildResults 已把结果归位到调用行后，
  // 此处把 call 及其后连续 result 合并为单个 Static 条目（同 Box 内渲染），结果不与调用行拆条
  type ResultItem = Extract<TimelineItem, { kind: 'result' }>;
  type StaticEntry = { kind: 'prompt'; text: string } | TimelineItem | { kind: 'group'; call: TimelineItem; results: ResultItem[] };
  const entries: StaticEntry[] = [];
  for (const item of items) {
    if (item.kind === 'call') entries.push({ kind: 'group', call: item, results: [] });
    else if (item.kind === 'result') {
      const last = entries[entries.length - 1];
      if (last?.kind === 'group') last.results.push(item);
      else entries.push(item); // 孤立结果（旧档）：独立条目
    } else entries.push(item);
  }

  // Static 条目：委派 prompt（用户输入带）+ 闭合时间线；打印一次进滚动缓冲——超长转录随滚动回看，不再取尾压缩
  const staticItems: StaticEntry[] = [
    ...(prompt !== undefined && prompt.trim().length > 0 ? [{ kind: 'prompt' as const, text: prompt }] : []),
    ...entries,
  ];

  // 动态区预览（live 运行中）：未闭合正文尾段 + 流式半行作 markdown 尾窗、思考流 6 行滚动窗（对标 LiveArea）
  const thinking = !done && child?.bufThink !== undefined && child.bufThink.length > 0;
  const tailText = !done && child ? [...openTail, ...(child.bufText ? [child.bufText] : [])].join('\n') : '';
  const textCap = thinking
    ? Math.max(4, Math.min(REPLY_PREVIEW_MAX_ROWS, rows - THINK_TAIL_LINES - 2))
    : Math.min(REPLY_PREVIEW_MAX_ROWS, Math.max(8, rows - 4));
  // 尾段预览（2026-09-30 markdansi 统一批次）：尾段原文一次性 renderMd（宽度即 width 参数自带收敛，
  // 旧 tailReplyPreview 源级折行预算退役）——超预览行预算时对 ANSI 输出按行 slice 自尾保留
  // （markdansi 行级 SGR 自闭合，切行不切半截码；尾部空行剥除不吃预算）
  const previewLines =
    tailText.trim().length > 0 ? renderMd(tailText, columns).replace(/\n+$/, '').split('\n').slice(-textCap) : [];
  const thinkWrapped = thinking
    ? (child!.bufThink ?? '').split('\n').flatMap((seg) => wrapByWidth(seg, Math.max(16, columns - 8)))
    : [];
  const thinkTail = thinkWrapped.slice(-THINK_TAIL_LINES);
  while (thinkTail.length > 0 && thinkTail.length < THINK_TAIL_LINES) thinkTail.unshift('');

  const head =
    `✻ [${label}] ${t('subagent view', '子代理视图')}` +
    `${typeof steps === 'number' ? ` · step ${steps}` : ''}` +
    `${tokens !== undefined ? ` · ↑${formatTokens(tokens)} tokens` : ''}` +
    `${secs !== undefined ? ` · ${formatDuration(secs)}` : ''}` +
    `${done ? ` · ${t('done', '完成')}` : ''}` +
    ` · Tab ${expanded ? t('collapse timeline', '收起时间线') : t('expand timeline', '展开时间线')}` +
    ` · ${t('Esc exit', 'Esc 退出')}`;

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item, i) => (
          <Box key={`t-${i}`} marginBottom={1}>
            {item.kind === 'prompt' ? (
              /* 委派词作用户输入带（对标 MessageRow user 形态：灰底分带、完整不截断） */
              <Box flexDirection="column">
                {bandLines(item.text, columns).map((line, j) => (
                  <Text key={j} backgroundColor="gray">
                    {line}
                  </Text>
                ))}
              </Box>
            ) : item.kind === 'group' ? (
              /* call+results 组（主 agent ToolRow 同构）：调用行 + 归位结果行同条目渲染 */
              <Box flexDirection="column">
                <CallRow text={item.call.text} columns={columns} />
                {item.results.map((r, j) => (
                  <ResultRow key={j} text={r.text} ok={r.ok} columns={columns} expanded={expanded} />
                ))}
              </Box>
            ) : item.kind === 'md' ? (
              <Text>{renderMd(item.text, columns)}</Text>
            ) : item.kind === 'call' ? (
              <CallRow text={item.text} columns={columns} />
            ) : item.kind === 'think' ? (
              <ThinkRow text={item.text} detail={item.detail} expanded={expanded} columns={columns} />
            ) : item.kind === 'meta' ? (
              <Text dimColor>{item.text}</Text>
            ) : (
              <ResultRow text={item.text} ok={item.ok} columns={columns} expanded={expanded} />
            )}
          </Box>
        )}
      </Static>
      {(previewLines.length > 0 || thinkTail.length > 0) && (
        <Box flexDirection="column" marginBottom={1}>
          {previewLines.map((l, i) => (
            <Text key={i}>{l.length > 0 ? l : ' '}</Text>
          ))}
          {thinkTail.map((l, i) => (
            <Text key={i} dimColor italic>
              {l.length > 0 ? `✻ ${l}` : ' '}
            </Text>
          ))}
        </Box>
      )}
      <Text color={theme.accent} dimColor>
        {head}
      </Text>
    </Box>
  );
}

/** 调用行：与主 agent ToolRow 调用行同构（● [VERB] target，工具名青色高亮、target 灰、按列宽自然省略） */
function CallRow({ text, columns }: { text: string; columns: number }): JSX.Element {
  const sp = text.indexOf(' ');
  const verb = sp > 0 ? text.slice(0, sp) : text;
  const target = sp > 0 ? text.slice(sp + 1) : '';
  // 前缀实账（● 2 列 + [verb] verb+2 列 + 空格 1 列）：固定 10 列扣减对长动词（TASK_WAIT/WEBSEARCH）
  // 即行宽超终端列数，ink Output 填充 repeat(负数) 直接 RangeError 崩溃（真机「Invalid string length」实锤）
  const prefixCols = 2 + displayWidth(`[${verb}]`) + 1;
  return (
    <Text>
      <Text dimColor>● </Text>
      <Text color={theme.accent}>[{verb}]</Text>
      {target ? <Text color="gray"> {elideByWidth(target, Math.max(8, columns - prefixCols))}</Text> : null}
    </Text>
  );
}

/** 思考行（对标 MessageList ThinkingRow）：缺省 ✻ 摘要单行；Tab 展开时后随 detail 全文（4 空格缩进斜体暗色） */
function ThinkRow({ text, detail, expanded, columns }: { text: string; detail?: string; expanded: boolean; columns: number }): JSX.Element {
  if (expanded && detail !== undefined && detail.length > 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor italic>
          {`✻ ${text}`}
        </Text>
        {/* detail 行按列宽硬折（无空格超长思考行裸出即 yoga 宽度爆栈） */}
        {detail.split('\n').flatMap((l) => bandLines(l, Math.max(8, columns - 4))).map((l, i) => (
          <Text key={i} dimColor italic>
            {'    ' + l}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Text dimColor italic>
      {`✻ ${text}`}
    </Text>
  );
}

/** 结果行（对标主 agent ToolRow 两态与着色）：⎿ ✓/✗ 按 ok 着绿/红（dimColor 同载，与 ToolRow 完全同源）；
 *  缺省折叠首行单行省略，Tab 展开全文逐行 */
function ResultRow({ text, ok, columns, expanded }: { text: string; ok: boolean; columns: number; expanded: boolean }): JSX.Element {
  if (expanded) {
    return (
      <Box flexDirection="column">
        <Text dimColor color={ok ? theme.success : theme.error}>
          {`  ⎿ ${ok ? '✓' : '✗'}`}
        </Text>
        {/* 全文逐行呈现，但每行按列宽硬折——无空格超长行（minified/base64）裸出即 yoga 宽度爆栈 CLI 崩溃 */}
        {text.split('\n').flatMap((l) => bandLines(l, Math.max(8, columns - 4))).map((l, i) => (
          <Text key={i} dimColor>
            {`    ${l}`}
          </Text>
        ))}
      </Box>
    );
  }
  // 内联单行（2026-09-30 用户终审裁决：全形标记行+多行内容「凭空多了高度」，主 agent 常态即内联摘要）：
  // 第一行吃满终端宽度直到边缘，内容超一整行才在行尾 … 收尾；CR 剥除（Windows exec 输出 CRLF，
  // 残留 CR 渲染即光标回卷幻影高度/错位碎片）；前缀「  ⎿ ✓ 」6 列实账扣除
  const first = (text.split('\n')[0] ?? '').replace(/\r/g, '');
  return (
    <Text dimColor color={ok ? theme.success : theme.error}>
      {'  ⎿ '}
      {ok ? '✓' : '✗'}
      {` ${elideByWidth(first, Math.max(8, columns - 6))}`}
    </Text>
  );
}
