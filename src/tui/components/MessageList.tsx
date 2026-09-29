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
  suppressHistory = false,
  rows,
  previewMaxRows,
}: {
  messages: ChatItem[];
  live?: LiveBlock;
  columns: number;
  banner: BannerInfo;
  /** 第一层（Tab）行折叠开关：false 时历史阶段组折叠为「正文+首个工具对+首个思考行」，true 全行 */
  expandAll: boolean;
  /** 第二层（Ctrl+O）内容深度开关：true 时最近正文锚点阶段的思考与工具结果展开全文 */
  latestFull: boolean;
  /** 全屏查看（ChildInspector）整屏接管：Static 历史条目置空——整页让位给全屏视图，
   *  退出时经重挂整屏重放恢复（2026-09-27 用户裁决：全屏独占，不与主 agent 历史拼接） */
  suppressHistory?: boolean;
  /** 终端行数：流式预览窗口上限随视口收缩（min(28, rows−6)），矮终端不超视口防中段起渲染；缺省固定上限 */
  rows?: number;
  /** 预览窗口上限显式覆盖（2026-09-30 App 动态区 chrome 实账直传）：在场时优先于 rows 联动公式 */
  previewMaxRows?: number;
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
  // 整屏接管（suppressHistory）：Static 条目置空（横幅一并让位）——全屏视图独占整页，退出经重挂整屏重放恢复
  const entries: TranscriptEntry[] = suppressHistory
    ? []
    : [
        { kind: 'banner', info: banner },
        ...visibleMessages.map((item, i) => ({
          kind: 'message' as const,
          item,
          full: decisions[i].full,
          visible: decisions[i].visible,
        })),
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
              <MessageRow
                item={entry.item}
                columns={columns}
                collapsed={!entry.full}
              />
            </Box>
          ) : null
        }
      </Static>
      {live ? <LiveArea live={live} columns={columns} rows={rows} maxRows={previewMaxRows} /> : null}
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
  // system 行按级别渲染（对标 Claude Code：信息类为辅助暗色，仅警告/失败用醒目色）
  if (item.role === 'system') {
    if (item.level === 'error') return <Text color={theme.error}>✗ {item.text}</Text>;
    if (item.level === 'warn') return <Text color={theme.warn}>! {item.text}</Text>;
    return <Text dimColor>{item.text}</Text>;
  }
  if (item.role === 'thinking') return <ThinkingRow item={item} collapsed={collapsed} />;
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
