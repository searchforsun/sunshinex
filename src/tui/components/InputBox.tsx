import * as React from 'react';
import { Box, Text } from 'ink';

/**
 * 常驻边框输入框：❯ 提示符 + 缓冲/占位。
 * 光标 ▊ 按 cursor 偏移（buffer 内扁平字符下标）渲染，←→/Home/End 移动；
 * buffer 含 \n 时多行渲染，光标行按列拆分为「前 ▊ 后」三段。
 */
export function InputBox({
  buffer,
  placeholder,
  active,
  cursor = buffer.length,
}: {
  buffer: string;
  placeholder: string;
  active: boolean;
  cursor?: number;
}): JSX.Element {
  const pos = Math.min(Math.max(0, cursor), buffer.length);
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
  let lineIdx = 0;
  let col = 0;
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length;
    if (pos <= acc + len) {
      lineIdx = i;
      col = pos - acc;
      break;
    }
    acc += len + 1;
  }
  return (
    <Box borderStyle="round" borderColor={active ? 'cyan' : 'gray'} flexDirection="column" paddingX={1}>
      {lines.map((l, i) => {
        const onCursor = active && i === lineIdx;
        return (
          <Text key={i}>
            {i === 0 ? <Text color="cyan">❯ </Text> : <Text>{'  '}</Text>}
            {onCursor ? (
              <>
                <Text>{l.slice(0, col)}</Text>
                <Text>▊</Text>
                <Text>{l.slice(col)}</Text>
              </>
            ) : (
              <Text>{l}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
