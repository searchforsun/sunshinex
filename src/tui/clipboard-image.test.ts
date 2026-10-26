import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clipboardPlan, imageFilePathFromPasteText, imageFileToDataURL, readClipboardImage } from './clipboard-image';

/** TUI 剪贴板读图面（2026-10-26 图片功能）：平台选路（win/darwin/linux 回退序）、产物解码
 *  （base64/hex/二进制字节→dataURL）、无图/缺命令归一 undefined；文件路径粘贴识别与读盘转码。
 *  全部经注入 runner/临时文件钉死，零真实剪贴板依赖 */

// 字节级夹具（防中段 padding 截断：base64 解码遇 '=' 即停，文本夹具拼接会破 darwin hex 往返）
const PNG_BYTES = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64'), Buffer.alloc(80, 65)]);
const PNG_B64 = PNG_BYTES.toString('base64');

test('clipboardPlan：win32/darwin/linux 三平台选路与解码（base64 直拼/hex 转字节/二进制字节保真）', () => {
  const win = clipboardPlan('win32');
  assert.equal(win.length, 1);
  assert.equal(win[0]!.file, 'powershell');
  assert.deepEqual(win[0]!.decode(PNG_B64 + '\r\n'), `data:image/png;base64,${PNG_B64}`, 'PowerShell base64 直拼');
  assert.equal(win[0]!.decode(''), undefined, '空输出（无图）回 undefined');
  assert.equal(win[0]!.decode('short'), undefined, '过短输出非 base64 产物');

  const mac = clipboardPlan('darwin');
  assert.equal(mac[0]!.file, 'osascript');
  const hex = PNG_BYTES.toString('hex');
  const decoded = mac[0]!.decode(`«data PNGf»${hex}»\n`);
  assert.equal(decoded, `data:image/png;base64,${PNG_B64}`, 'osascript hex 文本转 PNG 字节');

  const linux = clipboardPlan('linux');
  assert.deepEqual(linux.map((l) => l.file), ['wl-paste', 'xclip'], 'Wayland→X11 回退序');
  // 三分支统一产完整 dataURL（readClipboardImage 直透）；linux 面按 PNG 形态拼前缀
  assert.equal(linux[0]!.decode(PNG_BYTES), `data:image/png;base64,${PNG_B64}`, '二进制 stdout 字节保真');
  assert.equal(linux[1]!.decode(PNG_BYTES), `data:image/png;base64,${PNG_B64}`, 'xclip 同形态');
});

test('readClipboardImage：命中即回 dataURL；分支失败逐级回退；全失败归一 undefined（不抛）', async () => {
  const durl = await readClipboardImage(async (file) => {
    assert.equal(file, 'powershell');
    return PNG_B64;
  }, 'win32');
  assert.equal(durl, `data:image/png;base64,${PNG_B64}`);

  // win32 首分支空输出 → 无下一分支 → undefined
  assert.equal(await readClipboardImage(async () => '', 'win32'), undefined);

  // linux：wl-paste 抛（未装）→ xclip 接管；readClipboardImage 拼上 dataURL 前缀
  const viaXclip = await readClipboardImage(async (file) => {
    if (file === 'wl-paste') throw new Error('ENOENT');
    return PNG_BYTES;
  }, 'linux');
  assert.equal(viaXclip, `data:image/png;base64,${PNG_B64}`);

  // linux：两分支都空 → undefined
  assert.equal(await readClipboardImage(async () => '', 'linux'), undefined);
});

test('imageFilePathFromPasteText：图片扩展路径识别（带引号/首尾空白），非图/含换行/空串拒绝', () => {
  assert.equal(imageFilePathFromPasteText('  "C:\\pic folder\\a.PNG" '), 'C:\\pic folder\\a.PNG');
  assert.equal(imageFilePathFromPasteText("'/tmp/x.jpeg'"), '/tmp/x.jpeg');
  assert.equal(imageFilePathFromPasteText('C:\\doc.txt'), undefined, '非图片扩展');
  assert.equal(imageFilePathFromPasteText('a.png\nb.png'), undefined, '多行非路径');
  assert.equal(imageFilePathFromPasteText(''), undefined);
});

test('imageFileToDataURL：临时图片文件按扩展转 dataURL；非图/缺失/目录回 undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-clip-'));
  try {
    const png = path.join(dir, 'shot.png');
    fs.writeFileSync(png, Buffer.from(PNG_B64, 'base64'));
    assert.equal(imageFileToDataURL(png), `data:image/png;base64,${PNG_B64}`);
    assert.equal(imageFileToDataURL(path.join(dir, 'nope.png')), undefined, '文件不存在');
    const txt = path.join(dir, 'a.txt');
    fs.writeFileSync(txt, 'x');
    assert.equal(imageFileToDataURL(txt), undefined, '非图片扩展');
    assert.equal(imageFileToDataURL(dir), undefined, '目录（无扩展）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
