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
  PARAKEET_ARCHIVE_SHA256,
  PARAKEET_MODEL_NAME,
  PARAKEET_REQUIRED_FILES,
  WHISPER_FLOOR_FILE_PINS,
  WHISPER_FLOOR_ID,
  WHISPER_FLOOR_REQUIRED_FILES,
  WHISPER_FLOOR_REVISION,
  assertPinnedFile,
  ensureImportAsrAssets,
  fetchBundleResponse,
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

  it('follows a https CDN hop and refuses an Access 302', async () => {
    const ok = new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    })
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example/model.tar.bz2' }
        })
      )
      .mockResolvedValueOnce(ok)
    const landed = await fetchBundleResponse('https://github.com/x/model.tar.bz2', new AbortController().signal, fetchImpl)
    expect(landed.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const access = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' }
      })
    )
    await expect(
      fetchBundleResponse('https://operator.test/assets/client.js', new AbortController().signal, access)
    ).rejects.toThrow(/login page/)
    expect(access).toHaveBeenCalledOnce()
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


  it('pins Whisper floor to an immutable revision and carries sha256 digests', () => {
    expect(WHISPER_FLOOR_REVISION).toMatch(/^[0-9a-f]{40}$/)
    expect(WHISPER_FLOOR_REVISION).not.toBe('main')
    expect(WHISPER_FLOOR_FILE_PINS).toHaveLength(WHISPER_FLOOR_REQUIRED_FILES.length)
    for (const pin of WHISPER_FLOOR_FILE_PINS) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(pin.bytes).toBeGreaterThan(0)
    }
    expect(PARAKEET_ARCHIVE_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('assertPinnedFile fails closed on digest mismatch', async () => {
    const file = join(paths.userData, 'tampered.bin')
    writeFileSync(file, 'not-the-pinned-bytes')
    await expect(
      assertPinnedFile(file, { bytes: 19, sha256: '0'.repeat(64) })
    ).rejects.toThrow(/sha256|does not match|expected/)
  })

  it('Parakeet download fails closed when archive sha256 does not match the pin', async () => {
    const bogus = new Uint8Array(64).fill(7)
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/octet-stream',
        'content-length': String(bogus.byteLength)
      }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bogus)
          controller.close()
        }
      })
    } as unknown as Response)

    await expect(ensureImportAsrAssets()).rejects.toThrow(/sha256|files|connection/)
    expect(parakeetFilesReady(parakeetUserDir())).toBe(false)
    const snap = asrAssetsStatusSnapshot()
    expect(snap.ready).toBe(false)
    expect(snap.status).toBe('error')
  })

})
