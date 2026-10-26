import { Box, Text } from 'ink';
import { theme } from '../theme';
import { imageMarkers } from '../../images';

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
  attachments,
}: {
  buffer: string;
  placeholder: string;
  active: boolean;
  cursor?: number;
  /** 待发图片附件 chips（2026-10-26 图片功能，Ctrl+V 贴图）：[Image 1] [Image 2] … 置于输入行上侧 */
  attachments?: readonly string[];
}): JSX.Element {
  const pos = Math.min(Math.max(0, cursor), buffer.length);
  const chips = attachments !== undefined && attachments.length > 0 ? imageMarkers(attachments.length) : undefined;
  if (buffer.length === 0) {
    return (
      <Box borderStyle="round" borderColor={active ? 'cyan' : 'gray'} flexDirection="column" paddingX={1}>
        {chips !== undefined && <Text dimColor>{chips}</Text>}
        <Text>
          <Text color={theme.accent}>❯ </Text>
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
      {chips !== undefined && <Text dimColor>{chips}</Text>}
      {lines.map((l, i) => {
        const onCursor = active && i === lineIdx;
        return (
          <Text key={i}>
            {i === 0 ? <Text color={theme.accent}>❯ </Text> : <Text>{'  '}</Text>}
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
