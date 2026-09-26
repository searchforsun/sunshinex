import * as React from 'react';
import { Box, Text } from 'ink';
import { formatDuration, formatTokens } from '../format';
import { ActiveCall, LiveTaskPhase } from '../task-state';
import { t } from '../../i18n';
import { elideByWidth } from '../text-band';

// 帧字形全部选用无 emoji 呈现属性的星形：✳（U+2733）带 emoji 变体，终端会改用彩色字形渲染、
// 完全无视前景色，观感成「图标」而非着色文本（与 ⏺→● 同款问题，故弃用）；✱ 等字形颜色严格跟随前景色
const FRAMES = ['✻', '✽', '✶', '✱', '✢'];
const VERBS = ['Pondering', 'Brewing', 'Weaving', 'Distilling'];

/** 运行态活动行：帧动画 + 动词轮换 + 耗时 + 本轮 tokens（英文标识）；label 可选（子代理面板头部携带 [label] 标识，缺省零变化）。
 *  phase/calls 可选（缺省 'thinking'/[]，规格 §5）：既有调用方零破坏；tool-pending/tool-awaiting 按活跃调用数逐行渲染。 */
export function Spinner({ startedAt, tokens, label, steps, phase = 'thinking', calls = [], columns = 80 }: {
  startedAt: number;
  tokens: number;
  label?: string;
  /** 子代理面板头部步骤计数（可选，缺省不显示——主链活动行无此语义） */
  steps?: number;
  /** 活任务阶段（缺省 thinking = 既有调用方零破坏） */
  phase?: LiveTaskPhase;
  /** tool-pending/tool-awaiting 的活跃调用清单；thinking/responding 忽略 */
  calls?: ActiveCall[];
  /** 终端列宽：活跃调用行动词按列宽自然省略（缺省 80，既有调用方零破坏） */
  columns?: number;
}): JSX.Element {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    // 240ms：低于人眼闪烁敏感区（流式时与 token 合帧错频叠加，整帧擦写 ≤ 17 次/s）；与 5 帧序列取模保持词轮换节奏一致
    const timer = setInterval(() => setFrame((f) => f + 1), 240);
    return () => clearInterval(timer);
  }, []);
  const glyph = FRAMES[frame % FRAMES.length];
  const verb = VERBS[Math.floor(frame / 17) % VERBS.length];
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (phase === 'tool-pending' || phase === 'tool-awaiting') {
    // 运行态单一化（2026-09-27 用户裁决）：subagent 类调用不在此重复出活动行——派发期子代理运行态
    // 由 ChildPanel 边框面板单点承载（信息量更大：当前调用 · step · tokens），主链活动行只呈现本链调用
    const own = calls.filter((c) => c.verb !== 'spawn');
    if (own.length === 0) return <Box />;
    return (
      <Box flexDirection="column">
        {own.map((c) => (
          <Text key={c.callId} color="green" dimColor>
            {glyph} [{elideByWidth(c.target, Math.max(16, columns - 20))}]{' '}
            <Text dimColor>
              {phase === 'tool-awaiting' ? t('awaiting approval', '等待审批') + ' · ' : ''}
              {formatDuration(Math.max(0, Math.round((Date.now() - c.startedAt) / 1000)))}
            </Text>
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Text color="green" dimColor>
      {glyph} {label ? `[${label}] ` : ''}
      <Text dimColor>
        {verb}… ({formatDuration(secs)}
        {typeof steps === 'number' && steps > 0 ? ` · step ${steps}` : ''} · ↑{formatTokens(tokens)} tokens)
      </Text>
    </Text>
  );
}
