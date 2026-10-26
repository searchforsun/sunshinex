import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

/**
 * TUI 剪贴板图片读取（2026-10-26 图片功能；对标 Claude Code Ctrl+V 贴图）：
 * - win32：PowerShell `Get-Clipboard -Format Image` → PNG base64（System.Drawing 落 PNG 编码）
 * - darwin：osascript `clipboard as «class PNGf»`（hex 文本）→ 字节
 * - linux：wl-paste → xclip 逐级回退（Wayland/X11）
 * 读不到图（无图/命令缺失/超时）恒 undefined，不抛——交互面出「剪贴板中没有图片」提示即可。
 * run 接缝供测试注入（钉平台分支与产物，零真实剪贴板依赖）。
 */

const pExecFile = promisify(execFile);
/** 剪贴板命令墙钟上限（PowerShell 冷启动可到数秒） */
const CLIP_TIMEOUT_MS = 8_000;
/** 读盘图片上限（与 serve 面 MAX_IMAGE_CHARS≈6MB 二进制口径对齐，留 base64 余量前截断在源头） */
const FILE_MAX_BYTES = 6 * 1024 * 1024;

export type ClipStdout = string | Buffer;
export type ClipRunner = (file: string, args: string[], timeoutMs: number) => Promise<ClipStdout>;

const defaultRunner: ClipRunner = async (file, args, timeoutMs) => {
  // encoding:'buffer'：linux 面回退命令输出是 PNG 二进制，utf8 串会毁字节——decode 面自辨文本/字节
  const { stdout } = await pExecFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'buffer' });
  return stdout;
};

/** 扩展名 → dataURL mime（读取图片文件面） */
function mimeOfExt(ext: string): string | undefined {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return undefined;
}

/** 平台分支（导出供测试钉选路） */
export function clipboardPlan(platform: NodeJS.Platform = process.platform): Array<{ file: string; args: string[]; decode: (stdout: ClipStdout) => string | undefined }> {
  if (platform === 'win32') {
    return [
      {
        file: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; $i = Get-Clipboard -Format Image; if ($i) { $ms = New-Object System.IO.MemoryStream; $i.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }'],
        decode: (out) => {
          const b64 = out.toString().trim();
          return /^[A-Za-z0-9+/=]+$/.test(b64) && b64.length > 64 ? `data:image/png;base64,${b64}` : undefined;
        },
      },
    ];
  }
  if (platform === 'darwin') {
    return [
      {
        file: 'osascript',
        args: ['-e', 'set d to (the clipboard as «class PNGf»)'],
        decode: (out) => {
          const hex = out.toString().trim().replace(/^«data PNGf»/, '').replace(/»$/, '').replace(/\s+/g, '');
          return /^[0-9a-fA-F]+$/.test(hex) && hex.length > 128 ? `data:image/png;base64,${Buffer.from(hex, 'hex').toString('base64')}` : undefined;
        },
      },
    ];
  }
  // wl-paste 缺省目标/xclip 显式 -t image/png 均按 PNG 取（图片复制场景的事实形态）；三分支统一产完整 dataURL
  return [
    { file: 'wl-paste', args: [], decode: (out) => (out.length > 64 && !out.toString('latin1').includes('<error>') ? `data:image/png;base64,${toB64(out)}` : undefined) },
    { file: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], decode: (out) => (out.length > 64 ? `data:image/png;base64,${toB64(out)}` : undefined) },
  ];
}

/** stdout → base64（Buffer 直取字节；字符串按 latin1 字节保真往返） */
function toB64(out: ClipStdout): string {
  return typeof out === 'string' ? Buffer.from(out, 'latin1').toString('base64') : out.toString('base64');
}

/** 读系统剪贴板图片 → dataURL；无图/失败回 undefined（分支缺命令/无图/超时逐级回退） */
export async function readClipboardImage(run: ClipRunner = defaultRunner, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  for (const plan of clipboardPlan(platform)) {
    try {
      const out = await run(plan.file, plan.args, CLIP_TIMEOUT_MS);
      const durl = plan.decode(out);
      if (durl !== undefined) return durl;
    } catch {
      // 该分支缺命令/无图/超时——尝试下一分支（linux 双回退；win/mac 单分支即收口 undefined）
    }
  }
  return undefined;
}

/** 图片文件 → dataURL（终端粘贴文件路径面：Windows Terminal 对复制的图片文件粘贴的是路径文本）；
 *  非图片扩展/不存在/超限回 undefined */
export function imageFileToDataURL(path: string): string | undefined {
  const m = /\.(png|jpe?g|webp|gif)$/i.exec(path.trim());
  const mime = m !== null ? mimeOfExt(m[0]) : undefined;
  if (mime === undefined) return undefined;
  try {
    const buf = fs.readFileSync(path.trim());
    if (buf.length === 0 || buf.length > FILE_MAX_BYTES) return undefined;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** 粘贴文本是否为「现有图片文件路径」（可转换成附件）：接受带引号形态（Windows 复制文件粘贴带引号） */
export function imageFilePathFromPasteText(text: string): string | undefined {
  const t = text.trim().replace(/^["'「]+|["'」]+$/g, '').trim();
  if (t === '' || t.includes('\n')) return undefined;
  if (!/\.(png|jpe?g|webp|gif)$/i.test(t)) return undefined;
  return t;
}
