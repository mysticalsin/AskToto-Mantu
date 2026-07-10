import { describe, it, expect, vi } from 'vitest'
import { Blob } from 'node:buffer'
import { attachScreenshot } from './dust-attachments'

// A 1x1 JPEG is unnecessary — attachScreenshot only base64-decodes and forwards bytes; any non-empty
// base64 exercises the path. "aGVsbG8=" = "hello".
const IMG = 'aGVsbG8='

describe('attachScreenshot', () => {
  it('uploads the screenshot and returns a fileId content fragment', async () => {
    const upload = vi.fn().mockResolvedValue({ id: 'fil_abc123' })
    const api = { files: { upload } }
    const r = await attachScreenshot(api, IMG)
    expect(r).toEqual({ ok: true, contentFragment: { title: 'Screenshot', fileId: 'fil_abc123' } })
    expect(upload).toHaveBeenCalledTimes(1)
    const arg = upload.mock.calls[0][0]
    expect(arg).toBeInstanceOf(Blob) // File extends Blob
    expect(arg.type).toBe('image/jpeg')
    expect(arg.size).toBeGreaterThan(0)
  })

  it('returns ok:false (never throws) when the upload rejects — caller routes it through failover', async () => {
    const api = { files: { upload: vi.fn().mockRejectedValue(new Error('unexpected_network_error')) } }
    const r = await attachScreenshot(api, IMG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(String((r.error as Error).message)).toMatch(/network/)
  })

  it('returns ok:false when the upload yields no id', async () => {
    const api = { files: { upload: vi.fn().mockResolvedValue({}) } }
    const r = await attachScreenshot(api, IMG)
    expect(r.ok).toBe(false)
  })

  it('returns ok:false on an empty payload without calling upload', async () => {
    const upload = vi.fn()
    const r = await attachScreenshot({ files: { upload } }, '')
    expect(r.ok).toBe(false)
    expect(upload).not.toHaveBeenCalled()
  })
})
