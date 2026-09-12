import * as React from 'react';
import { Box, Text } from 'ink';
import { BannerInfo } from '../banner-info';

/**
 * 启动横幅：图标 + 版本/模型 + 命令提示；窄终端（<40 列）降级为单行。
 * 图标只用全角字形（East Asian Wide，恒定 2 列）：U+2015 ―、U+2600 ☀ 属歧义宽度字符，
 * CJK/西文字体终端渲染宽度不一，是横幅错位的根因，勿改回半角空格拼版。
 */
export function Banner({ info, columns }: { info: BannerInfo; columns: number }): JSX.Element {
  if (columns < 40) {
    return <Text color="yellow">☀ SunshineX TUI v{info.version} · /help</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text color="yellow">　＼　｜　／</Text>
      <Text>
        <Text color="yellow">　－－＊－－　</Text>
        <Text bold>SunshineX TUI v{info.version}</Text>
        <Text dimColor> · model {info.model}</Text>
      </Text>
      <Text>
        <Text color="yellow">　／　｜　＼　</Text>
        <Text dimColor>/help 查看命令 · /plan 先规划后执行</Text>
      </Text>
    </Box>
  );
}
