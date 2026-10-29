/**
 * Pure inbound-image helpers for the WeCom bridge: magic-number typing and
 * attachment-limit message mapping.
 *
 * Deliberately free of DSH / Cordis imports so `node --test` can run it with
 * type stripping alone: everything works on plain bytes and plain errors the
 * host plugin hands in.
 */

/**
 * Text sent to the Agent when an inbound image cannot be forwarded as an
 * attachment but should still be acknowledged (the model is asked to answer
 * with the image context it has).
 */
export const IMAGE_PLACEHOLDER_TEXT = '（用户发送了图片，请结合图片回答）'

/** Magic-number media types the bridge accepts. */
type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** PNG signature: `89 50 4E 47 0D 0A 1A 0A`. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** JPEG signature: `FF D8 FF` (every JFIF/EXIF variant starts this way). */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const

/** GIF signature: `GIF87a` / `GIF89a` share the first four bytes `GIF8`. */
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] as const

/** RIFF container prefix (`RIFF` + 4-byte little-endian size). */
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const

/** WebP form type at offset 8. */
const WEBP_FORM_TYPE = [0x57, 0x45, 0x42, 0x50] as const

/**
 * Whether `bytes` begins with `signature` at `offset`.
 * @param bytes - raw file bytes.
 * @param signature - expected byte values.
 * @param offset - first index to compare (default `0`).
 * @returns `true` when every signature byte matches.
 */
function matchesAt(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false
  }
  return true
}

/**
 * Type an image by its magic number, ignoring file names and extensions.
 *
 * WeCom hands the bridge raw decrypted bytes, so the declared extension is not
 * trustworthy (a `.bmp` name may carry PNG bytes, or nothing at all). Only the
 * four formats the Agent path accepts are recognised; anything else — including
 * truncated or empty input — yields `undefined` so the caller can reply with a
 * friendly "unsupported" message instead of forwarding garbage.
 * @param bytes - raw image bytes (first 12 bytes are enough, more is fine).
 * @returns the media type, or `undefined` when the signature is unknown.
 */
export function detectImageMediaType(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (matchesAt(bytes, PNG_SIGNATURE)) return 'image/png'
  if (matchesAt(bytes, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAt(bytes, GIF_SIGNATURE)) return 'image/gif'
  if (matchesAt(bytes, RIFF_SIGNATURE) && matchesAt(bytes, WEBP_FORM_TYPE, 8)) return 'image/webp'
  return undefined
}

/** Reply when an attachment error carries no code we recognise. */
const GENERIC_IMAGE_ERROR_TEXT = '图片处理失败，请重发一次'

/**
 * Chinese replies keyed by `dsh-attachment`'s `ATTACHMENT_ERROR_CODES`.
 *
 * Only the codes the bridge can actually receive are listed; the remaining
 * codes (`INVALID_IMAGE_BASE64`) and any future code fall through to
 * {@link GENERIC_IMAGE_ERROR_TEXT}. Keys must match the real enum — inventing
 * names here silently degrades every failure to the generic sentence.
 */
const IMAGE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  IMAGE_TOO_LARGE: '单张图片太大（上限 20MB），请压缩后再发',
  TOO_MANY_IMAGES: '图片数量超出上限，请减少后重发',
  IMAGES_TOO_LARGE: '图片总体积超出上限，请减少数量或压缩后重发',
  IMAGE_TOO_MANY_PIXELS: '图片像素总量过高（上限 6400 万像素），请缩小后再发',
  IMAGE_DIMENSION_TOO_LARGE: '图片宽高超出上限，请缩小尺寸后再发',
  UNSUPPORTED_IMAGE_TYPE: '不支持该图片格式，请转成 PNG/JPEG/GIF/WebP',
  INVALID_IMAGE: '图片文件无法解析，请重发或换一张',
  IMAGE_TYPE_MISMATCH: '图片内容与声明格式不一致，请重发或换一张',
}

/**
 * Map an `AttachmentError` (or any thrown value) onto a Chinese reply.
 *
 * Reads `error.code` defensively: unknown codes, non-string codes, `null` and
 * non-object throwables all fall back to a generic sentence, and nothing here
 * throws — the inbound handler can call this inside its own `catch` without a
 * second failure path.
 * @param error - anything caught from `ctx.attachments.saveImage()`.
 * @returns one Chinese sentence safe to send back to the chat.
 */
export function imageLimitMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return GENERIC_IMAGE_ERROR_TEXT
  const code: unknown = (error as { code?: unknown }).code
  if (typeof code !== 'string') return GENERIC_IMAGE_ERROR_TEXT
  // Own-property lookup only: `code: 'constructor'` / `'toString'` must not
  // surface prototype members as messages.
  if (!Object.hasOwn(IMAGE_ERROR_MESSAGES, code)) return GENERIC_IMAGE_ERROR_TEXT
  return IMAGE_ERROR_MESSAGES[code]
}
