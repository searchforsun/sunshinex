#!/usr/bin/env node
/**
 * 图标生成器（单一几何来源）：纯 node（零依赖）程序化产出全部壳侧图标——
 *   1. shell/assets/icon.ico        多尺寸 PNG-in-ICO（256/64/32/16,electron-builder + 任务栏/资源管理器）
 *   2. shell/assets/logo-64.png     64px 光栅参考件（零运行时消费方,仅人工比对参考,勿当死资产删）
 *   3. shell/src/lib/product-logo.ts PRODUCT_LOGO_DATA_URL（64px,BrowserWindow 窗口图标）
 *   4. shell/src/lib/tray-icon.ts    TRAY_ICON_DATA_URL（32px,托盘——Windows 按 DPI 缩放,32 源比 16 原生平滑）
 *
 * 设计语言（2026-10-23 用户裁定三稿：mark 缩小「显示全」+ 托盘同新 logo）：
 *   - 画布满幅黑色圆角矩形 #0a0a0a（圆角 18%S,四角透明）；
 *   - 灰白 #e8e8e8 轨道环+核 mark,比例与欢迎页 hero SVG 同源（72 视窗取值：
 *     椭圆 rx19 ry11、描边 2.5、中心点 r4.5,整体 rotate -15°）——mark 横向占约 55%W,
 *     不再撑满画布（二稿 100%W 被裁是本次返工根因）；
 *   - ≤32px 小尺寸光学补偿:描边 ×1.6、核点 ×1.3（细环 16px 不可辨）;
 *   - 边缘 4x4 超采样定点抗锯齿（确定性,逐位可复现）。
 *
 * PNG 手写编码：签名/IHDR/IDAT/IEND;IDAT 载荷为 raw 扫描线（每行前置 filter byte 0）
 * 经 node:zlib deflateSync(level 9);CRC32 优先 zlib.crc32（Node>=20.15）,缺失回退自实现。
 * ICO 壳（Vista+ PNG-in-ICO）：ICONDIR + 逐帧 ICONDIRENTRY(planes 1/bitCount 32) + PNG 帧原样。
 *
 * 幂等：同输入重跑 byte-identical——逐产物「重生成内存比对 + 落盘回读比对」,通过打印 ok;不等 exit 1。
 *
 * 用法：node scripts/gen-shell-icon.mjs
 */
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ---------- 常量（设计口径单一来源） ----------
const BASE_RGB = [0x0a, 0x0a, 0x0a];   // #0a0a0a 黑圆角方(现行窗口图标实测色,与二稿一致)
const MARK_RGB = [0xe8, 0xe8, 0xe8];   // #e8e8e8 灰白轨道环+核
const CORNER = 0.18;                   // 圆角半径占比(18%S)
// 欢迎页 hero SVG 比例(72 视窗):椭圆 rx19 ry11 / 描边 2.5 / 核点 r4.5,rotate -15°
const ORBIT_RX = 19 / 72;
const ORBIT_RY = 11 / 72;
const STROKE = 2.5 / 72;
const CORE_R = 4.5 / 72;
const TILT = (15 * Math.PI) / 180;     // -15° 的逆变换角(点旋 +15° 入椭圆坐标系)
const COS_T = Math.cos(TILT);
const SIN_T = Math.sin(TILT);
const SS = 4;                          // 每轴子采样数(4x4=16 子样本/像素,确定性抗锯齿)

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
/** 点 (px,py) 是否在满幅圆角方内(圆角 CORNER·S)。 */
function inRoundRect(px, py, s) {
  const half = s / 2;
  const r = CORNER * s;
  const inner = half - r;
  const dx = Math.max(Math.abs(px - half) - inner, 0);
  const dy = Math.max(Math.abs(py - half) - inner, 0);
  return dx * dx + dy * dy <= r * r;
}

/** 点 (px,py) 对中心 (half,half) 的旋转归一坐标(逆 -15°:点旋 +TILT 入椭圆坐标系)。 */
function toLocal(px, py, s) {
  const dx = px - s / 2;
  const dy = py - s / 2;
  // y-down 屏系视觉逆时针 -15°:逆变换 = [[cos,-sin],[sin,cos]]·d
  return [dx * COS_T - dy * SIN_T, dx * SIN_T + dy * COS_T];
}

/** 点是否在轨道环内(外椭圆减内椭圆;±stroke/2)。 */
function inRing(lx, ly, rx, ry, halfStroke) {
  const qo = (lx / (rx + halfStroke)) ** 2 + (ly / (ry + halfStroke)) ** 2;
  if (qo > 1) return false;
  const ri = Math.max(rx - halfStroke, 0);
  const qi = (lx / ri) ** 2 + (ly / Math.max(ry - halfStroke, 0.01)) ** 2;
  return qi > 1;
}

/** 生成 size² RGBA 像素缓冲(非预乘直通 alpha)。smallBoost:≤32px 光学补偿。 */
function renderRgba(size, smallBoost) {
  const buf = Buffer.alloc(size * size * 4);
  const subs = [];
  for (let i = 0; i < SS; i++) subs.push((i + 0.5) / SS);
  const stroke = STROKE * (smallBoost ? 1.6 : 1) * size;
  const coreR = CORE_R * (smallBoost ? 1.3 : 1) * size;
  const rx = ORBIT_RX * size;
  const ry = ORBIT_RY * size;
  const hs = stroke / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rectCov = 0;
      let markCov = 0;
      for (const sy of subs) {
        for (const sx of subs) {
          const px = x + sx;
          const py = y + sy;
          if (!inRoundRect(px, py, size)) continue;
          rectCov++;
          const [lx, ly] = toLocal(px, py, size);
          const inCore = lx * lx + ly * ly <= coreR * coreR;
          if (inCore || inRing(lx, ly, rx, ry, hs)) markCov++;
        }
      }
      const cr = rectCov / (SS * SS);
      const mr = markCov / (SS * SS);
      const o = (y * size + x) * 4;
      // mark 整域落于方内:联合覆盖=方覆盖 × mark 覆盖
      buf[o] = Math.round(MARK_RGB[0] * mr + BASE_RGB[0] * (1 - mr));
      buf[o + 1] = Math.round(MARK_RGB[1] * mr + BASE_RGB[1] * (1 - mr));
      buf[o + 2] = Math.round(MARK_RGB[2] * mr + BASE_RGB[2] * (1 - mr));
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
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type 6 = RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 单尺寸图标 PNG(ico 帧/独立 PNG/data URL 共用)。 */
function renderPng(size) {
  return encodePng(renderRgba(size, size <= 32), size);
}

// ---------- ICO 壳（PNG-in-ICO 多帧，Vista+） ----------
const ICO_SIZES = [256, 64, 32, 16];

function buildIco() {
  const frames = ICO_SIZES.map((n) => ({ n, png: renderPng(n) }));
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((f, i) => {
    const e = 6 + 16 * i;
    header[e] = f.n >= 256 ? 0 : f.n;     // width(256 记 0)
    header[e + 1] = f.n >= 256 ? 0 : f.n; // height
    header.writeUInt16LE(1, e + 4);       // color planes
    header.writeUInt16LE(32, e + 6);      // bits per pixel
    header.writeUInt32LE(f.png.length, e + 8);  // bytesInRes
    header.writeUInt32LE(offset, e + 12);       // imageOffset
    offset += f.png.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.png)]);
}

// ---------- TS data URL 手术（只换 base64 载荷,注释/结构不动;同值零 diff 幂等放行） ----------
function replaceDataUrl(relPath, base64) {
  const abs = join(repoRoot, relPath);
  const src = readFileSync(abs, 'utf8');
  const expected = `'data:image/png;base64,${base64}'`;
  if (src.includes(expected)) return src; // 重跑快速路:载荷已在盘,零 diff
  const next = src.replace(/'data:image\/png;base64,[^']+'/, expected);
  if (next === src) throw new Error(`data URL anchor not found: ${relPath}`);
  writeFileSync(abs, next);
  return next;
}

// ---------- 主流程：生成→落盘→幂等自检 ----------
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(repoRoot, 'shell', 'assets');
mkdirSync(assetsDir, { recursive: true });

const ico = buildIco();
const icoPath = join(assetsDir, 'icon.ico');
writeFileSync(icoPath, ico);

const logo64 = renderPng(64);
writeFileSync(join(assetsDir, 'logo-64.png'), logo64);

replaceDataUrl('shell/src/lib/product-logo.ts', logo64.toString('base64'));
replaceDataUrl('shell/src/lib/tray-icon.ts', renderPng(32).toString('base64'));

// 幂等自检:ico 重生成内存比对 + 落盘回读比对;TS 面回读确认新载荷已在盘(重跑=零 diff 快速路)
const onDiskIco = readFileSync(icoPath);
if (Buffer.compare(ico, buildIco()) !== 0 || Buffer.compare(ico, onDiskIco) !== 0) {
  console.error('gen-shell-icon: idempotency self-check FAILED (ico)');
  process.exit(1);
}
if (!readFileSync(join(repoRoot, 'shell/src/lib/product-logo.ts'), 'utf8').includes(`base64,${logo64.toString('base64')}'`)) {
  console.error('gen-shell-icon: idempotency self-check FAILED (product-logo.ts)');
  process.exit(1);
}
if (!readFileSync(join(repoRoot, 'shell/src/lib/tray-icon.ts'), 'utf8').includes(`base64,${renderPng(32).toString('base64')}'`)) {
  console.error('gen-shell-icon: idempotency self-check FAILED (tray-icon.ts)');
  process.exit(1);
}

const sha256 = createHash('sha256').update(ico).digest('hex');
console.log(`ok icon.ico=${ico.length}B sha256=${sha256.slice(0, 12)} logo64=${logo64.length}B ts=product+tray updated`);
