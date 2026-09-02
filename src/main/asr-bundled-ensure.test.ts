import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paths = vi.hoisted(() => ({ resources: '', userData: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => paths.userData
  },
  net: { fetch: vi.fn() }
}))
vi.mock('./logger', () => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { net } from 'electron'
import { BUNDLE_GOT_LOGIN_HTML } from '@shared/bundle-response'
import {
  ASR_ASSETS_MISSING,
  PARAKEET_MODEL_NAME,
  PARAKEET_REQUIRED_FILES,
  WHISPER_FLOOR_ID,
  WHISPER_FLOOR_REQUIRED_FILES,
  ensureImportAsrAssets,
  importAsrAssetsReady,
  asrAssetsStatusSnapshot,
  parakeetFilesReady,
  parakeetUserDir,
  setAsrEnsureTestHooks,
  resetAsrEnsureStateForTests,
  whisperFloorReady
} from './asr-bundled-ensure'

describe('asr-bundled-ensure', () => {
  let originalResourcesPath: PropertyDescriptor | undefined

  beforeEach(() => {
    paths.resources = mkdtempSync(join(tmpdir(), 'metis-asr-res-'))
    paths.userData = mkdtempSync(join(tmpdir(), 'metis-asr-ud-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: paths.resources })
    setAsrEnsureTestHooks(null)
    resetAsrEnsureStateForTests()
  })

  afterEach(() => {
    setAsrEnsureTestHooks(null)
    rmSync(paths.resources, { recursive: true, force: true })
    rmSync(paths.userData, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
  })

  it('treats an empty resources dir as not ready and copies via the ensure hooks', async () => {
    expect(importAsrAssetsReady()).toBe(false)
    const progress: number[] = []
    setAsrEnsureTestHooks({
      fetchParakeet: async (dest, onProgress) => {
        mkdirSync(dest, { recursive: true })
        for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dest, name), 'p')
        onProgress?.(100)
      },
      fetchWhisperFloor: async (dest, onProgress) => {
        const dir = join(dest, ...WHISPER_FLOOR_ID.split('/'))
        for (const rel of WHISPER_FLOOR_REQUIRED_FILES) {
          const file = join(dir, rel)
          mkdirSync(join(file, '..'), { recursive: true })
          writeFileSync(file, 'w')
        }
        onProgress?.(100)
      }
    })
    await ensureImportAsrAssets((pct) => progress.push(pct))
    expect(parakeetFilesReady(join(paths.userData, 'asr-models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'))).toBe(
      true
    )
    expect(whisperFloorReady(join(paths.userData, 'asr-models'))).toBe(true)
    expect(importAsrAssetsReady()).toBe(true)
    expect(progress.some((n) => n > 0)).toBe(true)
    expect(ASR_ASSETS_MISSING).not.toMatch(/[Rr]einstall/)
    const snap = asrAssetsStatusSnapshot()
    expect(snap.ready).toBe(true)
    expect(snap.status).toBe('ready')
    expect(JSON.stringify(snap)).not.toMatch(/[Rr]einstall/)
  })

  it('status snapshot is not ready and never says reinstall when resources are empty', () => {
    const snap = asrAssetsStatusSnapshot()
    expect(snap.ready).toBe(false)
    expect(snap.status).not.toBe('ready')
    expect(JSON.stringify(snap)).not.toMatch(/[Rr]einstall/)
    expect(snap.label).toMatch(/transcription files/i)
  })

  it('does not treat Access login HTML on disk as a ready Parakeet bundle', () => {
    const dir = join(paths.userData, 'asr-models', PARAKEET_MODEL_NAME)
    mkdirSync(dir, { recursive: true })
    const html =
      '<!DOCTYPE html><html><body>Sign in · Cloudflare Access https://team.cloudflareaccess.com</body></html>'
    for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dir, name), html)
    expect(parakeetFilesReady(dir)).toBe(false)
    expect(importAsrAssetsReady()).toBe(false)
  })

  it('download of Access HTML fails loud and does not write a fake bundle', async () => {
    const html =
      '<!DOCTYPE html><html><head><title>Sign in</title></head><body>cloudflareaccess.com login</body></html>'
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8', 'content-length': String(html.length) }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(html))
          controller.close()
        }
      })
    } as unknown as Response)

    await expect(ensureImportAsrAssets()).rejects.toThrow(/login page|files/)
    const dest = join(parakeetUserDir(), 'encoder.int8.onnx')
    expect(parakeetFilesReady(parakeetUserDir())).toBe(false)
    const snap = asrAssetsStatusSnapshot()
    expect(snap.ready).toBe(false)
    expect(snap.status).toBe('error')
    expect(snap.error).toMatch(/login page|connection|files/)
    expect(snap.error).toBe(BUNDLE_GOT_LOGIN_HTML)
    expect(dest.endsWith('encoder.int8.onnx')).toBe(true)
  })
})
