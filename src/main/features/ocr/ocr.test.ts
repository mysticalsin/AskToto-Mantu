import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWindowOcr, type OcrFeatureDeps } from './index'

const result = {
  image: { width: 640, height: 360 },
  coverage: 'VISIBLE_ONLY',
  untrustedContent: true,
  truncated: { lines: false, words: false },
  lines: [
    { id: 'line-1', text: 'Hello world', confidence: 0.99, box: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 } }
  ],
  words: [
    { text: 'Hello', confidence: null, box: { x: 0.1, y: 0.1, width: 0.18, height: 0.1 }, lineId: 'line-1' },
    { text: 'world', confidence: null, box: { x: 0.3, y: 0.1, width: 0.2, height: 0.1 }, lineId: 'line-1' }
  ]
}

function harness(activeToken: string | null = 'session-1') {
  const capture = vi.fn(async () => ({
    image: Buffer.from('image-bytes').toString('base64'),
    width: 640,
    height: 360,
    capturedAt: 123,
    targetWindowId: 'window:target'
  }))
  const kill = vi.fn()
  const recognize = vi.fn(() => ({ result: Promise.resolve(result), kill }))
  const deps: OcrFeatureDeps = {
    sessions: { activeToken: () => activeToken },
    capture: { capture },
    helper: { recognize }
  }
  return { deps, capture, recognize, kill }
}

describe('runWindowOcr', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('requires an active interaction-session token before capture or OCR can run', async () => {
    const h = harness(null)
    await expect(runWindowOcr({
      sessionToken: 'session-1',
      target: { kind: 'window', id: 'window:target' },
      deadlineMs: 1000
    }, h.deps)).resolves.toMatchObject({ status: 'UNAUTHORIZED' })
    expect(h.capture).not.toHaveBeenCalled()
    expect(h.recognize).not.toHaveBeenCalled()
  })

  it('keeps the captured image and OCR result in memory without writing profile or temp files', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'metis-ocr-profile-'))
    const temp = mkdtempSync(join(tmpdir(), 'metis-ocr-temp-'))
    try {
      const h = harness()
      await expect(runWindowOcr({
        sessionToken: 'session-1',
        target: { kind: 'window', id: 'window:target' },
        deadlineMs: 1000
      }, h.deps)).resolves.toMatchObject({ status: 'COMPLETE' })
      expect(readdirSync(profile)).toEqual([])
      expect(readdirSync(temp)).toEqual([])
    } finally {
      rmSync(profile, { recursive: true, force: true })
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('passes image bytes to the helper with English and French recognition requested', async () => {
    const h = harness()
    await runWindowOcr({
      sessionToken: 'session-1',
      target: { kind: 'window', id: 'window:target' },
      deadlineMs: 1000
    }, h.deps)
    expect(h.recognize).toHaveBeenCalledWith(Buffer.from('image-bytes'), { languages: ['en-US', 'fr-FR'] })
  })

  it('kills the helper and returns PARTIAL when the per-call deadline wins', async () => {
    vi.useFakeTimers()
    let resolveHelper!: (value: unknown) => void
    const helperResult = new Promise<unknown>((resolve) => {
      resolveHelper = resolve
    })
    const kill = vi.fn()
    const h = harness()
    h.deps.helper = { recognize: vi.fn(() => ({ result: helperResult, kill })) }

    const pending = runWindowOcr({
      sessionToken: 'session-1',
      target: { kind: 'window', id: 'window:target' },
      deadlineMs: 500
    }, h.deps)
    await vi.advanceTimersByTimeAsync(500)
    await expect(pending).resolves.toMatchObject({
      status: 'PARTIAL',
      gap: expect.stringMatching(/500 ms deadline/)
    })
    expect(kill).toHaveBeenCalledTimes(1)
    resolveHelper(result)
  })
})
