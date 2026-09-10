import * as React from 'react';
import { Text } from 'ink';
import { formatTokens } from '../format';

const FRAMES = ['✻', '✽', '✶', '✳', '✢'];
const VERBS = ['Pondering', 'Brewing', 'Weaving', 'Distilling'];

/** 运行态活动行：帧动画 + 动词轮换 + 耗时 + 本轮 tokens（英文标识） */
export function Spinner({ startedAt, tokens }: { startedAt: number; tokens: number }): JSX.Element {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 160);
    return () => clearInterval(timer);
  }, []);
  const glyph = FRAMES[frame % FRAMES.length];
  const verb = VERBS[Math.floor(frame / 25) % VERBS.length];
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return (
    <Text dimColor>
      {glyph} {verb}… ({secs}s · ↑{formatTokens(tokens)} tokens)
    </Text>
  );
}
