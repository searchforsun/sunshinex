/**
 * 托盘图标（H2-T2）：内嵌 16x16 PNG 的 data URL——免二进制资产落地（单文件 bundle 友好，
 * esbuild 全内联无 external 资产面），主题青色同源；H3 打包面再换 .ico 多尺寸。
 *
 * 生成口径（100 字节，已程序内生成并逐像素校验）：
 *   - 16x16 RGBA（PNG colorType 6 / 8bit，deflate level 9）；
 *   - 中央 (7.5, 7.5) 半径 6.5 圆内像素 = #22d3ee 不透明（rgba 22 d3 ee ff）；
 *   - 圆外全透明（rgba 00 00 00 00）——透明底圆点。
 */
export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAK0lEQVR42mNgGJRA6fK7/9gw2RqJNogiA4jVjNOQUQOoYMDApwOqJOUBAQCjL2WIeXB6GAAAAABJRU5ErkJggg==';
