import { PROVIDERS, type ProviderId } from './providers'

/** Matches the desktop IPC bound. One image per explicit screen Ask; never a URL or attachment upload. */
export const OPERATOR_IMAGE_BASE64_CAP = 5_500_000
export const OPERATOR_VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct'
const IMAGE_EDGE_CAP = 8192
const IMAGE_PIXEL_CAP = 16_777_216

export type OperatorImage = { mimeType: 'image/png' | 'image/jpeg'; data: string }
type ImageResult = { ok: true; image: OperatorImage } | { ok: false; error: string }

/** The portal text catalogue includes text-only models. Never send a screenshot to one of those.
 * Unknown model overrides fail explicitly until their vision transport is verified. */
export function operatorVisionModel(provider: string, requestedModel: string): string | null {
  const model = requestedModel.trim()
  if (provider === 'cloudflare') return model.startsWith('workers-ai/') ? null : OPERATOR_VISION_MODEL
  if (!Object.hasOwn(PROVIDERS, provider)) return null
  if (['anthropic', 'openai', 'kimi', 'gemini'].includes(provider)) {
    return PROVIDERS[provider as ProviderId].models.includes(model) ? model : null
  }
  if (provider === 'grok') return model === 'grok-4' ? model : null
  if (provider === 'openrouter') {
    return ['openai/gpt-4o-mini', 'google/gemini-2.0-flash-001'].includes(model) ? model : null
  }
  return null
}

function uint16(bytes: string, offset: number): number {
  return bytes.charCodeAt(offset) * 256 + bytes.charCodeAt(offset + 1)
}

function uint32(bytes: string, offset: number): number {
  return uint16(bytes, offset) * 65_536 + uint16(bytes, offset + 2)
}

/** Read dimensions without decompressing untrusted pixels in the Electron main process or Worker. */
function dimensions(bytes: string, mimeType: OperatorImage['mimeType']): { width: number; height: number } | null {
  if (mimeType === 'image/png') {
    if (bytes.length < 45 || !bytes.startsWith('\x89PNG\r\n\x1a\n') || uint32(bytes, 8) !== 13 ||
      bytes.slice(12, 16) !== 'IHDR' || !bytes.endsWith('\0\0\0\0IEND\xaeB`\x82')) return null
    return { width: uint32(bytes, 16), height: uint32(bytes, 20) }
  }
  if (!bytes.startsWith('\xff\xd8\xff') || !bytes.endsWith('\xff\xd9')) return null
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes.charCodeAt(offset) !== 0xff) return null
    while (bytes.charCodeAt(offset) === 0xff) offset++
    const marker = bytes.charCodeAt(offset++)
    if (marker === 0xda || marker === 0xd9) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const length = uint16(bytes, offset)
    if (length < 2 || offset + length > bytes.length) return null
    if (frameMarkers.has(marker)) {
      return length < 8 ? null : { width: uint16(bytes, offset + 5), height: uint16(bytes, offset + 3) }
    }
    offset += length
  }
  return null
}

/** Server and desktop validation intentionally share the same byte/MIME/size contract. No image is
 * decoded into pixels, persisted, or sent to a file/URL fetcher here. The upstream codec validates it. */
export function parseOperatorImage(raw: unknown): ImageResult {
  const invalid = (): ImageResult => ({ ok: false, error: 'Screenshot must be a valid PNG or JPEG image. Capture it again.' })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid()
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some((key) => key !== 'mimeType' && key !== 'data')) return invalid()
  if ((value.mimeType !== 'image/png' && value.mimeType !== 'image/jpeg') || typeof value.data !== 'string') return invalid()
  if (value.data.length > OPERATOR_IMAGE_BASE64_CAP) {
    return { ok: false, error: 'Screenshot is too large. Capture a smaller region and try again.' }
  }
  if (!value.data || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return invalid()
  let bytes: string
  try { bytes = atob(value.data) } catch { return invalid() }
  const size = dimensions(bytes, value.mimeType)
  if (!size || !size.width || !size.height) return invalid()
  if (size.width > IMAGE_EDGE_CAP || size.height > IMAGE_EDGE_CAP || size.width * size.height > IMAGE_PIXEL_CAP) {
    return { ok: false, error: 'Screenshot resolution is too large. Capture a smaller region and try again.' }
  }
  return { ok: true, image: { mimeType: value.mimeType, data: value.data } }
}
