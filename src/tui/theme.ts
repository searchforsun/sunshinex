/**
 * TUI 主题色单点（2026-09-27 统一设计语言裁决）：全部组件的颜色一律从此处取语义 token，
 * 组件内禁止硬编码色名——语义（主色/成功/警告/错误）与具体色值解耦，换主题只改本文件。
 *
 * 语义口径：
 * - accent  主色：活动行、子代理面板边框与标题、输入提示、工具名高亮、Banner 等品牌与交互主色；
 * - success 成功语义：✓ 完成态、工具结果 ok；
 * - warn    警告语义：系统 warn 消息；
 * - error   错误语义：✗ 失败态、系统 error 消息；
 * - dim/dimColor 继续承载中性弱化（非彩色语义），不在本表内。
 */
export const theme = {
  accent: 'cyan',
  success: 'green',
  warn: 'yellow',
  error: 'red',
} as const;

