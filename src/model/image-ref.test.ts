import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { imageRefToUrl, resolveImageRefs } from './image-ref';

// wire 边界图片引用回水(2026-10-31 images-cache 裁定配对件):地址→dataURL;dataURL/http/缺档原样

test('imageRefToUrl:本地图片地址读回 dataURL;dataURL/http/缺档/未知扩展原样', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-imgref-'));
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const abs = path.join(dir, 'images-cache', 'x.png');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, png);
    const ref = abs.split(path.sep).join('/');
    assert.equal(imageRefToUrl(ref), `data:image/png;base64,${png.toString('base64')}`);
    assert.equal(imageRefToUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    assert.equal(imageRefToUrl('https://x/y.png'), 'https://x/y.png');
    assert.equal(imageRefToUrl(path.join(dir, 'missing.png')), path.join(dir, 'missing.png'), '缺档原样(上游可诊)');
    assert.equal(imageRefToUrl('notes.txt'), 'notes.txt');
    const msgs = resolveImageRefs([
      { role: 'user', content: 'hi', images: [ref] },
      { role: 'user', content: 'plain' },
      { role: 'assistant', content: 'ok' },
    ] as never);
    assert.match((msgs[0] as { images: string[] }).images[0]!, /^data:image\/png;base64,/);
    assert.equal((msgs[1] as { images?: string[] }).images, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
