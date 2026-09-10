import * as React from 'react';
import { Box, Text } from 'ink';
import { BannerInfo } from '../banner-info';

/** 启动横幅：图标 + 版本/模型 + 命令提示；窄终端（<40 列）降级为单行 */
export function Banner({ info, columns }: { info: BannerInfo; columns: number }): JSX.Element {
  if (columns < 40) {
    return <Text color="yellow">☀ SunshineX TUI v{info.version} · /help</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text color="yellow">   ＼ ｜ ／</Text>
      <Text>
        <Text color="yellow">  ―― ☀ ――   </Text>
        <Text bold>SunshineX TUI v{info.version}</Text>
        <Text dimColor> · model {info.model}</Text>
      </Text>
      <Text>
        <Text color="yellow">   ／ ｜ ＼  </Text>
        <Text dimColor>/help 查看命令 · /plan 先规划后执行</Text>
      </Text>
    </Box>
  );
}
