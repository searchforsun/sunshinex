import { test, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Files } from './Files';
import type { Connection } from '../connection';
import type { FileResp } from '../connection-types';

/** 2026-10-26 侧栏预览:图片扩展名(type=image 载荷)→ dataURL 直显替代源码视图;
 *  复制/换行/md 预览钮对图片无意义全部让位;文本文件回归源码视图。 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='; // PNG 魔数前缀的占位 base64

function connOf(resp: FileResp): Connection {
  return { readFile: () => Promise.resolve(resp) } as unknown as Connection;
}

test('Files 图片文件:dataURL 直显(居中+棋盘格垫底),复制/换行钮让位', async () => {
  render(<Files conn={connOf({ path: 'C:/w/shot.png', type: 'image', content: '', mime: 'image/png', data: PNG_B64 })} sessionId="s1" initialPath="shot.png" />);
  await waitFor(() => expect(document.querySelector('[aria-label="file content"] img')).not.toBeNull());
  const img = document.querySelector('[aria-label="file content"] img') as HTMLImageElement;
  expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG_B64}`);
  expect(img.style.objectFit).toBe('contain'); // 适配视口(棋盘格垫底为视觉面,jsdom cssstyle 不解析 conic-gradient,实机目验)
  // 图片面对复制/换行钮无意义:动作区不渲染这两枚(md 预览钮本就 isMd 才出)
  expect(screen.queryByLabelText('copy content')).toBeNull();
  expect(screen.queryByLabelText(/toggle word wrap|overflow scroll/)).toBeNull();
});

test('Files 文本文件:回归源码视图,复制钮在场', async () => {
  render(<Files conn={connOf({ path: 'C:/w/hello.ts', type: 'file', content: 'const x = 1;\n' })} sessionId="s1" initialPath="hello.ts" />);
  await waitFor(() => expect(screen.queryByLabelText('copy content')).not.toBeNull());
  expect(document.querySelector('.files-md img')).toBeNull();
});
