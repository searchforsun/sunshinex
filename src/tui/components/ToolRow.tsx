import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem } from '../session';
import { bandLines, displayWidth, elideByWidth } from '../text-band';
import { formatDuration } from '../format';
import { t } from '../../i18n';

/** 帧字形与 Spinner 同源口径（运行态视觉语言统一）；无 emoji 呈现属性、颜色严格跟随前景色 */
const FRAMES = ['✻', '✽', '✶', '✱', '✢'];

/**
 * 工具行：调用行 ● [VERB] target（工具名高亮）；结果行 ⎿ ✓/✗。
 * 图标用 ● 而非 ⏺：⏺ 带 emoji 呈现属性，终端以彩色字形渲染并忽略前景色（dim 调不暗、恒呈亮色）；● 无 emoji 变体，颜色跟随 dimColor。
 * 默认折叠为单行摘要（首行截断）——执行细节不刷屏，全文经 Tab 切换历史展开查看；
 * Tab 切换历史展开（清屏重挂整屏重放）时以全展开形态渲染完整 observation。
 * detail 缺失时 text 即全部内容（≤200 字摘要），无折叠必要、直接展示。
 * SPAWN 调用行两态（子代理显示规格 §3.2）：折叠=● 单行 + subagentMeta 摘要尾注（steps/耗时），
 * 逐行展开（spawnExpanded，Ctrl+B 浏览模式 Enter 切换）= ▾ 头行 + 转录 4 空格缩进重放；
 * Tab 全场展开（!collapsed）与逐行展开任一命中即重放转录，两机制正交。
 */
export function ToolRow({ item, columns, collapsed, spawnExpanded = false, spawnHighlighted = false }: {
  item: ChatItem; columns: number; collapsed: boolean;
  /** SPAWN 行逐行展开：仅 SPAWN call 行消费，其它调用行零影响 */
  spawnExpanded?: boolean;
  /** 浏览模式光标行反色标记 */
  spawnHighlighted?: boolean;
}): JSX.Element {
  // 原地运行态（2026-09-26 用户裁决「执行时原地显示运行中状态」）：去 Static 全量渲染后，
  // pending 调用行可在历史区原地变身——240ms 帧动画 + 实时耗时，结果回程即定格为中性 ● 行
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (item.kind !== 'call' || item.pending !== true) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 240);
    return () => clearInterval(timer);
  }, [item.kind, item.pending]);
  if (item.kind === 'call') {
    const sp = item.text.indexOf(' ');
    const verb = sp > 0 ? item.text.slice(0, sp) : item.text;
    const target = sp > 0 ? item.text.slice(sp + 1) : '';
    const isSpawn = verb === 'SPAWN' && item.detail !== undefined;
    // 调用行恒中性态（dim ●）：运行/完成状态由动态区 Spinner 的绿色活动行承载（统一设计——Static 历史行
    // 打印一次不再重绘，若在此着运行态色，状态切换须等重挂才上屏且整屏重放引发闪屏；动态区帧级刷新零延迟）
    // 两态命中任一即重放转录：Tab 全场展开（!collapsed，既有）或浏览模式逐行展开（spawnExpanded）
    const expanded = item.detail !== undefined && (!collapsed || spawnExpanded);
    const meta = item.subagentMeta;
    const running = item.pending === true;
    // 原地运行态：pending 调用行绿色动画 glyph + 实时耗时；结果回程 pending 翻 false 定格为中性 ● 行
    const glyph = running ? FRAMES[frame % FRAMES.length] : '●';
    const elapsed = running ? ` ${formatDuration(Math.max(0, Math.round((Date.now() - item.ts) / 1000)))}` : '';
    // 折叠摘要尾注：任务名之外的步数/耗时；meta 缺省（零子事件即败）整体省略
    const metaTail = isSpawn && meta
      ? `（${meta.steps} steps · ${formatDuration(Math.round(meta.durationMs / 1000))}）`
      : '';
    const detailLines = expanded ? (item.detail ?? '').split('\n') : [];
    // target 按列宽自然省略：前缀「● [VERB] 」约 10 列 + meta 尾注预留，剩余宽度全给 target（宽列完整、窄列 … 收尾）
    const targetBudget = Math.max(16, columns - 10 - displayWidth(metaTail));
    const shownTarget = target ? elideByWidth(target, targetBudget) : '';
    return (
      <Box flexDirection="column">
        <Text backgroundColor={spawnHighlighted ? 'gray' : undefined}>
          <Text color={running ? 'green' : 'gray'} dimColor={!running && expanded && isSpawn}>
            {expanded && isSpawn ? '▾ ' : glyph + ' '}
          </Text>
          <Text color="cyan">
            [{verb}]
          </Text>
          {target ? <Text color="gray"> {shownTarget}{metaTail}</Text> : null}
          {running ? <Text color="green" dimColor>{elapsed}</Text> : null}
        </Text>
        {detailLines.map((l, i) => (
          <Text key={i} dimColor>
            {'    ' + l}
          </Text>
        ))}
      </Box>
    );
  }
  const body = item.detail ?? item.text;
  const lines = body.split('\n');
  if (collapsed && item.detail) {
    // 行宽预算：前缀「  ⎿ ✓ 」6 列，摘要总长 ≤ 终端列宽（截断省略号保留首行内容语义）
    const budget = Math.max(16, columns - 6);
    const first = bandLines(lines[0], budget)[0];
    const clipped = first !== lines[0];
    return (
      <Text dimColor color={item.ok ? 'green' : 'red'}>
        {'  ⎿ '}
        {item.ok ? '✓' : '✗'}
        {` ${first}${clipped ? '…' : ''}`}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text dimColor color={item.ok ? 'green' : 'red'}>
        {'  ⎿ '}
        {item.ok ? '✓' : '✗'}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} dimColor>
          {'    ' + l}
        </Text>
      ))}
    </Box>
  );
}
