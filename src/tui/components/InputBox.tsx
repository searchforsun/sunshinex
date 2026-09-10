import * as React from 'react';
import { Box, Text } from 'ink';

/** 常驻边框输入框：❯ 提示符 + 缓冲/占位；空闲态显示静态光标 ▊（键盘分发仍在 App 单一 useInput）；buffer 含 \n 时多行渲染 */
export function InputBox({ buffer, placeholder, active }: { buffer: string; placeholder: string; active: boolean }): JSX.Element {
  if (buffer.length === 0) {
    return (
      <Box borderStyle="round" borderColor={active ? 'cyan' : 'gray'} flexDirection="column" paddingX={1}>
        <Text>
          <Text color="cyan">❯ </Text>
          <Text dimColor>{placeholder}</Text>
          {active ? <Text>▊</Text> : null}
        </Text>
      </Box>
    );
  }
  const lines = buffer.split('\n');
  return (
    <Box borderStyle="round" borderColor={active ? 'cyan' : 'gray'} flexDirection="column" paddingX={1}>
      {lines.map((l, i) => (
        <Text key={i}>
          {i === 0 ? <Text color="cyan">❯ </Text> : <Text>{'  '}</Text>}
          <Text>{l}</Text>
          {active && i === lines.length - 1 ? <Text>▊</Text> : null}
        </Text>
      ))}
    </Box>
  );
}
