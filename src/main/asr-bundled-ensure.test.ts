import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
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

import {
  ASR_ASSETS_MISSING,
  PARAKEET_ARCHIVE_URL,
  PARAKEET_MODEL_NAME,
  PARAKEET_REQUIRED_FILES,
  SPEAKER_WEIGHTS_REL,
  SPEAKER_WEIGHTS_URL,
  asrAssetsStatusSnapshot,
  ensureHighAccuracyParakeet,
  highAccuracyParakeetReady,
  parakeetFilesReady,
  resetAsrEnsureStateForTests,
  setAsrEnsureTestHooks,
  speakerWeightsReady
} from './asr-bundled-ensure'

function writeParakeetFiles(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const name of PARAKEET_REQUIRED_FILES) writeFileSync(join(dir, name), `${name}-bytes`)
}

function writeSpeakerFile(modelsRoot: string): void {
  const dest = join(modelsRoot, SPEAKER_WEIGHTS_REL)
  mkdirSync(join(dest, '..'), { recursive: true })
  writeFileSync(dest, 'speaker-embedding-bytes')
}

describe('high-accuracy Parakeet ensure', () => {
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

  it('is not ready when the high-accuracy Parakeet files are absent — status.ready is never a stub', () => {
    expect(highAccuracyParakeetReady()).toBe(false)
    const snap = asrAssetsStatusSnapshot()
    expect(snap.ready).toBe(false)
    expect(snap.status).not.toBe('ready')
    expect(JSON.stringify(snap)).not.toMatch(/[Rr]einstall/)
    expect(PARAKEET_ARCHIVE_URL).toContain(PARAKEET_MODEL_NAME)
    expect(PARAKEET_ARCHIVE_URL).toMatch(/sherpa-onnx\/releases\/download\/asr-models/)
    expect(SPEAKER_WEIGHTS_URL).toMatch(/3dspeaker_speech_campplus/)
  })

  it('will not mark ready until the high-accuracy Parakeet files and speaker weights exist on disk', async () => {
    expect(highAccuracyParakeetReady()).toBe(false)
    setAsrEnsureTestHooks({
      fetchParakeet: async (dest) => {
        writeParakeetFiles(dest)
      },
      fetchSpeaker: async (dest) => {
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, 'speaker-embedding-bytes')
      }
    })
    await ensureHighAccuracyParakeet()
    const parakeetDir = join(paths.userData, 'asr-models', PARAKEET_MODEL_NAME)
    expect(parakeetFilesReady(parakeetDir)).toBe(true)
    for (const name of PARAKEET_REQUIRED_FILES) {
      expect(existsSync(join(parakeetDir, name))).toBe(true)
    }
    expect(speakerWeightsReady(join(paths.userData, 'asr-models'))).toBe(true)
    expect(existsSync(join(paths.userData, 'asr-models', SPEAKER_WEIGHTS_REL))).toBe(true)
    expect(highAccuracyParakeetReady()).toBe(true)
    const snap = asrAssetsStatusSnapshot()
    expect(snap.ready).toBe(true)
    expect(snap.status).toBe('ready')
  })

  it('does not treat a hook that writes nothing as success', async () => {
    setAsrEnsureTestHooks({
      fetchParakeet: async () => {
        /* stub: claims work, writes no files */
      },
      fetchSpeaker: async () => {
        /* stub */
      }
    })
    await expect(ensureHighAccuracyParakeet()).rejects.toThrow(ASR_ASSETS_MISSING)
    expect(highAccuracyParakeetReady()).toBe(false)
    expect(asrAssetsStatusSnapshot().ready).toBe(false)
    expect(asrAssetsStatusSnapshot().status).toBe('error')
  })

  it('Retry after a failed download starts a new transfer and can become ready', async () => {
    let attempts = 0
    setAsrEnsureTestHooks({
      fetchParakeet: async (dest) => {
        attempts += 1
        if (attempts === 1) throw new Error('network down')
        writeParakeetFiles(dest)
      },
      fetchSpeaker: async (dest) => {
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, 'speaker-embedding-bytes')
      }
    })
    await expect(ensureHighAccuracyParakeet()).rejects.toThrow(/network down/)
    expect(highAccuracyParakeetReady()).toBe(false)
    expect(asrAssetsStatusSnapshot().status).toBe('error')
    expect(asrAssetsStatusSnapshot().error).toMatch(/network down/)

    await ensureHighAccuracyParakeet()
    expect(attempts).toBe(2)
    expect(highAccuracyParakeetReady()).toBe(true)
    expect(asrAssetsStatusSnapshot().ready).toBe(true)
    expect(asrAssetsStatusSnapshot().status).toBe('ready')
  })
})
