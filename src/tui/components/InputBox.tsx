import * as React from 'react';
import { Box, Text } from 'ink';

/** 常驻边框输入框：❯ 提示符 + 缓冲/占位；空闲态显示静态光标 ▊（键盘分发仍在 App 单一 useInput） */
export function InputBox({ buffer, placeholder, active }: { buffer: string; placeholder: string; active: boolean }): JSX.Element {
  return (
    <Box borderStyle="round" borderColor={active ? 'cyan' : 'gray'} flexDirection="column" paddingX={1}>
      <Text>
        <Text color="cyan">❯ </Text>
        {buffer.length > 0 ? <Text>{buffer}</Text> : <Text dimColor>{placeholder}</Text>}
        {active ? <Text>▊</Text> : null}
      </Text>
    </Box>
  );
}
