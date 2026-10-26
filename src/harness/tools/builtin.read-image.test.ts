import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { builtinTools } from './builtin';
import { SafetyChain } from '../security/chain';
import { SecurityGuard } from '../security/guard';
import { ProcessSandbox } from '../security/sandbox';

/** 最小 PNG 字节(魔数+IHDR 占位——读取面只按扩展名分流,不解码;真实解码在视觉端点) */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

function setup(): { registry: ToolRegistry; safety: SafetyChain; root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-image-'));
  fs.writeFileSync(path.join(root, 'shot.png'), PNG_BYTES);
  fs.writeFileSync(path.join(root, 'photo.JPG'), PNG_BYTES); // 大写扩展名同判
  fs.writeFileSync(path.join(root, 'a.txt'), 'text');
  const registry = new ToolRegistry();
  const safety: SafetyChain = new SafetyChain(new SecurityGuard(), new ProcessSandbox(), root);
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { registry, safety, root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('read 图片文件：dataURL 随 ExecResult.images 下发,观察行报格式与体积不带 mojibake', async () => {
  const { registry, safety, cleanup } = setup();
  try {
    const r = await registry.execute('read', { path: 'shot.png' }, safety);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.images?.length, 1);
    assert.match(r.value.images![0]!, /^data:image\/png;base64,/);
    assert.ok(r.value.images![0]!.length > PNG_BYTES.length); // base64 膨胀后含原始字节
    assert.match(r.value.stdout, /^\[image\] shot\.png \(image\/png, \d+ KB\) — content attached as image/);
    assert.ok(!r.value.stdout.includes('mojibake'));
  } finally {
    cleanup();
  }
});

test('read 大写扩展名(.JPG)同判,jpeg MIME', async () => {
  const { registry, safety, cleanup } = setup();
  try {
    const r = await registry.execute('read', { path: 'photo.JPG' }, safety);
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(r.value.images![0]!, /^data:image\/jpeg;base64,/);
  } finally {
    cleanup();
  }
});

test('read 图片带 range：图片照返,观察行附 range ignored 提示', async () => {
  const { registry, safety, cleanup } = setup();
  try {
    const r = await registry.execute('read', { path: 'shot.png', range: 'L1-2' }, safety);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.images?.length, 1);
    assert.match(r.value.stdout, /range ignored for image files/);
  } finally {
    cleanup();
  }
});

test('read 超帽图片：不内联(无 images),文本指引裁剪', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-image-big-'));
  fs.writeFileSync(path.join(root, 'big.png'), Buffer.alloc(21 * 1024 * 1024, 1));
  const registry = new ToolRegistry();
  const safety: SafetyChain = new SafetyChain(new SecurityGuard(), new ProcessSandbox(), root);
  for (const t of builtinTools(safety, root)) registry.register(t);
  try {
    const r = await registry.execute('read', { path: 'big.png' }, safety);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.images, undefined);
    assert.match(r.value.stdout, /exceeds the 20 MB inline cap/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read 非图片文件不受影响(文本路径回归)', async () => {
  const { registry, safety, cleanup } = setup();
  try {
    const r = await registry.execute('read', { path: 'a.txt' }, safety);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.images, undefined);
    assert.ok(r.value.stdout.includes('text'));
  } finally {
    cleanup();
  }
});
