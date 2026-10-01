import * as React from 'react';
import { Box, Static, Text } from 'ink';
import { ChatItem, LiveBlock } from '../session';
import { buildTranscriptDecisions } from '../transcript-view';
import { bandLines } from '../text-band';
import { BannerInfo } from '../banner-info';
import { Banner } from './Banner';
import { ToolRow } from './ToolRow';
import { MarkdownText } from './MarkdownText';
import { LiveArea, THINK_TAIL_LINES } from './LiveArea';
import { TailLedger, printedEntryLines, recomputeTailPlan } from '../tail-rewrite';
import { renderMd } from '../md-ansi';
import { theme } from '../theme';

/**
 * Static 区条目：横幅（首条）+ 逐条消息（含当前轮）——打印一次后不再重绘（Claude Code 同款机制），
 * 滚动缓冲中每条内容只出现一次，动态帧不承载任何历史渲染。
 */
export type TranscriptEntry =
  | { kind: 'banner'; info: BannerInfo }
  | { kind: 'message'; item: ChatItem; full: boolean; visible: boolean };

/**
 * 消息区逐消息分层：消息到达即入 Static 一次上屏，之后永不重绘；
 * 动态帧只剩实时流预览（正文未完结构尾段原文预览/思考 6 行滚动窗）+ 输入框 + 状态栏，帧高有界且恒定——
 * ink3 在 outputHeight >= stdout.rows 时会 clearTerminal 整屏重写（超视口闪动/抖动/滚动位置丢失的根因），
 * 逐消息 Static 化让该路径实际不可达：流式中间态也以终稿形态滚入滚动缓冲，跟随滚动即可回看全部。
 * 过程行（思考/工具）行折叠为 Tab opt-in（2026-09-30 用户裁决：缺省 expandAll=true 全行展开、运行中不自动折叠——
 * 折叠重写即闪屏源；Tab 进入折叠形态后历史阶段组折叠为「正文 + 首个工具调用对 + 首个思考行」），
 * Ctrl+O 展开**当前一个轮次**（自最后一条 user 指令行起，2026-09-30 用户裁决）
 * 的所有工具与思考行全文——均经 tui-loop 清屏重挂整屏重放，视口永远只有一份历史。
 */
export function MessageList({
  messages,
  live,
  columns,
  rows = 24,
  banner,
  expandAll,
  latestFull,
  suppressHistory = false,
  ledger,
  rewriteFrom,
  previewCap,
  dockRegion,
}: {
  messages: ChatItem[];
  live?: LiveBlock;
  columns: number;
  /** 视口行数（MdBufferPreview 尾窗限界的回落数；缺省 24 与 App 的 useStdout 兜底同口径） */
  rows?: number;
  banner: BannerInfo;
  /** 第一层（Tab）行折叠开关：false 时历史阶段组折叠为「正文+首个工具对+首个思考行」，true 全行 */
  expandAll: boolean;
  /** 第二层（Ctrl+O）内容深度开关：true 时当前一个轮次（自最后一条 user 指令行起）的所有工具与思考行展开全文 */
  latestFull: boolean;
  /** 全屏查看（ChildInspector）整屏接管：Static 历史条目置空——整页让位给全屏视图，
   *  退出时经重挂整屏重放恢复（2026-09-27 用户裁决：全屏独占，不与主 agent 历史拼接） */
  suppressHistory?: boolean;
  /** 打印账本（2026-09-30 方案 A）：逐渲染记录已打印条目的形态与行数并重算尾部重写计划，
   *  供 tui-loop 定夺「就地擦写只重放变化尾部」；缺省不记账（零行为变化，测试兼容） */
  ledger?: TailLedger;
  /** 尾部重写起点（tui-loop 经 retain 预置、App 挂载一次性消费透传）：本挂载中该下标以前的
   *  条目渲染 null 不重放（屏上原样保留）；undefined=整屏重放 */
  rewriteFrom?: number;
  /** 预览尾窗行数上限（App 按 chrome 实账收缩后传入，2026-09-30「贴地不再上提」：总帧高 ≤ rows-1 使
   *  ink3 clearTerminal 路径不可达）；缺省回落旧 F1 公式 min(28, max(8, rows-6))（测试兼容） */
  previewCap?: number;
  /** 贴底垫层预算（2026-10-01「主 agent 正文流式贴底不再跳中间」）：dock+预览两段的行数预算
   *  （App 按 rows-1-chrome 实账传入）；本组件按当前预览实高垫出差额空行，动态帧恒高 rows-1——
   *  log-update 帧恒占满视口（末行留光标），状态栏恒贴屏底，历史短于视口不再悬中、任何帧高变迁
   *  不再提跳；预览满 cap 时垫层恰为 0（与 previewCap 预算无缝衔接）。undefined=不垫（顶锚旧形态，
   *  首轮无历史/模态卡/全屏查看态） */
  dockRegion?: number;
}): JSX.Element {
  const epochRef = React.useRef(0);
  const prevLenRef = React.useRef(0);
  if (messages.length < prevLenRef.current) epochRef.current += 1;
  prevLenRef.current = messages.length;
  // 时间线撤 SPAWN 行（2026-09-28 用户裁决：子代理统一由动态区承载，历史区不再出现 spawn 调用/结果行）：
  // 归档 SPAWN call 行（subagentMeta 在位）与其配对 result 行渲染层整对剔除；journal/回看数据不动，
  // ChildInspector 回看、Ctrl+B 浏览器数据源照旧。配对口径：result.callId → spawn call 行 seq（延迟入档成对语义下单点）；
  // 旧档 callId 缺省时退化为保留（只按 subagentMeta 剔除调用行，不误伤普通工具结果）
  const spawnCallSeqs = new Set(
    messages.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.subagentMeta).map((m) => m.seq),
  );
  const callSeqMap = new Map(messages.filter((m) => m.kind === 'call').map((m) => [m.callId, m.seq]));
  const spawnResultSeqs = new Set(
    messages
      .filter((m) => m.kind === 'result' && m.callId !== undefined && spawnCallSeqs.has(callSeqMap.get(m.callId) ?? -1))
      .map((m) => m.seq),
  );
  const visibleMessages = messages.filter((m) => !spawnCallSeqs.has(m.seq) && !spawnResultSeqs.has(m.seq));
  // 折叠决策逐条预计算：条目数组长度恒为 visibleMessages.length+1（append-only，维持 Static 索引推进不变式），
  // 不可见条目以 null 渲染（已打印的行留待下次重挂重放时收拢）
  const decisions = buildTranscriptDecisions(visibleMessages, { expandAll, latestFull });
  // 打印账本记账（2026-09-30 方案 A）：新增条目按「本渲染将打印的形态」入账（visible=false 渲染 null 记 0 行；
  // 行数不可数 → forceFull 闩，本次挂载内 tail 一律降级全量）；随后重算「屏上 vs 当前决策」的
  // 尾部重写计划。rewriteFrom 挂载的前缀条目结构性缺席（账本前缀槽位已在挂载端截留），记账自然只覆盖尾部
  if (ledger !== undefined) {
    for (let i = ledger.slots.length; i < visibleMessages.length; i++) {
      const item = visibleMessages[i]!;
      const d = decisions[i]!;
      if (!d.visible) {
        ledger.slots.push({ item, visible: false, full: d.full, lines: 0 });
        continue;
      }
      const counted = printedEntryLines(item, d.full, columns);
      if (counted === undefined) {
        ledger.forceFull = true;
        ledger.slots.push({ item, visible: true, full: d.full, lines: 0 });
        continue;
      }
      // ansi 条目：片段文本恒以单 \n 收尾（mdPushFragment 归一），尾部空行是条目自体（占 1 行）、
      // 块间 margin 由它承载（渲染层 marginBottom 折 0）——账面 +1 即该尾部空行。
      // 其余条目：块间 marginBottom 折叠语义按「边界」算：仅下一块是续块（同段相邻）时折叠——
      // 末尾续块与其后的统计行/工具行之间是不同内容，间隔保留（真机「正文与时间步骤没间隔」病根）
      const next = visibleMessages[i + 1];
      ledger.slots.push({ item, visible: true, full: d.full, lines: counted + (item.ansi ? 1 : next?.cont ? 0 : 1) });
    }
    recomputeTailPlan(ledger, visibleMessages, decisions);
  }
  // 整屏接管（suppressHistory）：Static 条目置空（横幅一并让位）——全屏视图独占整页，退出经重挂整屏重放恢复；
  // 尾部重写挂载（rewriteFrom 在场）：横幅与前缀条目一律不重放——屏上原样保留，重挂只重放变化尾部
  const entries: TranscriptEntry[] = suppressHistory
    ? []
    : rewriteFrom === undefined
      ? [
          { kind: 'banner', info: banner },
          ...visibleMessages.map((item, i) => ({
            kind: 'message' as const,
            item,
            full: decisions[i].full,
            visible: decisions[i].visible,
          })),
        ]
      : visibleMessages.map((item, i) => ({
          kind: 'message' as const,
          item,
          full: decisions[i].full,
          visible: decisions[i].visible,
        }));
  // cont 边界折叠集（2026-09-30 间隔回归修复）：下一可见消息是续块（同段相邻）的当前块 seq——
  // 折叠语义按「边界」算：仅当下一块是同段续块才折叠当前块的下边距；末尾续块与其后的统计行/
  // 工具行之间是不同内容，间隔保留（真机「正文与时间步骤没间隔」病根）
  const gapFoldAfter = new Set(visibleMessages.filter((m, i) => visibleMessages[i + 1]?.cont).map((m) => m.seq));
  // 贴底垫层（2026-10-01）：预览实高先算实账（reply 尾窗行 + … 提示行 + marginBottom 1；thinking 恒 6 行
  // 滚动窗；reply 尾段排空瞬间预览渲染 0 行——账随渲染走，不得按「live 在场」粗记 6），垫层 = 预算 − 实高
  const cap = previewCap ?? Math.min(28, Math.max(8, rows - 6));
  const preview = live !== undefined && live.kind === 'reply' ? mdPreviewBlock(live, columns, cap) : undefined;
  const previewRows =
    live === undefined
      ? 0
      : live.kind === 'reply'
        ? preview !== undefined
          ? preview.lines.length + (preview.truncated ? 1 : 0) + 1 /* 预览 Box marginBottom */
          : 0
        : THINK_TAIL_LINES;
  const dockPad = dockRegion !== undefined ? Math.max(0, dockRegion - previewRows) : 0;
  return (
    <Box flexDirection="column">
      <Static key={epochRef.current} items={entries}>
        {(entry) =>
          entry.kind === 'banner' ? (
            <Box key="banner">
              <Banner info={entry.info} columns={columns} />
            </Box>
          ) : entry.visible ? (
            // ansi 条目折叠 marginBottom（2026-10-01「区域间距忽大忽小」根治）：markdansi 流式片段恒以
            // 单 \n 收尾（mdPushFragment 归一），ink 实测尾部换行落 1 空行——它本身就是块间 margin
            // （5822529「块间单空行」的原生载体），再叠 marginBottom=1 即双空行（真机列表↔标题间
            // 2 空行、与块内单空行档位不一致的病根）。折叠后所有区域边界统一单空行
            <Box key={`m-${entry.item.seq}`} marginBottom={entry.item.ansi || gapFoldAfter.has(entry.item.seq) ? 0 : 1}>
              <MessageRow
                item={entry.item}
                columns={columns}
                collapsed={!entry.full}
              />
            </Box>
          ) : null
        }
      </Static>
      {dockPad > 0 ? <Box height={dockPad} /> : null}
      {live ? (
        live.kind === 'reply' ? (
          preview !== undefined ? (
            <Box flexDirection="column" marginBottom={1}>
              {preview.truncated ? <Text dimColor>…</Text> : null}
              {preview.lines.map((line: string, i: number) => (
                <Text key={i}>{line || ' '}</Text>
              ))}
            </Box>
          ) : null
        ) : (
          <LiveArea live={live} columns={columns} />
        )
      ) : null}
    </Box>
  );
}

/** 动态区未入档尾段预览行装配（纯函数；2026-10-01 从 MdBufferPreview 组件抽取——垫层计行与渲染
 *  必须同源，两份手写必漂移）。预览源 = mdTailStart 水位切片（streamer 缓冲期未消费结构；
 *  2026-09-30 真机「渲染+原文同屏」修复：旧 tailPartial 反向扫全量源，表格入档后撞「表头+分隔行」
 *  即把表头→源尾全当未完结构重演裸文本）。实时渲染：缓冲期每帧对未消费区做 markdansi 渲染——
 *  表格边框随行数长出、围栏带高亮长出；闭合瞬间 streamer 发射同渲染器的 Static 块，无缝衔接。
 *  与 Static 同出口（renderMd：归一+主题+爆栈兜底），帧高限界沿用 F1（自尾保留 cap 行 + … 提示）：
 *  未闭合围栏/表格 hold 期 markdansi 零 ansi 入档、水位切片自结构起点整段返回，无上限即帧高随内容
 *  无界增长 → outputHeight >= stdout.rows 触发 ink3 clearTerminal 整屏重写（闪屏病根）。
 *  空尾段（无未完结构）返回 undefined（不占帧高）。 */
export function mdPreviewBlock(live: LiveBlock, columns: number, cap: number): { lines: string[]; truncated: boolean } | undefined {
  const start = typeof live.tailStart === 'number' ? live.tailStart : live.text.lastIndexOf('\n') + 1;
  const tail = live.text.slice(start);
  if (tail.trim().length === 0) return undefined;
  const rendered = renderMd(tail, columns);
  const all = rendered.replace(/\n+$/, '').split('\n');
  if (all.every((l) => l.trim().length === 0)) return undefined;
  return { lines: all.length > cap ? all.slice(-cap) : all, truncated: all.length > cap };
}

/** 行级 memo：仅当 item/详略状态变化时重渲染（item 引用稳定） */
const MessageRow = React.memo(function MessageRow({
  item,
  columns,
  collapsed,
}: {
  item: ChatItem;
  columns: number;
  collapsed: boolean;
}): JSX.Element {
  // ansi 条目（Task 2 markdansi 流式通道）：text 已是渲染后 ANSI，直嵌 Text——再过 MarkdownText
  // 即双重渲染（框线表格被当源 markdown 解析）且 ANSI 转义被按字面计宽；宽度已在产生端
  // wrapAnsiLines 收敛，此处零加工上屏
  if (item.ansi) return <Text>{item.text}</Text>;
  if (item.role === 'user') {
    return (
      <Box flexDirection="column">
        {bandLines(item.text, columns).map((line, i) => (
          <Text key={i} backgroundColor="gray">
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  if (item.role === 'assistant') return <MarkdownText text={item.text} columns={columns} />;
  // system 行按级别渲染（对标 Claude Code：信息类为辅助暗色，仅警告/失败用醒目色）
  if (item.role === 'system') {
    if (item.level === 'error') return <Text color={theme.error}>✗ {item.text}</Text>;
    if (item.level === 'warn') return <Text color={theme.warn}>! {item.text}</Text>;
    return <Text dimColor>{item.text}</Text>;
  }
  if (item.role === 'thinking') return <ThinkingRow item={item} columns={columns} collapsed={collapsed} />;
  // step 阶段行：正文经 MarkdownText 渲染（与主 agent 正文同渲染器，加粗/代码不再裸露星号），▶ 前缀标识阶段
  if (item.role === 'step') {
    return (
      <Box>
        <Text>▶ </Text>
        <Box flexDirection="column">
          <MarkdownText text={item.text} columns={Math.max(16, columns - 3)} />
        </Box>
      </Box>
    );
  }
  return <ToolRow item={item} columns={columns} collapsed={collapsed} />;
});

/** 思考行：默认折叠为单行摘要（收束耗时统计，对标 Claude Code 斜体单行）；完整思考经 Tab 展开打印查看。
 *  detail 行按列宽硬折——无空格超长行（minified/base64）裸出即 yoga 宽度爆栈 CLI 崩溃（2026-09-30 实锤） */
function ThinkingRow({ item, columns, collapsed }: { item: ChatItem; columns: number; collapsed: boolean }): JSX.Element {
  if (!collapsed && item.detail) {
    return (
      <Box flexDirection="column">
        <Text dimColor italic>
          ✻ {item.text}
        </Text>
        {item.detail.split('\n').flatMap((l) => bandLines(l, Math.max(8, columns - 4))).map((l, i) => (
          <Text key={i} dimColor italic>
            {'    ' + l}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Text dimColor italic>
      ✻ {item.text}
    </Text>
  );
}
