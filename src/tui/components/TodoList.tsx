import { t } from '../../i18n';
import { Box, Text } from 'ink';
import { TodoItem } from '../session';
import { wrapByWidth, elideByWidth } from '../text-band';
import { theme } from '../theme';

/**
 * 待办列表（输入框下侧常驻），两种形态，行数均恒定（不构成动态区高度波动源）：
 * 紧凑（运行中默认）：单行「todo n/N · ▸ 当前进行项」，文字按终端宽截断——勾选推进只改内容不增减行数；
 * 展开（Tab 展开模式或任务收束后）：全量清单逐行 ✓ 已完成（绿）/ ▸ 进行中 / ○ 未开始（暗），
 * 长项文按列宽省略到恒 1 行（2026-10-02「流式闪动」收尾：裸 Text 自然折行即击穿 App previewCap
 * 按 1 行/项的 chrome 实账，动态帧触顶走 ink3 clearTerminal 整屏重放=闪屏源），行数 = 清单长度 + 1 恒定。
 */
export function TodoList({
  todos,
  expanded,
  columns,
}: {
  todos: TodoItem[];
  expanded: boolean;
  columns: number;
}): JSX.Element | null {
  if (todos.length === 0) return null;
  const done = todos.filter((td) => td.status === 'completed').length;
  const current = todos.find((td) => td.status === 'in_progress') ?? todos.find((td) => td.status === 'pending');
  if (!expanded && current) {
    const prefix = t(`todo ${done}/${todos.length} · ▸ `, `待办 ${done}/${todos.length} · ▸ `);
    const text = wrapByWidth(current.text, Math.max(8, columns - 16))[0] ?? current.text;
    return (
      <Box paddingLeft={1}>
        <Text>{prefix + text}</Text>
      </Box>
    );
  }
  // 展开行恒 1 行：前缀 4 列（'  ✓ '/'  ▸ '/'  ○ '）+ 项文按剩余列宽省略（不折行——App 按 1 行/项实账）
  const itemText = (text: string): string => elideByWidth(text, Math.max(8, columns - 4));
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text dimColor>{t(`todo ${done}/${todos.length}`, `待办 ${done}/${todos.length}`)}</Text>
      {todos.map((item, i) =>
        item.status === 'completed' ? (
          <Text key={i} color={theme.success}>  ✓ {itemText(item.text)}</Text>
        ) : item.status === 'in_progress' ? (
          <Text key={i}>  ▸ {itemText(item.text)}</Text>
        ) : (
          <Text key={i} dimColor>  ○ {itemText(item.text)}</Text>
        ),
      )}
    </Box>
  );
}
