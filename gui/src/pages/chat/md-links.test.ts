import { describe, expect, it } from 'vitest';
import { safeDecodeHref } from './md-render';

/** 百分号编码还原(2026-10-27 中文渲染修复):CommonMark 归一后非 ASCII href 直出编码串——
 *  按段安全解码;非法序列(字面量 %)原样保留 */
describe('safeDecodeHref', () => {
  it('解码中文文件名的 percent-encoded 段', () => {
    expect(safeDecodeHref('%E5%90%AF%E5%8A%A8%E4%BA%94%E5%AD%90%E6%A3%8B.bat')).toBe('启动五子棋.bat');
  });

  it('多段路径逐段解码、分隔符保留', () => {
    expect(safeDecodeHref('games/%E4%BA%94%E5%AD%90%E6%A3%8B/%E4%B8%BB%E9%A1%B5.html')).toBe('games/五子棋/主页.html');
    expect(safeDecodeHref('C:\\docs\\%E6%8A%A5%E5%91%8A.docx')).toBe('C:\\docs\\报告.docx');
  });

  it('字面量 %(非法序列)原样保留不抛', () => {
    expect(safeDecodeHref('100%胜率.txt')).toBe('100%胜率.txt');
    // decodeURIComponent 整段 all-or-nothing:%E5%90%AF 合法但 %ZZ 非法→整段回退原文
    expect(safeDecodeHref('%E5%90%AF%ZZ.bat')).toBe('%E5%90%AF%ZZ.bat');
  });

  it('无编码内容原样直通', () => {
    expect(safeDecodeHref('plain.bat')).toBe('plain.bat');
    expect(safeDecodeHref('')).toBe('');
  });
});
