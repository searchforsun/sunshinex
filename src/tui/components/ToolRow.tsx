import { Box, Text } from 'ink';
import { ChatItem } from '../session';
import { bandLines, displayWidth, elideByWidth } from '../text-band';
import { formatDuration } from '../format';
import { theme } from '../theme';
import { ResultCollapsed, TranscriptLines } from './ChildTranscript';

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
export function ToolRow({ item, columns, collapsed }: {
  item: ChatItem; columns: number; collapsed: boolean;
}): JSX.Element {
  if (item.kind === 'call') {
    const sp = item.text.indexOf(' ');
    const verb = sp > 0 ? item.text.slice(0, sp) : item.text;
    const target = sp > 0 ? item.text.slice(sp + 1) : '';
    const isSpawn = verb === 'SPAWN' && item.detail !== undefined;
    // 调用行恒中性态（dim ●）：运行/完成状态由动态区 Spinner 的绿色活动行承载（统一设计——Static 历史行
    // 打印一次不再重绘，若在此着运行态色，状态切换须等重挂才上屏且整屏重放引发闪屏；动态区帧级刷新零延迟）
    // 两态命中任一即重放转录：Tab 全场展开（!collapsed，既有）或浏览模式逐行展开（spawnExpanded）
    // 展开态：Tab 全场展开（!collapsed）重放转录（浏览逐行展开链已随统一列表收敛撤除）
    const expanded = item.detail !== undefined && !collapsed;
    const meta = item.subagentMeta;
    // 折叠摘要尾注：任务名之外的步数/耗时；meta 缺省（零子事件即败）整体省略
    const metaTail = isSpawn && meta
      ? `（${meta.steps} steps · ${formatDuration(Math.round(meta.durationMs / 1000))}）`
      : '';
    const detailLines = expanded ? (item.detail ?? '').split('\n') : [];
    // target 按列宽自然省略：前缀实账（● 2 + [verb] verb+2 + 空格 1）+ meta 尾注预留——固定 10 列对长动词
    // （TASK_WAIT 等）即行宽超终端列数，ink repeat(负数) RangeError（真机崩溃实锤，与 ChildInspector.CallRow 同修）
    const targetBudget = Math.max(16, columns - 5 - displayWidth(`[${verb}]`) - displayWidth(metaTail));
    const shownTarget = target ? elideByWidth(target, targetBudget) : '';
    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor={expanded && isSpawn}>{expanded && isSpawn ? '▾ ' : '● '}</Text>
          <Text color={theme.accent}>
            [{verb}]
          </Text>
          {target ? <Text color="gray"> {shownTarget}{metaTail}</Text> : null}
        </Text>
        {expanded && isSpawn ? (
          // SPAWN 展开与全屏视图同构（2026-09-28 用户裁决）：共享转录渲染器——正文段 Markdown、
          // 动词/结果/委派/统计行结构化呈现，替代原逐行裸 Text（星号裸露+碎片行放大呈现的病根）
          <TranscriptLines lines={detailLines} columns={columns - 4} />
        ) : (
          // detail 行按列宽硬折——无空格超长行（minified/base64）裸出即 yoga 宽度爆栈 CLI 崩溃（2026-09-30 实锤）
          detailLines.flatMap((l) => bandLines(l, Math.max(8, columns - 4))).map((l, i) => (
            <Text key={i} dimColor>
              {'    ' + l}
            </Text>
          ))
        )}
      </Box>
    );
  }
  // CR 剥除（与子代理视图同源）：Windows 子进程输出 CRLF，残留 CR 渲染即光标回卷幻影高度/错位碎片
  const body = (item.detail ?? item.text).replace(/\r/g, '');
  const lines = body.split('\n');
  if (collapsed && item.detail) {
    // 折叠摘要与子代理视图共用单点（ResultCollapsed）——形态漂移即真机「主/子 agent 工具行不同形」
    return <ResultCollapsed text={body} ok={!!item.ok} columns={columns} />;
  }
  return (
    <Box flexDirection="column">
      <Text dimColor color={item.ok ? theme.success : theme.error}>
        {'  ⎿ '}
        {item.ok ? '✓' : '✗'}
      </Text>
      {lines.flatMap((l) => bandLines(l, Math.max(8, columns - 4))).map((l, i) => (
        <Text key={i} dimColor>
          {'    ' + l}
        </Text>
      ))}
    </Box>
  );
}
