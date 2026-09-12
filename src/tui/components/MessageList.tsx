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
 * Static 区条目：横幅（首条）+ 逐条消息（含当前轮）——打印一次后不再重绘（Claude Code 同款机制），
 * 滚动缓冲中每条内容只出现一次，动态帧不承载任何历史渲染。
 */
export type TranscriptEntry = { kind: 'banner'; info: BannerInfo } | { kind: 'message'; item: ChatItem };

/**
 * 消息区逐消息分层：消息到达即入 Static 一次上屏，之后永不重绘；
 * 动态帧只剩实时流预览（回复末 8 行/思考单行）+ 输入框 + 状态栏，帧高有界且恒定——
 * ink3 在 outputHeight >= stdout.rows 时会 clearTerminal 整屏重写（超视口闪动/抖动/滚动位置丢失的根因），
 * 逐消息 Static 化让该路径实际不可达：流式中间态也以终稿形态滚入滚动缓冲，跟随滚动即可回看全部。
 * 思考过程与执行细节默认折叠为单行摘要；完整内容经 Tab 历史翻阅展开查看。
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
  const epochRef = React.useRef(0);
  const prevLenRef = React.useRef(0);
  if (messages.length < prevLenRef.current) epochRef.current += 1;
  prevLenRef.current = messages.length;
  const entries: TranscriptEntry[] = [
    { kind: 'banner', info: banner },
    ...messages.map((item) => ({ kind: 'message' as const, item })),
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
            <Box key={`m-${entry.item.seq}`} marginBottom={1}>
              <MessageRow item={entry.item} columns={columns} collapsed />
            </Box>
          )
        }
      </Static>
      {review ? (
        <ReviewArea rounds={splitRounds(messages)} endIdx={reviewEnd} expandedRound={expandedRound} columns={columns} />
      ) : null}
      {live ? <LiveArea live={live} columns={columns} /> : null}
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

/** 单轮消息组（仅翻阅视口使用）：选中轮展开全文，其余折叠摘要 */
function RoundItems({ items, columns, collapsed }: { items: ChatItem[]; columns: number; collapsed: boolean }): JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((m, i) => (
        <MessageRow key={`${m.seq}-${i}`} item={m} columns={columns} collapsed={collapsed} />
      ))}
    </Box>
  );
}

/** 行级 memo：翻阅视口切换选中块时只重渲染受影响的行（item 引用稳定） */
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
  return <ToolRow item={item} columns={columns} collapsed={collapsed} />;
});

/** 思考行：默认折叠为单行摘要（收束耗时统计，对标 Claude Code 斜体单行）；翻阅选中轮展开全文 */
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
      {collapsed && item.detail !== undefined ? <Text dimColor> [Tab 翻阅]</Text> : null}
    </Text>
  );
}
