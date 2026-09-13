import * as React from 'react';
import { Box, Static, Text } from 'ink';
import { ChatItem, LiveBlock } from '../session';
import { buildTranscriptDecisions } from '../transcript-view';
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
  | { kind: 'message'; item: ChatItem; full: boolean; visible: boolean };

/**
 * 消息区逐消息分层：消息到达即入 Static 一次上屏，之后永不重绘；
 * 动态帧只剩实时流预览（回复末 8 行/思考单行）+ 输入框 + 状态栏，帧高有界且恒定——
 * ink3 在 outputHeight >= stdout.rows 时会 clearTerminal 整屏重写（超视口闪动/抖动/滚动位置丢失的根因），
 * 逐消息 Static 化让该路径实际不可达：流式中间态也以终稿形态滚入滚动缓冲，跟随滚动即可回看全部。
 * 过程行（思考/工具）按「▶ 阶段锚点」两层折叠：默认最近正文锚点所在阶段全行可见、历史阶段折叠为
 * 「正文 + 首个工具调用对 + 首个思考行」；Tab 解除行折叠（全部过程行可见），Ctrl+O 把最近锚点阶段的
 * 思考与工具结果展开为全文——均经 tui-loop 清屏重挂整屏重放，视口永远只有一份历史。
 */
export function MessageList({
  messages,
  live,
  columns,
  banner,
  expandAll,
  latestFull,
}: {
  messages: ChatItem[];
  live?: LiveBlock;
  columns: number;
  banner: BannerInfo;
  /** 第一层（Tab）行折叠开关：false 时历史阶段组折叠为「正文+首个工具对+首个思考行」，true 全行 */
  expandAll: boolean;
  /** 第二层（Ctrl+O）内容深度开关：true 时最近正文锚点阶段的思考与工具结果展开全文 */
  latestFull: boolean;
}): JSX.Element {
  const epochRef = React.useRef(0);
  const prevLenRef = React.useRef(0);
  if (messages.length < prevLenRef.current) epochRef.current += 1;
  prevLenRef.current = messages.length;
  // 折叠决策逐条预计算：条目数组长度恒为 messages.length+1（append-only，维持 Static 索引推进不变式），
  // 不可见条目以 null 渲染（已打印的行留待下次重挂重放时收拢）
  const decisions = buildTranscriptDecisions(messages, { expandAll, latestFull });
  const entries: TranscriptEntry[] = [
    { kind: 'banner', info: banner },
    ...messages.map((item, i) => ({ kind: 'message' as const, item, full: decisions[i].full, visible: decisions[i].visible })),
  ];
  return (
    <Box flexDirection="column">
      <Static key={epochRef.current} items={entries}>
        {(entry) =>
          entry.kind === 'banner' ? (
            <Box key="banner">
              <Banner info={entry.info} columns={columns} />
            </Box>
          ) : entry.visible ? (
            <Box key={`m-${entry.item.seq}`} marginBottom={1}>
              <MessageRow item={entry.item} columns={columns} collapsed={!entry.full} />
            </Box>
          ) : null
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
