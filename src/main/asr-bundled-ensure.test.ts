import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fsPromises from 'node:fs/promises'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paths = vi.hoisted(() => ({ resources: '', userData: '', isPackaged: false }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return paths.isPackaged
    },
    getPath: () => paths.userData
  },
  net: { fetch: vi.fn() }
}))
vi.mock('./logger', () => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { net } from 'electron'
import { BUNDLE_GOT_LOGIN_HTML } from '@shared/bundle-response'
import { ASR_REQUIRED_FILES } from './asr-manifest'
import * as SpeechPackResolver from './features/components/speech-pack/resolver'
import { WHISPER_BASE_Q8 } from './features/components/speech-pack/manifest'
import { componentManifestIdentity } from './features/components/speech-pack/resolver'
import {
  ASR_ASSETS_MISSING,
  ASR_PACKAGED_ASSETS_MISSING,
  asrModelProtocolSpeechPackOptions,
  PARAKEET_MODEL_NAME,
  PARAKEET_REQUIRED_FILES,
  type AsrEnsureTestHooks,
  WHISPER_FLOOR_ID,
  WHISPER_FLOOR_REQUIRED_FILES,
  ensureImportAsrAssets,
  ensureParakeetAssets,
  ensureWhisperFloorAssets,
  fetchBundleResponse,
  importAsrAssetsReady,
  asrAssetsStatusSnapshot,
  parakeetFilesReady,
  parakeetUserDir,
  setAsrEnsureTestHooks,
  resetAsrEnsureStateForTests,
  whisperFloorReady
} from './asr-bundled-ensure'

function withTestResources(hooks: Omit<AsrEnsureTestHooks, 'bundledResourceRoot'> = {}): AsrEnsureTestHooks {
  return { ...hooks, bundledResourceRoot: () => paths.resources }
}

describe('asr-bundled-ensure', () => {
  let originalResourcesPath: PropertyDescriptor | undefined

  beforeEach(() => {
    paths.isPackaged = false
    paths.resources = mkdtempSync(join(tmpdir(), 'metis-asr-res-'))
    paths.userData = mkdtempSync(join(tmpdir(), 'metis-asr-ud-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: paths.resources })
    setAsrEnsureTestHooks(withTestResources())
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
    await expect(importAsrAssetsReady()).resolves.toBe(false)
    const progress: number[] = []
    setAsrEnsureTestHooks(
      withTestResources({
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
    )
    await ensureImportAsrAssets((pct) => progress.push(pct))
    await expect(
      parakeetFilesReady(join(paths.userData, 'asr-models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'))
    ).resolves.toBe(true)
    await expect(whisperFloorReady(join(paths.userData, 'asr-models'))).resolves.toBe(true)
    await expect(importAsrAssetsReady()).resolves.toBe(true)
    expect(progress.some((n) => n > 0)).toBe(true)
    expect(ASR_ASSETS_MISSING).not.toMatch(/[Rr]einstall/)
    const snap = await asrAssetsStatusSnapshot()
    expect(snap.ready).toBe(true)
    expect(snap.status).toBe('ready')
    expect(JSON.stringify(snap)).not.toMatch(/[Rr]einstall/)
  })

  it('fails closed when an installed app is missing built-in ASR files, even if an old userData fallback exists', async () => {
    paths.isPackaged = true
    const parakeet = join(paths.userData, 'asr-models', PARAKEET_MODEL_NAME)
    mkdirSync(parakeet, { recursive: true })
    for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(parakeet, name), 'old-copy')
    const whisper = join(paths.userData, 'asr-models', ...WHISPER_FLOOR_ID.split('/'))
    for (const rel of WHISPER_FLOOR_REQUIRED_FILES) {
      const file = join(whisper, rel)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'old-copy')
    }
    const fetchParakeet = vi.fn()
    const fetchWhisperFloor = vi.fn()
    setAsrEnsureTestHooks(withTestResources({ fetchParakeet, fetchWhisperFloor }))

    await expect(importAsrAssetsReady()).resolves.toBe(false)
    await expect(ensureImportAsrAssets()).rejects.toThrow(ASR_PACKAGED_ASSETS_MISSING)
    expect(fetchParakeet).not.toHaveBeenCalled()
    expect(fetchWhisperFloor).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()
    await expect(asrAssetsStatusSnapshot()).resolves.toMatchObject({
      ready: false,
      status: 'error',
      error: ASR_PACKAGED_ASSETS_MISSING
    })
  })

  it('keeps full as the legacy profile and requires an explicit lean pack without automatic downloads', async () => {
    paths.isPackaged = true
    const fetchParakeet = vi.fn()
    const fetchWhisperFloor = vi.fn()
    setAsrEnsureTestHooks(withTestResources({ fetchParakeet, fetchWhisperFloor, selectedAsrEngine: () => 'whisper' }))
    await expect(asrAssetsStatusSnapshot()).resolves.toMatchObject({
      ready: false,
      status: 'error',
      error: ASR_PACKAGED_ASSETS_MISSING
    })
    expect(fetchParakeet).not.toHaveBeenCalled()
    expect(fetchWhisperFloor).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()

    writeFileSync(join(paths.resources, 'speech-pack-profile.json'), JSON.stringify({ schema: 1, profile: 'lean' }))
    await expect(asrAssetsStatusSnapshot()).resolves.toMatchObject({
      ready: false,
      status: 'error',
      reason: 'lean-pack-not-installed'
    })
    await expect(asrModelProtocolSpeechPackOptions()).resolves.toEqual({ useOnlySpeechPackModels: true })
    await expect(ensureImportAsrAssets()).rejects.toMatchObject({ code: 'ASR_SPEECH_PACK_NOT_READY' })
    await expect(ensureWhisperFloorAssets()).rejects.toMatchObject({ code: 'ASR_SPEECH_PACK_NOT_READY' })
    expect(fetchParakeet).not.toHaveBeenCalled()
    expect(fetchWhisperFloor).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('fails closed on an invalid packaged profile, including the protocol route', async () => {
    paths.isPackaged = true
    writeFileSync(
      join(paths.resources, 'speech-pack-profile.json'),
      JSON.stringify({ schema: 1, profile: 'lean', extra: true })
    )
    setAsrEnsureTestHooks(withTestResources({ selectedAsrEngine: () => 'whisper' }))
    await expect(asrAssetsStatusSnapshot()).resolves.toMatchObject({ ready: false, reason: 'invalid-profile' })
    await expect(asrModelProtocolSpeechPackOptions()).resolves.toEqual({ useOnlySpeechPackModels: true })
    await expect(ensureImportAsrAssets()).rejects.toMatchObject({ reason: 'invalid-profile' })
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('re-resolves the selected Whisper pack on each protocol admission after engine selection changes', async () => {
    paths.isPackaged = true
    writeFileSync(join(paths.resources, 'speech-pack-profile.json'), JSON.stringify({ schema: 1, profile: 'lean' }))
    let selected: 'whisper' | 'parakeet' | 'apple' = 'parakeet'
    setAsrEnsureTestHooks(withTestResources({ selectedAsrEngine: () => selected }))
    const readiness: SpeechPackResolver.SpeechPackReadiness = {
      status: 'ready',
      componentId: WHISPER_BASE_Q8.id,
      version: WHISPER_BASE_Q8.version,
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8),
      evidence: 'prior-activation-and-size-checked'
    }
    const resolve = vi.spyOn(SpeechPackResolver, 'resolveSpeechPack').mockResolvedValue(readiness)
    try {
      await expect(asrModelProtocolSpeechPackOptions()).resolves.toEqual({ useOnlySpeechPackModels: true })
      selected = 'whisper'
      await expect(asrModelProtocolSpeechPackOptions()).resolves.toEqual({
        useOnlySpeechPackModels: true,
        speechPackModelsRoot: join(paths.userData, 'speech-packs', WHISPER_BASE_Q8.id, WHISPER_BASE_Q8.version)
      })
      expect(resolve).toHaveBeenCalledTimes(1)
    } finally {
      resolve.mockRestore()
    }
  })

  it('does not report a packaged ASR bundle ready when a required runtime manifest file is missing', async () => {
    paths.isPackaged = true
    const parakeet = join(paths.resources, 'asr', PARAKEET_MODEL_NAME)
    mkdirSync(parakeet, { recursive: true })
    for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(parakeet, name), 'bundled')

    for (const parts of ASR_REQUIRED_FILES) {
      if (parts.at(-1) === 'special_tokens_map.json') continue
      const file = join(paths.resources, ...parts)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'bundled')
    }

    await expect(importAsrAssetsReady()).resolves.toBe(false)
    await expect(asrAssetsStatusSnapshot()).resolves.toMatchObject({ ready: false, error: ASR_PACKAGED_ASSETS_MISSING })
    await expect(ensureImportAsrAssets()).rejects.toThrow(ASR_PACKAGED_ASSETS_MISSING)
  })

  it('reports a packaged ASR bundle ready only when Parakeet and the complete runtime manifest are present', async () => {
    paths.isPackaged = true
    const parakeet = join(paths.resources, 'asr', PARAKEET_MODEL_NAME)
    mkdirSync(parakeet, { recursive: true })
    for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(parakeet, name), 'bundled')

    for (const parts of ASR_REQUIRED_FILES) {
      const file = join(paths.resources, ...parts)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'bundled')
    }

    await expect(importAsrAssetsReady()).resolves.toBe(true)
    await expect(asrAssetsStatusSnapshot()).resolves.toMatchObject({ ready: true, status: 'ready' })
  })

  it('keeps the extraction phase visible at the 69% onboarding handoff', async () => {
    let duringExtraction: Awaited<ReturnType<typeof asrAssetsStatusSnapshot>> | undefined
    setAsrEnsureTestHooks(
      withTestResources({
        fetchParakeet: async (dest, onProgress) => {
          // The production downloader has just completed the archive transfer and is about to extract.
          // Until the production callback accepts its phase label, the old code surfaces this as generic
          // "Getting transcription files…", which reads like a frozen download.
          ;(onProgress as unknown as ((pct: number, label: string) => void) | undefined)?.(
            92,
            'Preparing transcription files…'
          )
          duringExtraction = await asrAssetsStatusSnapshot()
          mkdirSync(dest, { recursive: true })
          for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dest, name), 'p')
        },
        fetchWhisperFloor: async (dest) => {
          const dir = join(dest, ...WHISPER_FLOOR_ID.split('/'))
          for (const rel of WHISPER_FLOOR_REQUIRED_FILES) {
            const file = join(dir, rel)
            mkdirSync(join(file, '..'), { recursive: true })
            writeFileSync(file, 'w')
          }
        }
      })
    )

    await ensureImportAsrAssets()

    expect(duringExtraction).toMatchObject({
      ready: false,
      status: 'downloading',
      label: 'Preparing transcription files…'
    })
    expect(duringExtraction?.progress).toBeCloseTo(0.69)
  })

  it('single-flights Parakeet recovery across direct and aggregate callers', async () => {
    let releaseFetch!: () => void
    let startedFetch!: () => void
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const fetchStarted = new Promise<void>((resolve) => {
      startedFetch = resolve
    })
    let parakeetFetches = 0
    setAsrEnsureTestHooks(
      withTestResources({
        fetchParakeet: async (dest) => {
          parakeetFetches += 1
          startedFetch()
          await fetchGate
          mkdirSync(dest, { recursive: true })
          for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dest, name), 'p')
        },
        fetchWhisperFloor: async (dest) => {
          const dir = join(dest, ...WHISPER_FLOOR_ID.split('/'))
          for (const rel of WHISPER_FLOOR_REQUIRED_FILES) {
            const file = join(dir, rel)
            mkdirSync(join(file, '..'), { recursive: true })
            writeFileSync(file, 'w')
          }
        }
      })
    )

    const direct = ensureParakeetAssets()
    await fetchStarted
    const aggregate = ensureImportAsrAssets()
    await Promise.resolve()
    expect(parakeetFetches).toBe(1)

    releaseFetch()
    await Promise.all([direct, aggregate])
    expect(parakeetFetches).toBe(1)
    await expect(importAsrAssetsReady()).resolves.toBe(true)
  })

  it('single-flights Whisper recovery across direct callers', async () => {
    let releaseFetch!: () => void
    let startedFetch!: () => void
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const fetchStarted = new Promise<void>((resolve) => {
      startedFetch = resolve
    })
    let whisperFetches = 0
    setAsrEnsureTestHooks(
      withTestResources({
        fetchWhisperFloor: async (dest) => {
          whisperFetches += 1
          startedFetch()
          await fetchGate
          const dir = join(dest, ...WHISPER_FLOOR_ID.split('/'))
          for (const rel of WHISPER_FLOOR_REQUIRED_FILES) {
            const file = join(dir, rel)
            mkdirSync(join(file, '..'), { recursive: true })
            writeFileSync(file, 'w')
          }
        }
      })
    )

    const first = ensureWhisperFloorAssets()
    await fetchStarted
    const second = ensureWhisperFloorAssets()
    await Promise.resolve()
    expect(whisperFetches).toBe(1)

    releaseFetch()
    await Promise.all([first, second])
    expect(whisperFetches).toBe(1)
    await expect(whisperFloorReady(join(paths.userData, 'asr-models'))).resolves.toBe(true)
  })

  it('status snapshot is not ready and never says reinstall when resources are empty', async () => {
    const snap = await asrAssetsStatusSnapshot()
    expect(snap.ready).toBe(false)
    expect(snap.status).not.toBe('ready')
    expect(JSON.stringify(snap)).not.toMatch(/[Rr]einstall/)
    expect(snap.label).toMatch(/transcription files/i)
  })

  it('keeps bundled boot status to metadata checks without opening model files', async () => {
    paths.isPackaged = true
    const parakeet = join(paths.resources, 'asr', PARAKEET_MODEL_NAME)
    mkdirSync(parakeet, { recursive: true })
    for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(parakeet, name), 'model')
    for (const parts of ASR_REQUIRED_FILES) {
      const file = join(paths.resources, ...parts)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'model')
    }
    const open = vi.spyOn(fsPromises, 'open').mockRejectedValue(new Error('status unexpectedly opened a file'))
    try {
      await expect(importAsrAssetsReady()).resolves.toBe(true)
      await expect(asrAssetsStatusSnapshot()).resolves.toMatchObject({ ready: true, status: 'ready' })
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })

  it('does not treat Access login HTML on disk as a ready Parakeet bundle', async () => {
    const dir = join(paths.userData, 'asr-models', PARAKEET_MODEL_NAME)
    mkdirSync(dir, { recursive: true })
    const html =
      '<!DOCTYPE html><html><body>Sign in · Cloudflare Access https://team.cloudflareaccess.com</body></html>'
    for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dir, name), html)
    await expect(parakeetFilesReady(dir)).resolves.toBe(false)
    await expect(importAsrAssetsReady()).resolves.toBe(false)
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
    const landed = await fetchBundleResponse(
      'https://github.com/x/model.tar.bz2',
      new AbortController().signal,
      fetchImpl
    )
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
    await expect(parakeetFilesReady(parakeetUserDir())).resolves.toBe(false)
    const snap = await asrAssetsStatusSnapshot()
    expect(snap.ready).toBe(false)
    expect(snap.status).toBe('error')
    expect(snap.error).toMatch(/login page|connection|files/)
    expect(snap.error).toBe(BUNDLE_GOT_LOGIN_HTML)
    expect(dest.endsWith('encoder.int8.onnx')).toBe(true)
  })
})
