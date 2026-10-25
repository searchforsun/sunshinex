import { describe, it, expect } from 'vitest';
import { appendImages, fileToImageDataURL, loadImages, MAX_IMAGES } from './images';

/** 图片附件工具(2026-10-26):≤8 张钳制(溢出计数供提示)、装载面跳过非图片/失败项、顺序保真 */

describe('appendImages 钳制', () => {
  it('未超限:原样合并', () => {
    const r = appendImages(['a', 'b'], ['c']);
    expect(r.images).toEqual(['a', 'b', 'c']);
    expect(r.overflow).toBe(0);
  });
  it(`超限:截断到 ${MAX_IMAGES} 张并报溢出数`, () => {
    const cur = ['1', '2', '3', '4', '5', '6'];
    const r = appendImages(cur, ['7', '8', '9']);
    expect(r.images).toHaveLength(MAX_IMAGES);
    expect(r.images[7]).toBe('8');
    expect(r.overflow).toBe(1);
  });
  it('空追加:原列表原样返回', () => {
    const r = appendImages(['a'], []);
    expect(r.images).toEqual(['a']);
    expect(r.overflow).toBe(0);
  });
});

describe('loadImages 装载面', () => {
  it('跳过转换失败项,顺序保真(过滤归 convert——注入面)', async () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const txt = new File(['y'], 'b.txt', { type: 'text/plain' });
    const out = await loadImages([png, txt], async (f) => (f.type.startsWith('image/') ? `data:${f.name}` : undefined));
    expect(out).toEqual(['data:a.png']);
  });
  it('fileToImageDataURL:非图片类型 undefined(过滤单点)', async () => {
    const txt = new File(['y'], 'b.txt', { type: 'text/plain' });
    expect(await fileToImageDataURL(txt)).toBeUndefined();
  });
  it('FileReader 直读路径(jsdom):小图片文件 → data:image dataURL', async () => {
    const png = new File(['hello'], 'a.png', { type: 'image/png' });
    const out = await loadImages([png]);
    expect(out).toHaveLength(1);
    expect(out[0]!.startsWith('data:image/png;base64,')).toBe(true);
  });
});
