/** Claude API 接受的图片类型。 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * 按文件头魔数识别图片类型。飞书图片可能是 JPEG/PNG/GIF/WebP，
 * 统一标成 image/png 会被 API 以 "media type mismatch" 拒绝。
 * 无法识别时返回 undefined。
 */
export function detectImageMime(buf: Uint8Array): ImageMediaType | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

const DATA_URI_RE = /^data:(image\/[\w.+-]+);base64,/;

/** 拆解 data URI，返回 media type 与 base64 数据；没有前缀时按 PNG 处理。 */
export function parseImageDataUri(uri: string): { mediaType: string; data: string } {
  const m = DATA_URI_RE.exec(uri);
  if (!m) return { mediaType: "image/png", data: uri };
  return { mediaType: m[1]!, data: uri.slice(m[0].length) };
}
