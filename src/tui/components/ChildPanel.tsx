import { Box, Text } from 'ink';
import { ChildLiveState } from '../session';
import { displayWidth, elideByWidth } from '../text-band';
import { formatTokens, formatDuration } from '../format';
import { Spinner } from './Spinner';
import { theme } from '../theme';

/** 子代理并行面板（动态区，输入框下侧，CC 式）：每个运行中子 agent 一行（规格 §3.1）——运行态信息由单行承载，
 *  完整转录经全屏查看视图（ChildInspector）查看；外层特殊边框（圆角主题主色，2026-09-27 用户裁决对标 CC）：
 *  与主链活动行视觉分域，派发批一眼可辨。完成态不进面板（2026-09-28 用户裁决：动态区只显运行中、无两页/计数行），
 *  归档即从面板离场折进历史区 SPAWN 行 detail，Ctrl+B 浏览器直接浏览全部已完成。空态渲染零占位帧 */
export function ChildPanel({ childrenState, columns }: { childrenState: ChildLiveState[]; columns: number }): JSX.Element {
  // 只承载运行中（2026-09-28 用户裁决）：完成行与计数概览行一律不进动态区，全部完成即面板整体消失
  const rows = childrenState.filter((c) => !c.done);
  if (rows.length === 0) return <Box />;
  const width = Math.max(8, columns - 4);
  const glyph = '✻';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      {rows.map((c) => {
        // 单行保证（2026-09-28 用户裁决：工具不要超过一行自动省略）：target 预算从内容宽实账起算——
        // [label] 前缀（displayWidth 口径，CJK 计 2）、每调用耗时段与 tokens 尾巴按实际字符串宽度计入，
        // 剩余宽度才均分给各调用 target；旧估算常数（每调用 9 / 尾巴 12）在长耗时段（10m 35s）与
        // 大 token 数（↑184k tokens）下双双击穿，行尾 tokens 折到第二行（真机截图实锤）
        const calls = c.calls ?? [];
        const headCost = glyph.length + 1 + displayWidth(c.label) + 2;
        const tail = ` · ↑${formatTokens(c.tokens)} tokens`;
        const durWidths = calls.map((call) => formatDuration(Math.max(0, Math.round((Date.now() - call.startedAt) / 1000))).length);
        const perCall = Math.max(8, Math.floor(
          (width - headCost - displayWidth(tail) - calls.length * 6 - durWidths.reduce((s, d) => s + d, 0)) / Math.max(1, calls.length),
        ));
        return (
        <Box key={c.label}>
          {calls.length > 0 ? (
            // 工具活动行（规格 §4.2 面板增强，与主链 taskState 口径对齐）：显示当前调用名+单调用耗时，
            // 轮换动词是「思考中」的语义、模型正在干活时退回动词即信息量倒挂
            <Text color={theme.accent} dimColor>
              {glyph} [{c.label}]{' '}
              <Text dimColor>
                {calls.map((call, i) => (
                  <Text key={call.callId}>
                    {i > 0 ? ' · ' : ''}[{elideByWidth(call.target, perCall)}]{' '}
                    {formatDuration(Math.max(0, Math.round((Date.now() - call.startedAt) / 1000)))}
                  </Text>
                ))}
                {' · '}↑{formatTokens(c.tokens)} tokens
              </Text>
            </Text>
          ) : (
            // Spinner 分支（思考中子代理）
            <Spinner startedAt={c.startedAt} tokens={c.tokens} label={c.label} steps={c.steps} columns={columns} />
          )}
        </Box>
        );
      })}
    </Box>
  );
}
