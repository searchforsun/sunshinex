import * as React from 'react';
import { Box, Static, Text } from 'ink';
import { ChatItem, LiveBlock } from '../session';
import { bandLines } from '../text-band';
import { BannerInfo } from '../banner-info';
import { Banner } from './Banner';
import { ChatRound, reviewWindow, splitRounds } from '../history-view';
import { ToolRow } from './ToolRow';
import { MarkdownText } from './MarkdownText';
import { LiveArea } from './LiveArea';

/**
 * Static 区条目：横幅（首条）+ 已入档轮——打印一次后不再重绘（Claude Code 同款机制），
 * 滚动缓冲中每条内容只出现一次。
 */
export type TranscriptEntry = { kind: 'banner'; info: BannerInfo } | { kind: 'round'; round: ChatRound };

/** 入档水位：已入档轮次数。只进不退（Static 游标 append-only），仅 /new 清空时随重挂归零 */
function sealRounds(rounds: ChatRound[]): number {
  return rounds.length === 0 ? 0 : rounds.length - 1;
}

/**
 * 消息区分层：横幅与已收口轮走 ink Static 一次上屏（打印后不再重绘，滚动缓冲零重影）；
 * 动态区只承载末轮答复 + 实时流，帧高只随当前轮增长、不随对话轮数累积——
 * ink3 在 outputHeight >= stdout.rows 时会 clearTerminal 整屏重写（Windows 控制台下重影来源），
 * 层级切分让该路径实际不可达。历史内容默认全展开（思考全文、工具结果全文）。
 */
export function MessageList({
  messages,
  live,
  columns,
  banner,
  review,
  reviewEnd,
  expandedRound,
}: {
  messages: ChatItem[];
  live?: LiveBlock;
  columns: number;
  banner: BannerInfo;
  review: boolean;
  reviewEnd: number;
  expandedRound: number;
}): JSX.Element {
  const rounds = splitRounds(messages);
  const [seal, setSeal] = React.useState(0);
  // 渲染期派生水位（React 受控派生 state 模式）：水位只进不退；/new 收缩交给 Static epoch 重挂
  const sealed = Math.max(seal, sealRounds(rounds));
  const epochRef = React.useRef(0);
  const prevLenRef = React.useRef(0);
  if (messages.length < prevLenRef.current) epochRef.current += 1;
  prevLenRef.current = messages.length;
  if (sealed !== seal) setSeal(sealed);
  const closed = rounds.slice(0, sealed);
  const open = sealed < rounds.length ? rounds[sealed] : undefined;
  const entries: TranscriptEntry[] = [
    { kind: 'banner', info: banner },
    ...closed.map((round) => ({ kind: 'round' as const, round })),
  ];
  return (
    <Box flexDirection="column">
      <Static key={epochRef.current} items={entries}>
        {(entry) =>
          entry.kind === 'banner' ? (
            <Box key="banner">
              <Banner info={entry.info} columns={columns} />
            </Box>
          ) : (
            <Box key={`r-${entry.round.start}`} marginBottom={1}>
              <RoundItems items={entry.round.items} columns={columns} collapsed={false} />
            </Box>
          )
        }
      </Static>
      {review ? (
        <ReviewArea rounds={rounds} endIdx={reviewEnd} expandedRound={expandedRound} columns={columns} />
      ) : open ? (
        <Box marginBottom={1}>
          <RoundItems items={open.items} columns={columns} collapsed={false} />
        </Box>
      ) : null}
      {live ? <LiveArea live={live} /> : null}
    </Box>
  );
}

/** 单轮消息组：实时/历史恒展开；仅翻阅视口中未选中的轮折叠（摘要 + [Tab 展开] 提示） */
function RoundItems({ items, columns, collapsed }: { items: ChatItem[]; columns: number; collapsed: boolean }): JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((m, i) => (
        <MessageRow key={`${m.seq}-${i}`} item={m} columns={columns} collapsed={collapsed} />
      ))}
    </Box>
  );
}

/** 翻阅视口：默认最近 6 轮，↑↓ 逐轮追踪窗口滑动；同时仅展开一块（expandedRound） */
function ReviewArea({
  rounds,
  endIdx,
  expandedRound,
  columns,
}: {
  rounds: ChatRound[];
  endIdx: number;
  expandedRound: number;
  columns: number;
}): JSX.Element {
  const { start, end, view } = reviewWindow(rounds, endIdx);
  return (
    <Box flexDirection="column">
      <Text dimColor>
        ── 历史翻阅 · 第 {start + 1}–{end + 1} 轮 / 共 {rounds.length} 轮 · ↑↓ 翻阅 · Tab 展开末轮 · Esc 返回 ──
      </Text>
      {view.map((r, i) => (
        <Box key={r.start} marginBottom={1}>
          <RoundItems items={r.items} columns={columns} collapsed={start + i !== expandedRound} />
        </Box>
      ))}
    </Box>
  );
}

/** 行级 memo：高频增量帧只重渲染受影响的行（messages append-only，item 引用稳定） */
const MessageRow = React.memo(function MessageRow({
  item,
  columns,
  collapsed,
}: {
  item: ChatItem;
  columns: number;
  collapsed: boolean;
}): JSX.Element {
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
  if (item.role === 'system') return <Text color="yellow">! {item.text}</Text>;
  if (item.role === 'thinking') return <ThinkingRow item={item} collapsed={collapsed} />;
  if (item.role === 'step') return <Text color="cyan">▶ {item.text}</Text>;
  return <ToolRow item={item} collapsed={collapsed} />;
});

/** 思考行：实时/历史默认展开全文；仅翻阅折叠态显示摘要行（收束耗时统计） */
function ThinkingRow({ item, collapsed }: { item: ChatItem; collapsed: boolean }): JSX.Element {
  if (!collapsed && item.detail) {
    return (
      <Box flexDirection="column">
        <Text dimColor italic>
          ✻ {item.text}
        </Text>
        {item.detail.split('\n').map((l, i) => (
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
      {collapsed && item.detail !== undefined ? <Text dimColor> [Tab 展开]</Text> : null}
    </Text>
  );
}
