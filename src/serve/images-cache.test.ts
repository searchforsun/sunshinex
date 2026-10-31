import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spillImages } from './images-cache';
import { resolveDataDir } from '../config/data-dir';

// 图片落盘单点(2026-10-31 用户裁定「底层存储不要 base64,图片暂存 images-cache,上下文引用文件地址」)

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('spillImages:dataURL 落盘 images-cache,返回相对路径引用;同图重发内容寻址零重复', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-imgcache-'));
  try {
    const url = `data:image/png;base64,${PNG.toString('base64')}`;
    const r1 = spillImages(root, [url]);
    assert.ok(r1);
    assert.equal(r1.length, 1);
    assert.match(r1[0]!, /.\/images-cache\/\d{8}T\d{6}Z-[0-9a-f]{12}\.png$/, '引用=数据目录下 images-cache 绝对地址');
    const abs = r1[0]!;
    assert.ok(fs.existsSync(abs), '引用地址即真实落盘位置(resolveDataDir/<root>/data/images-cache)');
    const dataDir = resolveDataDir(root).replaceAll('\\', '/');
    assert.ok(abs.startsWith(dataDir), '落盘在项目数据目录下(不进工作区)');
    assert.ok(!abs.startsWith(root.replaceAll('\\', '/')), '工作区根零图片物');
    assert.deepEqual(fs.readFileSync(abs), PNG, '落盘字节=原图');
    // 同图重发:hash 命中已存在文件,不再写新文件(目录可能含他用例共享物,对位快照差分断言)
    const before = fs.readdirSync(path.join(resolveDataDir(root), 'images-cache'));
    const r2 = spillImages(root, [url]);
    assert.equal(r2![0], r1[0]);
    const after = fs.readdirSync(path.join(resolveDataDir(root), 'images-cache'));
    assert.deepEqual(after, before, '同图重发零新增文件(内容寻址命中)');
    // 非图片附件混排:dataURL 落盘,路径串透传,undefined/空列 undefined
    const r3 = spillImages(root, ['images-cache/existing.png', url]);
    assert.deepEqual(r3, ['images-cache/existing.png', r1[0]], '既有引用串透传');
    assert.equal(spillImages(root), undefined);
    assert.equal(spillImages(root, []), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spillImages:坏形态退回不丢图——非 data:image/ 与不认识的 mime 透传原样', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-imgcache-bad-'));
  try {
    const weird = 'data:image/heic;base64,AAAA';
    const r = spillImages(root, [weird, 'data:text/plain;base64,SGk=']);
    assert.deepEqual(r, [weird, 'data:text/plain;base64,SGk='], '不认识的 mime/非图片 dataURL 原样透传');
    assert.ok(!fs.existsSync(path.join(root, 'images-cache')), '无落盘物');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
