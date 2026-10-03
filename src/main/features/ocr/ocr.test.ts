import { afterEach, describe, expect, it, vi } from 'vitest'
import { app, desktopCapturer } from 'electron'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OcrResult } from '@shared/contracts/ocr'
import { extractScreenOcrWords } from '../../mac-helper'
import { runWindowOcr, type OcrFeatureDeps } from './index'
import { runInteractionWindowOcr } from './electron'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn() },
  desktopCapturer: { getSources: vi.fn() }
}))

vi.mock('../../mac-helper', () => ({
  extractScreenOcrWords: vi.fn()
}))

const result: OcrResult = {
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
    vi.restoreAllMocks()
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
    const previousTmpdir = process.env.TMPDIR
    try {
      process.env.TMPDIR = temp
      vi.mocked(app.getPath).mockImplementation((name: string) => {
        if (name === 'userData') return profile
        if (name === 'temp') return temp
        return join(profile, name)
      })
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([{
        id: 'window:target',
        thumbnail: {
          getSize: () => ({ width: 640, height: 360 }),
          toPNG: () => Buffer.from('image-bytes')
        }
      }] as never)
      vi.mocked(extractScreenOcrWords).mockReturnValue({
        result: Promise.resolve(result),
        kill: vi.fn()
      })

      await expect(runInteractionWindowOcr({
        sessionToken: 'session-1',
        target: { kind: 'window', id: 'window:target' },
        deadlineMs: 1000
      }, { activeToken: () => 'session-1' }, 'darwin')).resolves.toMatchObject({ status: 'COMPLETE' })
      expect(listFiles(profile)).toEqual([])
      expect(listFiles(temp)).toEqual([])
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
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

  it('returns PARTIAL instead of throwing when capture fails', async () => {
    const h = harness()
    h.deps.capture = { capture: vi.fn(async () => { throw new Error('capture unavailable') }) }
    await expect(runWindowOcr({
      sessionToken: 'session-1',
      target: { kind: 'window', id: 'window:target' },
      deadlineMs: 1000
    }, h.deps)).resolves.toMatchObject({ status: 'PARTIAL', gap: 'capture unavailable' })
    expect(h.recognize).not.toHaveBeenCalled()
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

function listFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFiles(full).map((child) => join(entry.name, child)))
    } else {
      files.push(entry.name)
    }
  }
  return files.sort()
}
