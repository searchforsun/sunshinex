/**
 * 图片附件 GUI 装载面(2026-10-26 图片功能):文件→dataURL 装载——GUI 唯一转码点:小文件原样读
 * (保 GIF 动画/PNG 透明),大文件 canvas 降采样(长边 1568px/JPEG q0.85,vision 端点友好体积)。
 * dataURL 形态自此原样贯穿(HTTP images 字段→转录条目→链行→wire image_url 块,daemon 侧零转码)。
 * 常量与追加钳制(MAX_IMAGES/appendImages/IMAGE_MAX_EDGE/IMAGE_JPEG_QUALITY)单源在主仓 src/images.ts
 * (serve/TUI/GUI 装载面与插件 server 生产者同规范),此处再导出/别名保既有导入面(`../images` 消费方零改动)。
 */
export { MAX_IMAGES, appendImages } from '../../src/images';
import { IMAGE_JPEG_QUALITY as JPEG_QUALITY, IMAGE_MAX_EDGE as DOWNSCALE_EDGE } from '../../src/images';

/** 附件文件选择器的接受类型(与 daemon 校验白名单同面) */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif';

/** 小文件直读阈值:≤1.5MB 原样 dataURL(不转码,保真);超出走降采样 */
const DIRECT_MAX_BYTES = 1_500_000;
// 降采样长边(vision 端点惯例 ≤1568px)与 JPEG 质量自主仓单源导入(上方别名导入,消费方零改动)

/** 单文件 → dataURL;非图片/解码失败回 undefined(调用方跳过)。convert 形参供测试注入 */
export async function fileToImageDataURL(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/')) return undefined;
  if (file.size <= DIRECT_MAX_BYTES) {
    return await new Promise<string | undefined>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' && fr.result.startsWith('data:image/') ? fr.result : undefined);
      fr.onerror = () => resolve(undefined);
      fr.readAsDataURL(file);
    });
  }
  // 大文件:ImageBitmap 解码 → canvas 等比缩到长边 1568 → JPEG。GIF 超限也走此路(动画让位体积——
  // 超大 GIF 直读会击穿 HTTP 载荷上限);解码失败(损坏文件)跳过
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, DOWNSCALE_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return undefined;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch {
    return undefined;
  }
}

/** 文件批 → dataURL 列(顺序保真;非图片/失败项跳过) */
export async function loadImages(files: File[], convert: (f: File) => Promise<string | undefined> = fileToImageDataURL): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const durl = await convert(f);
    if (durl !== undefined) out.push(durl);
  }
  return out;
}
