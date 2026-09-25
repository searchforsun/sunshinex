import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem } from '../session';
import { bandLines } from '../text-band';
import { formatDuration } from '../format';

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
    // 折叠摘要尾注：任务名之外的步数/耗时；meta 缺省（零子事件即败）整体省略
    const metaTail = isSpawn && meta
      ? `（${meta.steps} steps · ${formatDuration(Math.round(meta.durationMs / 1000))}）`
      : '';
    const detailLines = expanded ? (item.detail ?? '').split('\n') : [];
    return (
      <Box flexDirection="column">
        <Text backgroundColor={spawnHighlighted ? 'gray' : undefined}>
          <Text dimColor={expanded && isSpawn}>{expanded && isSpawn ? '▾ ' : '● '}</Text>
          <Text color="cyan">
            [{verb}]
          </Text>
          {target ? <Text color="gray"> {target}{metaTail}</Text> : null}
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
