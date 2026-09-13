import * as React from 'react';
import { Box, Static, Text } from 'ink';
import { ChatItem, LiveBlock } from '../session';
import { bandLines } from '../text-band';
import { BannerInfo } from '../banner-info';
import { Banner } from './Banner';
import { ToolRow } from './ToolRow';
import { MarkdownText } from './MarkdownText';
import { LiveArea } from './LiveArea';

/**
 * Static 区条目：横幅（首条）+ 逐条消息（含当前轮）——打印一次后不再重绘（Claude Code 同款机制），
 * 滚动缓冲中每条内容只出现一次，动态帧不承载任何历史渲染。
 */
export type TranscriptEntry =
  | { kind: 'banner'; info: BannerInfo }
  | { kind: 'message'; item: ChatItem }
  | { kind: 'dump'; seq: number; anchorSeq: number; items: ChatItem[] };

/**
 * 消息区逐消息分层：消息到达即入 Static 一次上屏，之后永不重绘；
 * 动态帧只剩实时流预览（回复末 8 行/思考单行）+ 输入框 + 状态栏，帧高有界且恒定——
 * ink3 在 outputHeight >= stdout.rows 时会 clearTerminal 整屏重写（超视口闪动/抖动/滚动位置丢失的根因），
 * 逐消息 Static 化让该路径实际不可达：流式中间态也以终稿形态滚入滚动缓冲，跟随滚动即可回看全部。
 * 思考过程与执行细节默认折叠为单行摘要；完整内容按 Tab 展开打印（Claude Code ctrl+o 同款：整段 transcript 全展开滚入缓冲）。
 */
export function MessageList({
  messages,
  live,
  columns,
  banner,
  dumps,
}: {
  messages: ChatItem[];
  live?: LiveBlock;
  columns: number;
  banner: BannerInfo;
  /** 展开打印段：每次 Tab 触发追加一条（全展开形态整段入缓冲一次，不重绘不重复）；anchorSeq 锚定触发时末条消息 */
  dumps: Array<{ seq: number; anchorSeq: number; items: ChatItem[] }>;
}): JSX.Element {
  const epochRef = React.useRef(0);
  const prevLenRef = React.useRef(0);
  if (messages.length < prevLenRef.current) epochRef.current += 1;
  prevLenRef.current = messages.length;
  // entries 严格按时间序构建：dump 锚定在触发时最后一条消息之后（anchorSeq），
  // 保证 Static 已打印游标只增不移——后续新消息只会追加，已打印的 dump 绝不重印
  const entries: TranscriptEntry[] = [{ kind: 'banner', info: banner }];
  for (const item of messages) {
    entries.push({ kind: 'message', item });
    for (const d of dumps) {
      if (d.anchorSeq === item.seq) entries.push({ kind: 'dump', seq: d.seq, anchorSeq: d.anchorSeq, items: d.items });
    }
  }
  return (
    <Box flexDirection="column">
      <Static key={epochRef.current} items={entries}>
        {(entry) =>
          entry.kind === 'banner' ? (
            <Box key="banner">
              <Banner info={entry.info} columns={columns} />
            </Box>
          ) : entry.kind === 'dump' ? (
            <Box key={`dump-${entry.seq}`} flexDirection="column" marginBottom={1}>
              <Text dimColor>
                ── 会话历史（全展开）· 共 {entry.items.length} 条 · 终端滚动回看 · 按 Tab 可再次打印 ──
              </Text>
              <Box flexDirection="column">
                {entry.items.map((m) => (
                  <MessageRow key={m.seq} item={m} columns={columns} collapsed={false} />
                ))}
              </Box>
            </Box>
          ) : (
            <Box key={`m-${entry.item.seq}`} marginBottom={1}>
              <MessageRow item={entry.item} columns={columns} collapsed />
            </Box>
          )
        }
      </Static>
      {live ? <LiveArea live={live} columns={columns} /> : null}
    </Box>
  );
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
  if (item.role === 'step') return <Text>▶ {item.text}</Text>;
  return <ToolRow item={item} columns={columns} collapsed={collapsed} />;
});

/** 思考行：默认折叠为单行摘要（收束耗时统计，对标 Claude Code 斜体单行）；完整思考经 Tab 展开打印查看 */
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
    </Text>
  );
}
