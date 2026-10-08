#!/usr/bin/env node
/**
 * H3-T1 应用图标生成器：纯 node（零依赖）程序化产出 shell/assets/icon.ico。
 *
 * 设计语言（与托盘 H2 PNG 同源：见 shell/src/lib/tray-icon.ts）：
 *   - 256x256 RGBA PNG 帧：暗底 #0d1117 圆角方（圆角 48px，满幅）+ 青色 #22d3ee
 *     实心圆点（中心，半径 72px）；边缘 4x4 超采样定点抗锯齿（确定性，逐位可复现）。
 *   - PNG 手写编码：签名/IHDR/IDAT/IEND；IDAT 载荷为 raw 扫描线（每行前置 filter
 *     byte 0）经 node:zlib deflateSync(level 9)；CRC32 优先 zlib.crc32（Node>=20.15），
 *     缺失时回退自实现查表——两者同为标准 CRC-32，产物逐字节一致。
 *   - ICO 壳（Vista+ PNG-in-ICO，electron-builder 认）：ICONDIR(reserved 0/type 1/
 *     count 1) + ICONDIRENTRY(256 尺寸字节记 0；planes 1/bitCount 32；bytesInRes=PNG
 *     长度；offset 22) + PNG 帧原样。
 *
 * 幂等：同输入重跑 byte-identical——脚本尾部自检（重生成内存比对 + 落盘回读比对），
 * 通过打印 ok；不等 exit 1。产物 <10KB。
 *
 * 用法：node scripts/gen-shell-icon.mjs
 */
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ---------- 常量（设计口径单一来源） ----------
const SIZE = 256;          // 画布边长（=ICO 单帧尺寸，256 时 entry 宽高字节记 0）
const CORNER_RADIUS = 48;  // 圆角方圆角半径 px
const DOT_RADIUS = 72;     // 青色圆点半径 px
const DOT_CENTER = SIZE / 2;
const BASE_RGB = [0x0d, 0x11, 0x17]; // #0d1117 暗底
const DOT_RGB = [0x22, 0xd3, 0xee];  // #22d3ee 青
const SS = 4;              // 每轴子采样数（4x4=16 子样本/像素，确定性抗锯齿）

// ---------- CRC32（回退实现；与 zlib.crc32 同表同结果） ----------
const crc32 = zlibCrc32 ?? (() => {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

// ---------- 像素生成（纯函数：同常量→同字节） ----------
/** 点 (x,y) 是否在圆角方内（满幅 0..SIZE、圆角 CORNER_RADIUS）。 */
function inRoundRect(px, py) {
  const half = SIZE / 2;
  const inner = half - CORNER_RADIUS; // 中心直角半边长
  const dx = Math.max(Math.abs(px - half) - inner, 0);
  const dy = Math.max(Math.abs(py - half) - inner, 0);
  return dx * dx + dy * dy <= CORNER_RADIUS * CORNER_RADIUS;
}

/** 点 (x,y) 是否在青色圆点内。 */
function inDot(px, py) {
  const dx = px - DOT_CENTER;
  const dy = py - DOT_CENTER;
  return dx * dx + dy * dy <= DOT_RADIUS * DOT_RADIUS;
}

/** 生成 RGBA 像素缓冲（非预乘直通 alpha）。 */
function renderRgba() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const subs = [];
  for (let i = 0; i < SS; i++) subs.push((i + 0.5) / SS);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let rectCov = 0; // 圆角方覆盖率（0..SS*SS）
      let dotCov = 0;  // 圆点覆盖率
      for (const sy of subs) {
        for (const sx of subs) {
          const px = x + sx;
          const py = y + sy;
          if (inRoundRect(px, py)) rectCov++;
          if (inDot(px, py)) dotCov++;
        }
      }
      const cr = rectCov / (SS * SS); // 圆点整域落于方内：联合覆盖=方覆盖
      const cd = dotCov / (SS * SS);
      const o = (y * SIZE + x) * 4;
      buf[o] = Math.round(DOT_RGB[0] * cd + BASE_RGB[0] * (1 - cd));
      buf[o + 1] = Math.round(DOT_RGB[1] * cd + BASE_RGB[1] * (1 - cd));
      buf[o + 2] = Math.round(DOT_RGB[2] * cd + BASE_RGB[2] * (1 - cd));
      buf[o + 3] = Math.round(cr * 255);
    }
  }
  return buf;
}

// ---------- PNG 手写编码 ----------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA → PNG（IHDR/IDAT[raw 扫描线：每行前置 filter byte 0]/IEND）。 */
function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);   // width
  ihdr.writeUInt32BE(SIZE, 4);   // height
  ihdr[8] = 8;                   // bit depth
  ihdr[9] = 6;                   // color type 6 = RGBA
  ihdr[10] = 0;                  // compression: deflate
  ihdr[11] = 0;                  // filter method
  ihdr[12] = 0;                  // interlace: none

  const stride = SIZE * 4;
  const raw = Buffer.alloc(SIZE * (stride + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0;   // filter byte: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 签名
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO 壳（PNG-in-ICO，Vista+） ----------
function buildIco() {
  const png = encodePng(renderRgba());
  const header = Buffer.alloc(22); // ICONDIR(6) + ICONDIRENTRY(16)
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: 1 = icon
  header.writeUInt16LE(1, 4);      // count: 1 帧
  header[6] = SIZE >= 256 ? 0 : SIZE; // width（256 记 0）
  header[7] = SIZE >= 256 ? 0 : SIZE; // height（256 记 0）
  header[8] = 0;                   // palette colors（无调色板）
  header[9] = 0;                   // reserved
  header.writeUInt16LE(1, 10);     // color planes
  header.writeUInt16LE(32, 12);    // bits per pixel
  header.writeUInt32LE(png.length, 14); // bytesInRes = PNG 长度
  header.writeUInt32LE(22, 18);    // imageOffset = 6+16
  return Buffer.concat([header, png]);
}

// ---------- 主流程：生成→落盘→幂等自检 ----------
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(repoRoot, 'shell', 'assets', 'icon.ico');

const ico = buildIco();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, ico);

const rebuilt = buildIco(); // 重生成（内存）——确定性自检
const onDisk = readFileSync(outPath); // 落盘回读——IO 自检
if (Buffer.compare(ico, rebuilt) !== 0 || Buffer.compare(ico, onDisk) !== 0) {
  console.error('gen-shell-icon: idempotency self-check FAILED');
  process.exit(1);
}

const sha256 = createHash('sha256').update(ico).digest('hex');
console.log(`ok ${outPath} (${ico.length} bytes, sha256 ${sha256})`);
