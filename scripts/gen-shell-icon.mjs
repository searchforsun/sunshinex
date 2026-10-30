#!/usr/bin/env node
/**
 * 图标生成器（单一几何来源）：纯 node（零依赖）程序化产出全部壳侧图标——
 *   1. shell/assets/icon.ico        多尺寸 PNG-in-ICO（256/64/32/16,electron-builder + 任务栏/资源管理器）
 *   2. shell/assets/logo-64.png     64px 光栅参考件（零运行时消费方,仅人工比对参考,勿当死资产删）
 *   3. shell/src/lib/product-logo.ts PRODUCT_LOGO_DATA_URL（64px,BrowserWindow 窗口图标）
 *   4. shell/src/lib/tray-icon.ts    TRAY_ICON_DATA_URL（32px,托盘——Windows 按 DPI 缩放,32 源比 16 原生平滑）
 *
 * 设计语言（2026-10-30 四稿:黑底白 mark + 四豁口弧环 + 放大 + 输入框同弧度）：
 *   - 画布满幅纯黑圆角方 #000000（圆角 20%S + superellipse(1.5) 超椭圆角形,四角透明）；
 *   - 灰白 #ffffff 四段弧轨道环（四豁口）+核 mark,比例与欢迎页 hero SVG 同源（72 视窗取值：
 *     椭圆 rx19 ry11、描边 2.5、中心点 r4.5,整体 rotate -15°;弧端参数角 ±32°/±58° 即四豁口）
 *     ——mark 横向占约 66%W（MARK_SCALE 1.25,2026-10-30「整体图标放大一些」）;改形须与
 *     gui/src/welcome/WelcomeComposer.tsx hero SVG 手工镜像同步（注释互指,生成面只认本脚本单源）；
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
const BASE_RGB = [0x00, 0x00, 0x00];   // #000000 纯黑圆角方(2026-10-30 用户裁定「黑底白色,对比度要高」)
const MARK_RGB = [0xff, 0xff, 0xff];   // #ffffff 纯白轨道环+核(对黑底最大对比度)
// 圆角(2026-10-30 三次裁定「弧度和主对话输入框弧度一致」):--radius-composer 22px 实测卡高
// ~110px(12+44+4+32+10)→占比 20%·S,且 .sx-composer 带 corner-shape:superellipse(1.5)——角形
// 同换超椭圆(隐式 n=3:|x/r|³+|y/r|³≤1,k=1 ↔ n=2 圆弧,k=0 ↔ n=1 斜切),原 15% 圆弧观感偏尖
const CORNER = 0.20;
const CORNER_N = 3;                    // superellipse 隐式指数(CSS superellipse(k) ↔ n=2k)
// 欢迎页 hero SVG 比例(72 视窗):椭圆 rx19 ry11 / 描边 2.5 / 核点 r4.5,rotate -15°;
// MARK_SCALE(2026-10-30 用户裁定「整体图标放大一些」):mark 整体等比放大(含描边,观感权重不变)
const MARK_SCALE = 1.25;               // 占宽 ~53%W → ~66%W
const ORBIT_RX = (19 / 72) * MARK_SCALE;
const ORBIT_RY = (11 / 72) * MARK_SCALE;
const STROKE = (2.5 / 72) * MARK_SCALE;
const CORE_R = (4.5 / 72) * MARK_SCALE;
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
/** 点 (px,py) 是否在满幅圆角方内。角区为 superellipse(CORNER_N):|dx/r|ⁿ+|dy/r|ⁿ≤1
 *  (n=3 与 .sx-composer corner-shape:superellipse(1.5) 同形;n=2 即传统圆弧 border-radius)。 */
function inRoundRect(px, py, s) {
  const half = s / 2;
  const r = CORNER * s;
  const inner = half - r;
  const dx = Math.max(Math.abs(px - half) - inner, 0);
  const dy = Math.max(Math.abs(py - half) - inner, 0);
  if (dx === 0 || dy === 0) return true; // 直边区(含中心带)
  return dx ** CORNER_N + dy ** CORNER_N <= r ** CORNER_N;
}

/** 点 (px,py) 对中心 (half,half) 的旋转归一坐标(逆 -15°:点旋 +TILT 入椭圆坐标系)。 */
function toLocal(px, py, s) {
  const dx = px - s / 2;
  const dy = py - s / 2;
  // y-down 屏系视觉逆时针 -15°:逆变换 = [[cos,-sin],[sin,cos]]·d
  return [dx * COS_T - dy * SIN_T, dx * SIN_T + dy * COS_T];
}

/** 点是否在轨道环内(外椭圆减内椭圆;±stroke/2)。环非连续——hero SVG 四段弧
 *  (M52.11 30.17 A19 11 … ×4)间四豁口:参数角 (32°,58°) 及其四象限对称位;
 *  端点常量即 SVG 路径端点(±16.11,∓5.83)/(±10.07,±9.33) 反解,豁口切全 stroke 深(butt 端同形)。
 *  MARK_SCALE 等比缩放下参数角不变,豁口角度全尺寸一致。 */
const ARC_T1 = Math.atan2(5.83 / 11, 16.11 / 19); // ≈32.0°(弧端参数角)
const ARC_T2 = Math.atan2(9.33 / 11, 10.07 / 19); // ≈58.0°
function inRing(lx, ly, rx, ry, halfStroke) {
  const qo = (lx / (rx + halfStroke)) ** 2 + (ly / (ry + halfStroke)) ** 2;
  if (qo > 1) return false;
  const ri = Math.max(rx - halfStroke, 0);
  const qi = (lx / ri) ** 2 + (ly / Math.max(ry - halfStroke, 0.01)) ** 2;
  if (qi <= 1) return false;
  // 四豁口参数区间:[t1,t2]∪[π−t2,π−t1]∪[π+t1,π+t2]∪[2π−t2,2π−t1]
  let t = Math.atan2(ly / ry, lx / rx);
  if (t < 0) t += Math.PI * 2;
  const p = Math.PI, d = 2 * Math.PI;
  if ((t > ARC_T1 && t < ARC_T2) || (t > p - ARC_T2 && t < p - ARC_T1) ||
      (t > p + ARC_T1 && t < p + ARC_T2) || (t > d - ARC_T2 && t < d - ARC_T1)) return false;
  return true;
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
