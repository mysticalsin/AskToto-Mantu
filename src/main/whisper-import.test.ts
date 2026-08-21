import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// MQA-234: the transformers/onnxruntime-node stack no longer loads in this process at all — it runs in an
// isolated Electron utilityProcess (whisper-asr-host.ts, see whisper-asr-host.test.ts for that seam's own
// coverage) and this module only ships Float32 windows across `utilityProcess.fork()` and gets text back.
// So the RPC boundary here is a fake child: an EventEmitter (matching UtilityProcess's `.on('message'/
// 'exit', ...)`) plus a `postMessage` spy the tests read the outgoing request id from, and `stderr`/
// `stdout` stub streams (ensureHost() in whisper-import.ts subscribes to both unconditionally).
class FakeChild extends EventEmitter {
  readonly postMessage = vi.fn()
  readonly kill = vi.fn()
  readonly stderr = new EventEmitter()
  readonly stdout = new EventEmitter()
}

// isPackaged: false so modelsDir() (whisper-import.ts) resolves against the repo's own resources/
// directory instead of the packaged app's process.resourcesPath, which does not exist in this test
// process — the RPC tests below never touch the filesystem it points at anyway (the child is fully faked).
const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  utilityProcess: { fork: vi.fn() }
}))
const logger = vi.hoisted(() => ({ mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

vi.mock('electron', () => electron)
vi.mock('./logger', () => logger)

import {
  applyInitLanguage,
  finalizeDecodedText,
  followLanguage,
  nextDecodeOptions,
  probeLanguage,
  reprobeForSwitch,
  resetLanguageFollow,
  stopWhisperHost,
  whisperImportTranscribe
} from './whisper-import'

/** Waits for the fake child's postMessage spy to have recorded a request of the given type, and returns
 *  it — transcribeRemote() posts synchronously once whisperImportTranscribe's two no-op probe awaits
 *  (probeLanguage/reprobeForSwitch, both immediate no-ops with no probe supplied) have flushed, which
 *  takes a couple of microtask ticks, not zero. */
async function waitForRequest(child: FakeChild, type: string): Promise<{ id: number; [key: string]: unknown }> {
  for (let i = 0; i < 50; i++) {
    const found = child.postMessage.mock.calls.map(([m]) => m as { type: string; id: number }).find((m) => m.type === type)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`fake child never received a '${type}' postMessage`)
}

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

  it('an explicit settings language pins EVERY window — un-pinned probe windows are retired', () => {
    // Design change (2026-08-05): transformers.js's whisper decodes un-pinned calls as ENGLISH (it does
    // not auto-detect), so the worker-style "probe without the pin every 4th window" wrote English junk
    // into real transcripts. A user's explicit language now decodes pinned on every window; switching is
    // the Parakeet re-probe's job (auto mode) or the user's (explicit mode).
    resetLanguageFollow('Portuguese')
    const langs = decodeOptionLanguages(Array(5).fill('hmm hmm okay'))
    expect(langs).toEqual(['portuguese', 'portuguese', 'portuguese', 'portuguese', 'portuguese'])
  })

  it('an explicit settings language is never overridden by text-shaped switch signals', () => {
    resetLanguageFollow('Portuguese')
    const en = 'so we are going to talk about the budget and the plan for the team'
    // Even English-looking decoded text (which pinned decoding of switched speech can produce) must not
    // move an explicit pin — the user said Portuguese; honoring that beats guessing.
    const langs = decodeOptionLanguages([en, en, en, en, en, en])
    expect(langs).toEqual(Array(6).fill('portuguese'))
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

  it('MQA-106: keeps probing on the PROBE_EVERY cadence after the opening burst instead of retiring at the budget', async () => {
    // Regression of MQA-012 for the import path. A non-English recording whose opening windows are short
    // greetings/openers burns the whole PROBE_WINDOW_BUDGET burst on returns the PROBE_MIN_WORDS gate
    // discards. The old `windowCount >= PROBE_WINDOW_BUDGET` hard cutoff then retired the probe forever, so
    // every later window decoded un-pinned = ENGLISH (transformers.js does not auto-detect), silently
    // transcribing the rest of a Portuguese import as English. The burst is an OPENING run, not a
    // retirement: a substantive window arriving later on the PROBE_EVERY cadence must still be able to pin,
    // mirroring listen.ts's shouldProbeLanguageWindow.
    const opener = 'Oi' // one word — always below PROBE_MIN_WORDS, discarded before it can (mis)pin
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    const probe = vi.fn().mockResolvedValue(opener)

    // Windows 0-7: the opening burst plus two off-cadence windows — all openers, none pins.
    for (let w = 0; w < 8; w++) {
      await probeLanguage(new Float32Array(16), probe)
      nextDecodeOptions() // advances windowCount well past PROBE_WINDOW_BUDGET
    }

    // The remote side finally says something substantive on the next cadence window (windowCount === 8).
    probe.mockResolvedValue(pt)
    await probeLanguage(new Float32Array(16), probe)

    // Without the fix the probe is retired at windowCount >= PROBE_WINDOW_BUDGET, this call never fires, and
    // the language stays undefined (auto) — the whole rest of the import would decode as English. With the
    // fix the cadence probe fires and pins Portuguese.
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(7) // kept probing past the budget
    expect(nextDecodeOptions()).toEqual({ return_timestamps: false, language: 'portuguese', task: 'transcribe' })
  })
})

// transformers.js's whisper does NOT auto-detect on an un-pinned call — it defaults to ENGLISH (verified
// live 2026-08-05: the worker-style "un-pinned probe window" decoded English junk, text lang-id read it
// as a genuine switch, and a French recording re-pinned to English by window ~6 despite a correct probe
// pin at window 3). Once the probe owns the pin, whisper must NEVER decode un-pinned; switches are
// detected by re-running the Parakeet probe instead.
describe('whisper-import probe-owned pin (no un-pinned windows, Parakeet-driven switching)', () => {
  const fr = 'avec tout ce qu’on met en place au niveau du groupe pour la transformation des équipes'
  const en = 'we are going to switch to english now for the rest of this meeting with the whole team'

  beforeEach(() => {
    resetLanguageFollow('auto')
  })

  it('a probe-owned pin survives every PROBE_EVERY-th window (never decodes un-pinned)', async () => {
    const probe = vi.fn().mockResolvedValue(fr)
    await probeLanguage(new Float32Array(16), probe)
    for (let w = 1; w <= 9; w++) {
      expect(nextDecodeOptions().language).toBe('french')
    }
  })

  it('an explicit settings language also never decodes un-pinned', () => {
    resetLanguageFollow('Portuguese')
    for (let w = 1; w <= 9; w++) {
      expect(nextDecodeOptions().language).toBe('portuguese')
    }
  })

  it('re-pins after SWITCH_AFTER consecutive Parakeet detections of a different language', async () => {
    const probe = vi.fn().mockResolvedValue(fr)
    await probeLanguage(new Float32Array(16), probe) // pin french at window 0
    probe.mockResolvedValue(en)
    for (let w = 1; w <= 4; w++) nextDecodeOptions() // windowCount reaches the PROBE_EVERY cadence
    await reprobeForSwitch(new Float32Array(16), probe) // first english detection
    for (let w = 5; w <= 8; w++) nextDecodeOptions()
    await reprobeForSwitch(new Float32Array(16), probe) // second consecutive english detection → switch
    expect(nextDecodeOptions().language).toBe('english')
  })

  it('a single divergent detection does not switch; the pin re-confirming clears the run', async () => {
    const probe = vi.fn().mockResolvedValue(fr)
    await probeLanguage(new Float32Array(16), probe)
    for (let w = 1; w <= 4; w++) nextDecodeOptions()
    probe.mockResolvedValueOnce(en)
    await reprobeForSwitch(new Float32Array(16), probe) // english once
    expect(nextDecodeOptions().language).toBe('french') // still pinned
    for (let w = 6; w <= 8; w++) nextDecodeOptions()
    probe.mockResolvedValueOnce(fr)
    await reprobeForSwitch(new Float32Array(16), probe) // french re-confirms → run cleared
    probe.mockResolvedValueOnce(en)
    for (let w = 9; w <= 12; w++) nextDecodeOptions()
    await reprobeForSwitch(new Float32Array(16), probe) // english again — count restarts at 1
    expect(nextDecodeOptions().language).toBe('french') // one detection after a reset must not switch
  })

  it('a failed or thin re-probe never disturbs a working pin', async () => {
    const probe = vi.fn().mockResolvedValue(fr)
    await probeLanguage(new Float32Array(16), probe)
    for (let w = 1; w <= 4; w++) nextDecodeOptions()
    probe.mockRejectedValueOnce(new Error('sherpa hiccup'))
    await expect(reprobeForSwitch(new Float32Array(16), probe)).resolves.toBeUndefined()
    probe.mockResolvedValueOnce('Hello')
    await reprobeForSwitch(new Float32Array(16), probe)
    expect(nextDecodeOptions().language).toBe('french')
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

// MQA-234: transformers no longer loads in-process, so whisperImportTranscribe's only remaining
// responsibility on the failure/lifecycle path is the RPC plumbing to the whisper-asr-host.ts child —
// covered here against a fully-controllable fake child. What the child itself does when its model files
// are actually missing (the old "reinstall guidance" coverage) now lives at the seam that owns it:
// whisper-asr-host.test.ts.
describe('whisper-import utilityProcess RPC (MQA-234: transformers isolated into its own child)', () => {
  let child: FakeChild

  beforeEach(() => {
    child = new FakeChild()
    electron.utilityProcess.fork.mockReset().mockReturnValue(child)
    resetLanguageFollow('auto')
  })

  afterEach(() => {
    // Every test either resolves/rejects the one in-flight request or kills the child itself; this just
    // guarantees no live host handle leaks from a failed test into the next one's fork() call count.
    stopWhisperHost()
  })

  it("rejects with the child's reported message when it answers a transcribe request with an error", async () => {
    const pending = whisperImportTranscribe(new Float32Array(16), 'auto')
    const req = await waitForRequest(child, 'transcribe')

    child.emit('message', {
      type: 'error',
      id: req.id,
      message: 'The bundled transcription files are missing or damaged. Reinstall Métis from a complete installer.'
    })

    await expect(pending).rejects.toThrow(/Reinstall Métis/)
  })

  it('resolves with the transcribed text on a matching result message', async () => {
    const pending = whisperImportTranscribe(new Float32Array(16), 'auto')
    const req = await waitForRequest(child, 'transcribe')

    child.emit('message', { type: 'result', id: req.id, text: 'hello there' })

    await expect(pending).resolves.toBe('hello there')
  })

  it('rejects every in-flight call when the child exits mid-request', async () => {
    const pending = whisperImportTranscribe(new Float32Array(16), 'auto')
    await waitForRequest(child, 'transcribe')

    child.emit('exit', 137) // OOM/native-fault style abrupt exit — not a graceful shutdown

    await expect(pending).rejects.toThrow(/exited unexpectedly/)
  })

  it('stopWhisperHost() kills the live child, and the next transcribe call forks a fresh one', async () => {
    const first = whisperImportTranscribe(new Float32Array(16), 'auto')
    const firstReq = await waitForRequest(child, 'transcribe')
    child.emit('message', { type: 'result', id: firstReq.id, text: 'first' })
    await expect(first).resolves.toBe('first')
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)

    stopWhisperHost()
    expect(child.kill).toHaveBeenCalledTimes(1)

    const second = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(second)
    const pending = whisperImportTranscribe(new Float32Array(16), 'auto')
    const secondReq = await waitForRequest(second, 'transcribe')

    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2)
    child.emit('message', { type: 'result', id: 999, text: 'must not resolve the new call' }) // stale child, ignored
    second.emit('message', { type: 'result', id: secondReq.id, text: 'second' })

    await expect(pending).resolves.toBe('second')
  })
})
