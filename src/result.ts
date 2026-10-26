export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; images?: string[] } };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** fail 增可选第三参 images（图片通道二）：CodedToolError 随行图片（dataURL）经 registry catch 透传进失败载荷，
 *  失败态亦可带图；条件展开保持「无图不落键」——既有两参调用方的失败载荷形态零变化 */
export function fail<T>(code: string, message: string, images?: string[]): Result<T> {
  return { ok: false, error: { code, message, ...(images !== undefined ? { images } : {}) } };
}
