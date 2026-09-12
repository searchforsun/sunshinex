import * as React from 'react';
import { Box, Text } from 'ink';
import { BannerInfo } from '../banner-info';

/**
 * 启动横幅：单字形图标 + 单行标题 + 缩进提示行（对标 Claude Code 欢迎头）。
 * 不做多行 ASCII 拼版：拼版依赖逐字符列宽跨行一致，点阵/等宽字体下全角字形宽度不可控，
 * 一行错位整幅散架（旧版 ＼｜／ 射线图标的根因）；✻ 为单字形，行内自然流排，零对齐依赖。
 */
export function Banner({ info, columns }: { info: BannerInfo; columns: number }): JSX.Element {
  if (columns < 40) {
    return <Text color="yellow">✻ SunshineX TUI v{info.version} · /help</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="yellow">✻ </Text>
        <Text bold>SunshineX TUI v{info.version}</Text>
        <Text dimColor> · model {info.model}</Text>
      </Text>
      <Text dimColor>  /help 查看命令 · /plan 先规划后执行 · Tab 翻阅历史</Text>
    </Box>
  );
}
