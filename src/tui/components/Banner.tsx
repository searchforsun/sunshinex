import { Box, Text } from 'ink';
import { BannerInfo } from '../banner-info';
import { theme } from '../theme';

/**
 * 启动横幅：单字形图标 + 单行标题 + 模型行（对标 Claude Code 欢迎头）。
 * 不做多行 ASCII 拼版：拼版依赖逐字符列宽跨行一致，点阵/等宽字体下全角字形宽度不可控，
 * 一行错位整幅散架（旧版 ＼｜／ 射线图标的根因）；✻ 为单字形，行内自然流排，零对齐依赖。
 * 快捷键提示行已退役（2026-10-02）：横幅在 Static 历史顶端、长会话滚出视口即死提示——
 * 由恒驻键提示条（KeyHints，输入框旁随状态切换）统一承载，一眼可见零查找。
 */
export function Banner({ info, columns }: { info: BannerInfo; columns: number }): JSX.Element {
  if (columns < 40) {
    return <Text color={theme.accent}>✻ SunshineX TUI v{info.version} · /help</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.accent}>✻ </Text>
        <Text bold>SunshineX TUI v{info.version}</Text>
        <Text dimColor> · model {info.model}</Text>
      </Text>
    </Box>
  );
}
