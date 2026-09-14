import * as React from 'react';
import { Text } from 'ink';
import { formatTokens } from '../format';

// 帧字形全部选用无 emoji 呈现属性的星形：✳（U+2733）带 emoji 变体，终端会改用彩色字形渲染、
// 完全无视前景色，观感成「图标」而非着色文本（与 ⏺→● 同款问题，故弃用）；✱ 等字形颜色严格跟随前景色
const FRAMES = ['✻', '✽', '✶', '✱', '✢'];
const VERBS = ['Pondering', 'Brewing', 'Weaving', 'Distilling'];

/** 运行态活动行：帧动画 + 动词轮换 + 耗时 + 本轮 tokens（英文标识） */
export function Spinner({ startedAt, tokens }: { startedAt: number; tokens: number }): JSX.Element {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    // 240ms：低于人眼闪烁敏感区（流式时与 token 合帧错频叠加，整帧擦写 ≤ 17 次/s）；与 5 帧序列取模保持词轮换节奏一致
    const timer = setInterval(() => setFrame((f) => f + 1), 240);
    return () => clearInterval(timer);
  }, []);
  const glyph = FRAMES[frame % FRAMES.length];
  const verb = VERBS[Math.floor(frame / 17) % VERBS.length];
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return (
    <Text color="green" dimColor>
      {glyph} <Text dimColor>{verb}… ({secs}s · ↑{formatTokens(tokens)} tokens)</Text>
    </Text>
  );
}
