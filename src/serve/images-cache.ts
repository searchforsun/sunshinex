import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { utcCompactStamp } from '../idstamp';

/**
 * 图片落盘点(2026-10-31 用户裁定「底层存储不要 base64,太占上下文——图片暂存项目目录
 * images-cache 文件夹,上下文引用文件地址」):dataURL → 落盘 `<root>/images-cache/<时间戳>-<hash>.<ext>`,
 * 返回相对路径引用串。覆盖面=Session 两个图片入口(submit 用户附件/steer 插话附件)——下游
 * (kernel.submit 转录条、appendInstructionLine 上下文、chain 行、journal、wire、GUI 回显)
 * 从此只见路径串,base64 不再进档不进上下文;模型要看法可经 read 工具按路径读原文件。
 *
 * - 内容寻址:sha256 前 12 位做文件名段——同图重发零重复存储(已存在即跳过写)。
 * - 尽力落盘:单图写失败保留原 dataURL(图片不丢,只是该张退回旧形态),不炸提交。
 * - 非 data:image/ 串原样透传(已是路径引用/未知形态不篡改)。
 */

const EXT_OF_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

/** 单图 dataURL 解析(mime+Buffer);非 data:image/ 或解不出 Buffer 回 undefined */
function parseDataUrl(s: string): { mime: string; ext: string; buf: Buffer } | undefined {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (m === null) return undefined;
  const mime = m[1]!.toLowerCase();
  const ext = EXT_OF_MIME[mime];
  if (ext === undefined) return undefined;
  let buf: Buffer;
  try {
    buf = Buffer.from(m[2]!, 'base64');
  } catch {
    return undefined;
  }
  if (buf.length === 0) return undefined;
  return { mime, ext, buf };
}

/** 图片附件落盘单点(见文件头裁定):dataURL 数组 → images-cache 相对路径数组(原序;尽力而为) */
export function spillImages(root: string, images?: string[]): string[] | undefined {
  if (images === undefined || images.length === 0) return undefined;
  const dir = path.join(root, 'images-cache');
  const out: string[] = [];
  for (const img of images) {
    if (typeof img !== 'string' || img === '') continue;
    const parsed = parseDataUrl(img);
    if (parsed === undefined) {
      out.push(img); // 已是路径引用/未知形态:透传
      continue;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const hash = createHash('sha256').update(parsed.buf).digest('hex').slice(0, 12);
      // 引用串恒正斜杠（journal/上下文/GUI 解析键的规范形态；Windows path.join 会产反斜杠）
      const rel = `images-cache/${utcCompactStamp()}-${hash}.${parsed.ext}`;
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) fs.writeFileSync(abs, parsed.buf);
      out.push(rel);
    } catch {
      out.push(img); // 落盘失败退回 dataURL:图片不丢
    }
  }
  return out.length > 0 ? out : undefined;
}
