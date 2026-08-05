import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electron = vi.hoisted(() => ({ app: { isPackaged: true } }))
const logger = vi.hoisted(() => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

vi.mock('electron', () => electron)
vi.mock('./logger', () => logger)

import {
  applyInitLanguage,
  finalizeDecodedText,
  followLanguage,
  nextDecodeOptions,
  probeLanguage,
  resetLanguageFollow,
  whisperImportTranscribe
} from './whisper-import'

// Mirrors the essential cases from renderer/src/lib/whisper.worker.test.ts (PR #29) against the ported
// follow machine, driving nextDecodeOptions()/followLanguage() directly instead of round-tripping through
// a loaded model — the same reason parakeet.test.ts never exercises probeSherpa()'s real native require():
// loading the real ~75MB whisper-base ONNX session is neither fast nor necessary to cover this logic, and
// the decision code ported here is byte-for-byte the worker's, so driving it directly is exact coverage.
describe('whisper-import language follow', () => {
  beforeEach(() => {
    resetLanguageFollow('auto')
  })

  function decodeOptionLanguages(texts: string[]): (string | undefined)[] {
    return texts.map((text) => {
      const opts = nextDecodeOptions()
      followLanguage(text)
      return opts.language
    })
  }

  it('pins the decoder to the reset language and never asks for translation', () => {
    resetLanguageFollow('Portuguese')
    const opts = nextDecodeOptions()
    expect(opts).toEqual({ return_timestamps: false, language: 'portuguese', task: 'transcribe' })
  })

  it("decodes with auto-detect (no language option) for 'auto' and for names Whisper does not know", () => {
    resetLanguageFollow('auto')
    expect(nextDecodeOptions()).toEqual({ return_timestamps: false })

    resetLanguageFollow('Klingon') // stale setting / managed-config garbage must degrade to auto, not throw
    expect(nextDecodeOptions()).toEqual({ return_timestamps: false })
  })

  it('probes without the pin every 4th window so a real language switch can be noticed', () => {
    resetLanguageFollow('Portuguese')
    // Ambiguous text carries no confident language signal, so the follow machine must not move — the
    // cadence observed below is purely PROBE_EVERY, not a side effect of a detected switch.
    const langs = decodeOptionLanguages(Array(5).fill('hmm hmm okay'))
    expect(langs).toEqual(['portuguese', 'portuguese', 'portuguese', undefined, 'portuguese'])
  })

  it('follows a mid-recording language switch: probe detects it, one confirmation re-pins the decoder', () => {
    resetLanguageFollow('Portuguese')
    const pt = 'então vamos ver isso com você, não é, para fechar o contrato'
    const en = 'so we are going to talk about the budget and the plan for the team'
    // Windows 1-3: Portuguese speech. Window 4 (probe, un-pinned): the recording has switched to English
    // and the auto decode surfaces it. Window 5 (confirmation, un-pinned): English again → re-pin.
    // Window 6: decoded pinned to English.
    const langs = decodeOptionLanguages([pt, pt, pt, en, en, en])
    expect(langs).toEqual(['portuguese', 'portuguese', 'portuguese', undefined, undefined, 'english'])
  })

  it("converges onto the recording's language in 'auto' mode after two confident detections", () => {
    resetLanguageFollow('auto')
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    // Windows 1-2 decode auto (gathering evidence); window 3 decodes pinned to the converged language.
    const langs = decodeOptionLanguages([pt, pt, pt])
    expect(langs).toEqual([undefined, undefined, 'portuguese'])
  })

  it('leaves an in-progress follow untouched when the re-read setting is unchanged (per-chunk applyInitLanguage)', () => {
    // Imports call applyInitLanguage on every chunk (there is no separate one-shot "init message" the way
    // the live worker has) — re-reading the SAME 'auto' setting every chunk must not reset the machine,
    // or convergence could never survive past a single chunk.
    resetLanguageFollow('auto')
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    applyInitLanguage('auto')
    expect(nextDecodeOptions().language).toBeUndefined()
    followLanguage(pt)
    applyInitLanguage('auto')
    expect(nextDecodeOptions().language).toBeUndefined()
    followLanguage(pt)
    applyInitLanguage('auto') // third read of the same unchanged setting — still must not reset
    expect(nextDecodeOptions().language).toBe('portuguese') // converged, and the pin survived every re-read
  })

  it('resets the follow machine when the re-read setting changes mid-job', () => {
    resetLanguageFollow('auto')
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    followLanguage(pt)
    nextDecodeOptions()
    followLanguage(pt)
    // Converged onto Portuguese after two windows; the setting now changes (e.g. Settings edited between
    // two chunks of the same background import).
    applyInitLanguage('French')
    const opts = nextDecodeOptions()
    expect(opts.language).toBe('french') // window counter reset too: first post-change window is pinned, not a probe
  })

  it("does not leak a previous job's converged language into the next job (resetLanguageFollow)", () => {
    resetLanguageFollow('auto')
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    const langs = decodeOptionLanguages([pt, pt, pt])
    expect(langs.at(-1)).toBe('portuguese') // job 1 converged

    // Job 2 starts with the SAME 'auto' value (the default case — nobody touched Settings between
    // imports). Without the hard reset this window would decode pinned to Portuguese — the exact
    // cross-session leak whisper.worker.ts's resetFollow prevents for live meetings.
    resetLanguageFollow('auto')
    expect(nextDecodeOptions().language).toBeUndefined()
  })

  it('abandons an unconfirmed switch after its patience budget instead of probing forever', () => {
    resetLanguageFollow('Portuguese')
    const es = 'entonces vamos a ver esto con usted, pero no es para hoy'
    const de = 'wir haben das nicht mit der neuen Version gemacht, aber das ist gut'
    const fr = "alors nous allons voir ça avec vous, mais pas pour aujourd'hui"
    const noise = 'hmm hmm okay'
    // Windows 1-3 pinned-Portuguese noise; window 4 probes and detections then ALTERNATE languages
    // (Spanish → German → French → noise): no candidate ever confirms, so after PROBE_PATIENCE the run
    // must die. Window 8 is a regular periodic probe (8 % PROBE_EVERY === 0); window 9 must be pinned to
    // Portuguese again — not left un-pinned for the rest of the job.
    const langs = decodeOptionLanguages([noise, noise, noise, es, de, fr, noise, noise, noise])
    expect(langs.slice(0, 3)).toEqual(['portuguese', 'portuguese', 'portuguese'])
    expect(langs[8]).toBe('portuguese')
  })
})

// Field failure (2026-08-04, real French import, asrLanguage 'auto'): whisper-base hallucinated garbled
// ENGLISH on the first windows, and the text-based follow above then read that hallucination and pinned
// English for the whole recording. These drive probeLanguage() directly — the caller-supplied probe is a
// plain fake function, so this covers the pin/unsure/failure decisions without a loaded Parakeet model.
describe('whisper-import language probe (initial pin off a Parakeet decode of window 1)', () => {
  beforeEach(() => {
    resetLanguageFollow('auto')
  })

  it('pins the follow machine to a confidently-identified probe result before window 1 decodes', async () => {
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    const probe = vi.fn().mockResolvedValue(pt)
    await probeLanguage(new Float32Array(16), probe)
    expect(probe).toHaveBeenCalledTimes(1)
    // Pinned on window 1 itself — not the two-window convergence auto mode otherwise needs.
    expect(nextDecodeOptions()).toEqual({ return_timestamps: false, language: 'portuguese', task: 'transcribe' })
  })

  it('leaves auto untouched when the probe text carries no confident language signal', async () => {
    const probe = vi.fn().mockResolvedValue('hmm hmm okay')
    await probeLanguage(new Float32Array(16), probe)
    expect(nextDecodeOptions().language).toBeUndefined()
  })

  it('leaves auto untouched when the probe itself fails (Parakeet unavailable)', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('Bundled Parakeet model assets are missing.'))
    await expect(probeLanguage(new Float32Array(16), probe)).resolves.toBeUndefined()
    expect(nextDecodeOptions().language).toBeUndefined()
  })

  it('never probes when no probe hook is supplied', async () => {
    await expect(probeLanguage(new Float32Array(16))).resolves.toBeUndefined()
    expect(nextDecodeOptions().language).toBeUndefined()
  })

  it('never probes once the effective language is explicitly pinned by settings, not auto', async () => {
    resetLanguageFollow('Portuguese')
    const probe = vi.fn()
    await probeLanguage(new Float32Array(16), probe)
    expect(probe).not.toHaveBeenCalled()
  })

  it('skips a low-information window (call-join "Hello") and pins off the first substantive one', async () => {
    // Field failure #2 (2026-08-05): window 0 was silence + an English greeting — a single window-0 probe
    // pinned ENGLISH and whisper then silently TRANSLATED the whole French call. The probe must wait for
    // real speech.
    const probe = vi
      .fn()
      .mockResolvedValueOnce('Hello') // window 0: greeting only — must not pin English
      .mockResolvedValueOnce('avec tout ce qu’on met en place au niveau du groupe pour la transformation')
    await probeLanguage(new Float32Array(16), probe)
    expect(nextDecodeOptions().language).toBeUndefined() // window 0 decoded un-pinned
    await probeLanguage(new Float32Array(16), probe)
    expect(nextDecodeOptions().language).toBe('french') // pinned at window 1
  })

  it('stops probing once pinned', async () => {
    const probe = vi.fn().mockResolvedValue('a gente vai ver isso com você, não é, para o contrato agora')
    await probeLanguage(new Float32Array(16), probe)
    nextDecodeOptions()
    await probeLanguage(new Float32Array(16), probe)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('gives up after the probe window budget and leaves auto in place', async () => {
    const probe = vi.fn().mockResolvedValue('Hello') // never substantive
    for (let i = 0; i < 7; i++) {
      await probeLanguage(new Float32Array(16), probe)
      nextDecodeOptions()
    }
    expect(probe).toHaveBeenCalledTimes(5) // PROBE_WINDOW_BUDGET
    expect(nextDecodeOptions().language).toBeUndefined()
  })
})

// Field failure (same import): a runaway whisper-base decode loop emitted a single transcript line
// repeating a short phrase 100+ times ("series of series" ×103, "the area of" ×111). Imports decode 12s
// slabs with no VAD trim and no live repetition guard, so this drives finalizeDecodedText() — the pure
// collapse (shared/transcript-filter.ts, ported from live Listen) plus the follow advance — directly,
// the same way nextDecodeOptions/followLanguage above are tested without a loaded model.
describe('whisper-import runaway-decode-loop guard (finalizeDecodedText)', () => {
  beforeEach(() => {
    resetLanguageFollow('auto')
  })

  it('collapses a pathological intra-window repeat before it can reach the saved transcript', () => {
    const looped = Array(111).fill('the area of').join(' ')
    expect(finalizeDecodedText(looped)).toBe('the area of the area of')
  })

  it('leaves normal prose completely untouched', () => {
    const prose = 'we should close the budget review by Friday and confirm the rollout plan'
    expect(finalizeDecodedText(prose)).toBe(prose)
  })

  it('still advances the language follow machine on the (collapsed) text', () => {
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    const looped = Array(40).fill(pt).join(' ') // pathological, but still Portuguese-shaped
    finalizeDecodedText(looped)
    finalizeDecodedText(looped)
    // Two confident windows converge auto onto Portuguese, exactly like the non-looped fixture elsewhere
    // in this file — proving the loop guard collapses the text without breaking language identification.
    expect(nextDecodeOptions().language).toBe('portuguese')
  })
})

describe('whisper-import model load failure', () => {
  let resourcesPath: string
  let originalResourcesPath: PropertyDescriptor | undefined

  beforeEach(() => {
    resourcesPath = mkdtempSync(join(tmpdir(), 'metis-whisper-import-test-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })
    logger.mainLog.error.mockClear()
  })

  afterEach(() => {
    rmSync(resourcesPath, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  })

  // Mirrors parakeet.test.ts's "fails locally with reinstall guidance when packaged assets are missing"
  // coverage for the other bundled ASR engine. Points env.localModelPath (via app.isPackaged +
  // process.resourcesPath) at an empty directory — allowRemoteModels stays false, so transformers.js fails
  // fast on the missing local file instead of attempting any network fetch or loading real model weights.
  it('fails with reinstall guidance when the bundled model files are missing, without downloading anything', async () => {
    await expect(whisperImportTranscribe(new Float32Array(16), 'auto')).rejects.toThrow(/Reinstall Métis/)
    expect(logger.mainLog.error).toHaveBeenCalledWith(
      '[whisper-import] model load failed:',
      expect.stringContaining('was not found locally')
    )
  })
})
