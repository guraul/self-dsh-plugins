/**
 * Unit tests for the pure WeCom image helpers (Node 24 type stripping).
 * Run with `pnpm test`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  IMAGE_PLACEHOLDER_TEXT,
  detectImageMediaType,
  imageLimitMessage,
} from '../src/wecom-image.ts'

/** ASCII helper for text-based signatures (`GIF89a`, `RIFF`, `WEBP`). */
function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0))
}

/** Append a fake chunk marker so WebP/JPEG samples look like real files. */
function bytes(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat())
}

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0x00, 0x00, 0x00, 0x0d])
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], [0x00, 0x10, 0x4a, 0x46])
const GIF87A = bytes(ascii('GIF87a'), [0x01, 0x00])
const GIF89A = bytes(ascii('GIF89a'), [0x01, 0x00])
const WEBP = bytes(ascii('RIFF'), [0x24, 0x00, 0x00, 0x00], ascii('WEBP'), ascii('VP8 '))

/** Tag bytes with a misleading file name; the detector must look at content only. */
function withName(data: Uint8Array, name: string): Uint8Array {
  return Object.assign(Uint8Array.from(data), { name })
}

describe('detectImageMediaType', () => {
  it('recognises the four accepted formats', () => {
    assert.equal(detectImageMediaType(PNG), 'image/png')
    assert.equal(detectImageMediaType(JPEG), 'image/jpeg')
    assert.equal(detectImageMediaType(WEBP), 'image/webp')
    assert.equal(detectImageMediaType(GIF87A), 'image/gif')
    assert.equal(detectImageMediaType(GIF89A), 'image/gif')
  })

  it('trusts the magic number over a fake extension', () => {
    // PNG header carried under a `.bmp` name is still a PNG.
    assert.equal(detectImageMediaType(withName(PNG, 'photo.bmp')), 'image/png')
    // A real BMP is not on the accept list, whatever it is called.
    const bmp = bytes(ascii('BM'), [0x36, 0x00, 0x00, 0x00])
    assert.equal(detectImageMediaType(withName(bmp, 'photo.png')), undefined)
  })

  it('rejects empty and truncated input', () => {
    assert.equal(detectImageMediaType(new Uint8Array(0)), undefined)
    assert.equal(detectImageMediaType(Uint8Array.from(PNG.slice(0, 4))), undefined)
    assert.equal(detectImageMediaType(Uint8Array.from(JPEG.slice(0, 2))), undefined)
    assert.equal(detectImageMediaType(Uint8Array.from(WEBP.slice(0, 11))), undefined)
  })

  it('rejects other RIFF containers and near-miss signatures', () => {
    const wav = bytes(ascii('RIFF'), [0x24, 0x00, 0x00, 0x00], ascii('WAVE'))
    assert.equal(detectImageMediaType(wav), undefined)
    // `GIF9` is too short / not a signature match, and plain text is refused.
    assert.equal(detectImageMediaType(bytes(ascii('GIF9'))), undefined)
    assert.equal(detectImageMediaType(bytes(ascii('hello world!!'))), undefined)
  })
})

/**
 * The real `ATTACHMENT_ERROR_CODES` the bridge gives a dedicated sentence to.
 * Names are copied from `dsh-attachment`; inventing one here would make the
 * assertions pass while production silently falls back to the generic text.
 */
const MAPPED_ERROR_CODES = [
  'IMAGE_TOO_LARGE',
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
  'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE',
  'IMAGE_TYPE_MISMATCH',
] as const

const GENERIC_ERROR_TEXT = '图片处理失败，请重发一次'

describe('imageLimitMessage', () => {
  it('maps every quoted attachment error code to its own Chinese sentence', () => {
    const messages = MAPPED_ERROR_CODES.map((code) => imageLimitMessage({ code }))
    for (const [index, message] of messages.entries()) {
      assert.notEqual(message, GENERIC_ERROR_TEXT, `${MAPPED_ERROR_CODES[index]} must not be generic`)
      assert.match(message, /[\u4e00-\u9fff]/u, `${MAPPED_ERROR_CODES[index]} must be Chinese`)
    }
    // One code, one sentence: a shared string would mean a missed `case`.
    assert.equal(new Set(messages).size, MAPPED_ERROR_CODES.length)
  })

  it('spells out the limit behind each mapped code', () => {
    assert.match(imageLimitMessage({ code: 'IMAGE_TOO_LARGE' }), /20MB/u)
    assert.match(imageLimitMessage({ code: 'TOO_MANY_IMAGES' }), /数量/u)
    assert.match(imageLimitMessage({ code: 'IMAGES_TOO_LARGE' }), /总体积/u)
    assert.match(imageLimitMessage({ code: 'IMAGE_TOO_MANY_PIXELS' }), /像素/u)
    assert.match(imageLimitMessage({ code: 'IMAGE_DIMENSION_TOO_LARGE' }), /尺寸|宽高/u)
    assert.match(imageLimitMessage({ code: 'UNSUPPORTED_IMAGE_TYPE' }), /PNG\/JPEG/u)
    assert.match(imageLimitMessage({ code: 'INVALID_IMAGE' }), /无法解析/u)
    assert.match(imageLimitMessage({ code: 'IMAGE_TYPE_MISMATCH' }), /格式不一致/u)
  })

  it('falls back to the generic sentence for codes without a dedicated text', () => {
    // Real code, but deliberately left on the generic path.
    assert.equal(imageLimitMessage({ code: 'INVALID_IMAGE_BASE64' }), GENERIC_ERROR_TEXT)
    assert.equal(imageLimitMessage({ code: 'IMAGE_NOT_A_REAL_CODE' }), GENERIC_ERROR_TEXT)
  })

  it('no longer special-cases the retired code names', () => {
    // Regression: these were invented and never existed in `dsh-attachment`.
    assert.equal(imageLimitMessage({ code: 'IMAGE_TOO_MANY' }), GENERIC_ERROR_TEXT)
    assert.equal(imageLimitMessage({ code: 'IMAGE_UNSUPPORTED_TYPE' }), GENERIC_ERROR_TEXT)
  })

  it('does not read prototype members as codes', () => {
    assert.equal(imageLimitMessage({ code: 'constructor' }), GENERIC_ERROR_TEXT)
    assert.equal(imageLimitMessage({ code: 'toString' }), GENERIC_ERROR_TEXT)
    assert.equal(imageLimitMessage({ code: 42 }), GENERIC_ERROR_TEXT)
  })

  it('never throws on odd throwables', () => {
    for (const value of [null, undefined, 'boom', 0, Symbol('x'), () => {}, new Error('x')]) {
      const text = imageLimitMessage(value)
      assert.equal(typeof text, 'string')
      assert.ok(text.length > 0)
    }
    assert.equal(imageLimitMessage(new Error('x')), GENERIC_ERROR_TEXT)
  })
})

describe('IMAGE_PLACEHOLDER_TEXT', () => {
  it('is a non-empty Chinese placeholder mentioning the image', () => {
    assert.equal(typeof IMAGE_PLACEHOLDER_TEXT, 'string')
    assert.ok(IMAGE_PLACEHOLDER_TEXT.length > 0)
    assert.match(IMAGE_PLACEHOLDER_TEXT, /图片/u)
  })
})
