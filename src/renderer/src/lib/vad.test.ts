import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import ts from 'typescript'
import { makeVad, isSpeechLikeWindow } from './vad'
import { WHISPER_WORKLET_SRC } from './whisper-worklet-src'
import { createListenAudioRecovery, type ListenAudioRecoveryHost } from './listen-audio-recovery'
import type { ScreenDiagnosis } from '@shared/screen-permission'

const SR = 16000
const FRAME = 128 // one AudioWorklet quantum
const SPEECH = 0.08 // RMS of clear speech (above the 0.012 ON threshold)
const SILENCE = 0.001 // RMS of a quiet room (below the 0.006 OFF threshold)
const frames = (seconds: number): number => Math.round((seconds * SR) / FRAME)

/** Drive the VAD the way the worklet does (track buffer fill, reset on emit) and record each emit. */
function run(segments: Array<{ rms: number; sec: number }>): Array<{ speechSec: number; sinceResetSec: number }> {
  const vad = makeVad()
  const emits: Array<{ speechSec: number; sinceResetSec: number }> = []
  let samplesSinceReset = 0
  for (const seg of segments) {
    for (let i = 0; i < frames(seg.sec); i++) {
      samplesSinceReset += FRAME
      if (vad.step(seg.rms, FRAME)) {
        emits.push({ speechSec: 0, sinceResetSec: samplesSinceReset / SR })
        vad.reset()
        samplesSinceReset = 0
      }
    }
  }
  return emits
}

describe('makeVad — voice-activity endpointing', () => {
  it('admits quiet speech only after bounded quiet-room calibration', () => {
    const emits = run([
      { rms: 0.001, sec: 0.5 }, // calibrate a genuinely quiet room before reducing the admission floor
      { rms: 0.008, sec: 0.18 }, // below legacy ON=0.012, but clearly above the calibrated bed
      { rms: 0.003, sec: 0.08 }, // syllabic trough proves this is not a steady low bed
      { rms: 0.008, sec: 0.35 },
      { rms: SILENCE, sec: 0.8 }
    ])
    expect(emits).toHaveLength(1)
  })

  it('does not calibrate a cold-start noise spike into speech admission', () => {
    const emits = run([
      { rms: 0.008, sec: 0.15 }, // too short and arrives before calibration
      { rms: SILENCE, sec: 1 }
    ])
    expect(emits).toHaveLength(0)
  })

  it('emits once, ~0.6s after a real utterance ends', () => {
    const emits = run([
      { rms: SPEECH, sec: 1.2 },
      { rms: SILENCE, sec: 1.0 }
    ])
    expect(emits).toHaveLength(1)
    // 1.2s speech + ~0.6s of trailing silence before the endpoint fires.
    expect(emits[0].sinceResetSec).toBeGreaterThanOrEqual(1.2 + 0.58)
    expect(emits[0].sinceResetSec).toBeLessThanOrEqual(1.2 + 0.75)
  })

  it('rejects a short transient (cough/click) — under the min-speech floor → no emit', () => {
    const emits = run([
      { rms: SPEECH, sec: 0.15 }, // < 0.3s real speech
      { rms: SILENCE, sec: 1.0 }
    ])
    expect(emits).toHaveLength(0)
  })

  it('does NOT cut a sentence on short inter-word gaps', () => {
    // Three speech bursts separated by 0.3s gaps (< the 0.6s endpoint), then a real 1s pause.
    const emits = run([
      { rms: SPEECH, sec: 0.5 },
      { rms: SILENCE, sec: 0.3 },
      { rms: SPEECH, sec: 0.5 },
      { rms: SILENCE, sec: 0.3 },
      { rms: SPEECH, sec: 0.5 },
      { rms: SILENCE, sec: 1.0 }
    ])
    expect(emits).toHaveLength(1) // only the final 0.6s+ silence ends the turn
  })

  it('emits separate windows for two distinct turns', () => {
    const emits = run([
      { rms: SPEECH, sec: 0.6 },
      { rms: SILENCE, sec: 1.0 }, // turn 1 ends
      { rms: SPEECH, sec: 0.6 },
      { rms: SILENCE, sec: 1.0 } // turn 2 ends
    ])
    expect(emits).toHaveLength(2)
  })

  it('never emits on pure silence (no speech ever)', () => {
    const emits = run([{ rms: SILENCE, sec: 10 }])
    expect(emits).toHaveLength(0)
  })

  it('hysteresis: a value between OFF and ON does not start a turn on its own', () => {
    // 0.009 is above OFF (0.006) but below ON (0.012) → must NOT enter the speech state.
    const emits = run([
      { rms: 0.009, sec: 1.0 },
      { rms: SILENCE, sec: 1.0 }
    ])
    expect(emits).toHaveLength(0)
  })

  // MQA-044 — the 'them' channel is boosted 3.0× (listen.ts) to lift un-AGC'd call speech over the fixed
  // thresholds, which also lifts a steady far-end bed (conference comfort noise, hold music, a fan) to or
  // above the 0.006 exit. Once real speech had set the speech flag, the bed kept it set: `silence` was
  // zeroed every quantum, the endpoint could never fire, and the remote side reached the ASR only when the
  // worklet's 6s hard cap force-cut it — mid-word, up to 6s after the question ended.
  it('endpoints a remote turn riding a steady boosted bed (MQA-044)', () => {
    const BED = 0.009 // a 0.003 far-end bed × the 3.0× boost: above the 0.006 exit, below the 0.012 entry
    const emits = run([
      { rms: BED, sec: 2 },
      { rms: SPEECH, sec: 1.2 },
      { rms: BED, sec: 3 }
    ])
    expect(emits).toHaveLength(1) // latched, the bed produced no endpoint at all — ever
    // The turn ends 3.2s in; the endpoint must follow it, not a 6s buffer boundary.
    expect(emits[0].sinceResetSec).toBeGreaterThanOrEqual(3.2 + 0.58)
    expect(emits[0].sinceResetSec).toBeLessThanOrEqual(3.2 + 1.0)
  })

  it('escapes the speech state when the bed itself rides above the entry threshold (MQA-044)', () => {
    const LOUD_BED = 0.015 // above ON, so the VAD latches on the bed alone before anyone has spoken
    const emits = run([
      { rms: LOUD_BED, sec: 4 },
      { rms: SPEECH, sec: 1.2 },
      { rms: LOUD_BED, sec: 3 }
    ])
    expect(emits).toHaveLength(1)
    expect(emits[0].sinceResetSec).toBeGreaterThan(5.2) // after the turn ended, not part-way through it
    expect(emits[0].sinceResetSec).toBeLessThanOrEqual(6.5)
  })

  it('leaves a quiet-room turn exactly where it was (the adaptive floor stays out of the way)', () => {
    // The mic channel never carries a bed above the absolute floor, so nothing about its endpointing may
    // move: same single emit, same ~0.6s trailing silence as before the floor existed.
    const emits = run([
      { rms: 0.0005, sec: 2 },
      { rms: SPEECH, sec: 2.5 },
      { rms: SILENCE, sec: 1.5 }
    ])
    expect(emits).toHaveLength(1)
    expect(emits[0].sinceResetSec).toBeGreaterThanOrEqual(4.5 + 0.58)
    expect(emits[0].sinceResetSec).toBeLessThanOrEqual(4.5 + 0.75)
  })

  it('reset() clears state so the next turn starts fresh', () => {
    const vad = makeVad()
    for (let i = 0; i < frames(0.5); i++) vad.step(SPEECH, FRAME)
    vad.reset()
    // After reset, a brief transient + silence must not emit (speech counter was cleared).
    let emitted = false
    for (let i = 0; i < frames(0.15); i++) emitted ||= vad.step(SPEECH, FRAME)
    for (let i = 0; i < frames(1.0); i++) emitted ||= vad.step(SILENCE, FRAME)
    expect(emitted).toBe(false)
  })
})

/** Build a zero-mean buffer from per-segment RMS levels: samples alternate ±rms (exact RMS, exact mean 0),
 *  optionally riding a DC pedestal to simulate a loopback driver offset. */
function envelope(segments: Array<{ rms: number; sec: number }>, dc = 0): Float32Array {
  const total = segments.reduce((s, seg) => s + Math.round(seg.sec * SR), 0)
  const buf = new Float32Array(total)
  let o = 0
  for (const seg of segments) {
    const n = Math.round(seg.sec * SR)
    for (let i = 0; i < n; i++) buf[o++] = dc + (i % 2 === 0 ? seg.rms : -seg.rms)
  }
  return buf
}

describe('isSpeechLikeWindow — steady-background gate (them-channel boost fallout)', () => {
  const BED = { rms: 0.03, sec: 3 } // steady bed at ~2.5× the VAD ON threshold — what the 3.0× boost produces

  it('drops a steady bed (hold music / fan): flat envelope, no syllabic spread', () => {
    expect(isSpeechLikeWindow(envelope([BED]), Math.round(BED.sec * SR))).toBe(false)
  })

  it('drops a gently wobbling bed (±1.6 dB stays far under the 8 dB speech spread)', () => {
    const segs = Array.from({ length: 30 }, (_, i) => ({ rms: i % 2 === 0 ? 0.025 : 0.03, sec: 0.1 }))
    const buf = envelope(segs)
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(false)
  })

  it('keeps speech: syllabic bursts with near-silent gaps', () => {
    const segs = [0, 0, 0, 0].flatMap(() => [
      { rms: 0.08, sec: 0.4 },
      { rms: 0.001, sec: 0.2 }
    ])
    const buf = envelope(segs)
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })

  it('keeps speech over a loud music bed (peaks ≥ 8 dB above the bed)', () => {
    const segs = [0, 0, 0, 0].flatMap(() => [
      { rms: 0.08, sec: 0.4 }, // speech peaks
      { rms: 0.02, sec: 0.2 } // bed shows through in the gaps
    ])
    const buf = envelope(segs)
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })

  it('keeps a short reply that fills under a tenth of a bed-dominated window (MQA-044)', () => {
    // A bed emits nothing on its own, so the window that finally closes around a brief remote reply opened
    // seconds earlier and is ~90% bed. The p90 frame then lands on the bed, the ratio reads ~1, and the
    // real utterance was dropped with the window it arrived in.
    const buf = envelope([
      { rms: 0.009, sec: 4 },
      { rms: 0.08, sec: 0.5 }, // "Sure." — 10 of the window's 102 frames
      { rms: 0.009, sec: 0.6 }
    ])
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })

  it('a lone transient over a bed is still not enough to pass (no run, no speech)', () => {
    const buf = envelope([
      { rms: 0.009, sec: 4 },
      { rms: 0.08, sec: 0.1 }, // click/keystroke: 2 frames, under the 0.3s held-speech floor
      { rms: 0.009, sec: 0.6 }
    ])
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(false)
  })

  it('fails open on windows too short to judge (< 0.4s)', () => {
    const buf = envelope([{ rms: 0.03, sec: 0.3 }])
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })

  it('is scale-invariant: the 3.0× channel gain cannot change the verdict', () => {
    const bed = envelope([BED])
    const speech = envelope(
      [0, 0, 0, 0].flatMap(() => [
        { rms: 0.08, sec: 0.4 },
        { rms: 0.001, sec: 0.2 }
      ])
    )
    const boost = (b: Float32Array): Float32Array => b.map((v) => v * 3)
    expect(isSpeechLikeWindow(boost(bed), bed.length)).toBe(false)
    expect(isSpeechLikeWindow(boost(speech), speech.length)).toBe(true)
  })

  it('a DC offset does not compress the spread against real speech (mean-removed RMS)', () => {
    const segs = [0, 0, 0, 0].flatMap(() => [
      { rms: 0.08, sec: 0.4 },
      { rms: 0.001, sec: 0.2 }
    ])
    const buf = envelope(segs, 0.5) // raw frame RMS would be ~0.5 everywhere → ratio ~1 → speech eaten
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })
})

describe('whisper worklet source', () => {
  it('embeds makeVad + isSpeechLikeWindow and parses as valid JS (guards the .toString() transplant)', () => {
    expect(WHISPER_WORKLET_SRC).toContain('makeVad')
    expect(WHISPER_WORKLET_SRC).toContain('this.vad.step')
    expect(WHISPER_WORKLET_SRC).toContain('isSpeechLikeWindow')
    // Compile the worklet body with the realtime globals stubbed → proves it parses and the embedded
    // makeVad survived intact (a broken transplant would throw a SyntaxError here).
    const compile = (): void =>
      void new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WHISPER_WORKLET_SRC)
    expect(compile).not.toThrow()
  })

  /** Instantiate the ACTUAL worklet source with the realtime globals stubbed, capturing emitted windows. */
  function instantiateWorklet(
    messages: Array<{ audio?: Float32Array; sampleRate?: number }>,
    sourceRate = SR
  ): {
    process: (inputs: Float32Array[][]) => boolean
  } {
    const registration: { processor: (new () => { process: (inputs: Float32Array[][]) => boolean }) | null } = {
      processor: null
    }
    class FakeProcessor {
      port = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        postMessage: (m: { audio?: Float32Array; sampleRate?: number }): void => void messages.push(m)
      }
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WHISPER_WORKLET_SRC)(
      FakeProcessor,
      (_name: string, cls: new () => { process: (inputs: Float32Array[][]) => boolean }): void =>
        void (registration.processor = cls),
      sourceRate
    )
    if (!registration.processor) throw new Error('worklet source registered no processor')
    return new registration.processor()
  }

  function tone(sec: number, amp: number, hz = 440): Float32Array {
    const n = Math.round(sec * SR)
    const buf = new Float32Array(n)
    for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
    return buf
  }

  function toneAtRate(sec: number, amp: number, sourceRate: number, hz = 440): Float32Array {
    const n = Math.round(sec * sourceRate)
    const buf = new Float32Array(n)
    for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / sourceRate)
    return buf
  }

  function concat(...parts: Float32Array[]): Float32Array {
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0))
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }

  function feed(w: { process: (inputs: Float32Array[][]) => boolean }, signal: Float32Array): void {
    for (let o = 0; o + FRAME <= signal.length; o += FRAME) w.process([[signal.subarray(o, o + FRAME)]])
  }

  it('never emits during a steady boosted bed — the 6s hard-cap window is gated out pre-ASR', () => {
    const messages: Array<{ audio?: Float32Array }> = []
    const w = instantiateWorklet(messages)
    // 6.5s of steady tone at RMS ~0.035: above VAD ON (0.012) and EMIT_RMS (0.005), i.e. exactly the
    // boosted hold-music case. The hard cap fires at 6s; the envelope gate must swallow that window.
    feed(w, tone(6.5, 0.05))
    expect(messages).toHaveLength(0)
  })

  it('delivers a short remote reply buried in a steady boosted bed (MQA-044)', () => {
    const messages: Array<{ audio?: Float32Array }> = []
    const w = instantiateWorklet(messages)
    // 4s of bed at RMS ~0.009 (a 0.003 far-end bed × the 3.0× them boost), a 0.5s reply, then more bed.
    // Latched, the VAD never end-pointed: the only cut was the 6s hard cap, and that window is ~92% bed,
    // so the envelope gate judged it non-speech and the reply never reached the ASR at all.
    feed(w, concat(tone(4, 0.0127), tone(0.5, 0.113), tone(2, 0.0127)))
    const finals = messages.filter((m) => !(m as { partial?: boolean }).partial)
    expect(finals).toHaveLength(1)
    expect(finals[0].audio!.length).toBeLessThan(6 * SR) // end-pointed, not force-cut at the hard cap
  })

  it('still emits a real utterance: syllabic bursts end-pointed and passed through the gate', () => {
    const messages: Array<{ audio?: Float32Array }> = []
    const w = instantiateWorklet(messages)
    const silence = (sec: number): Float32Array => new Float32Array(Math.round(sec * SR))
    feed(w, concat(tone(0.4, 0.2), silence(0.2), tone(0.4, 0.2), silence(0.2), tone(0.4, 0.2), silence(0.8)))
    const finals = messages.filter((m) => !(m as { partial?: boolean }).partial)
    expect(finals).toHaveLength(1)
    expect(finals[0].audio!.length).toBeGreaterThan(0)
  })

  it('converts a 48 kHz worklet quantum stream before VAD and emits explicit 16 kHz PCM', () => {
    const messages: Array<{ audio?: Float32Array; sampleRate?: number }> = []
    const w = instantiateWorklet(messages, 48000)
    const silence = new Float32Array(Math.round(0.8 * 48000))
    feed(w, concat(toneAtRate(0.6, 0.2, 48000), silence))

    const final = messages.find((message) => message.audio && !(message as { partial?: boolean }).partial)
    expect(final?.sampleRate).toBe(SR)
    expect(final?.audio!.length).toBeGreaterThan(SR)
    expect(final?.audio!.length).toBeLessThan(2 * SR)
  })

  it('emits a bounded quiet calibrated utterance above the unchanged ASR RMS floor', () => {
    const messages: Array<{ audio?: Float32Array; sampleRate?: number }> = []
    const w = instantiateWorklet(messages)
    const silence = (sec: number): Float32Array => new Float32Array(Math.round(sec * SR))
    // Quiet speech is below the legacy VAD ON floor, but has two syllabic rises after room-tone
    // calibration and enough bounded energy that the worklet's unchanged EMIT_RMS gate accepts it.
    feed(w, concat(silence(0.5), tone(0.18, 0.0168), silence(0.08), tone(0.7, 0.0168), silence(0.7)))

    const final = messages.find((message) => message.audio && !(message as { partial?: boolean }).partial)
    expect(final?.audio).toBeInstanceOf(Float32Array)
    const audio = final?.audio ?? new Float32Array()
    const rms = Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length)
    expect(rms).toBeGreaterThanOrEqual(0.005)
  })
})

// Normalize CRLF → LF (same rationale as listen.test.ts): a Windows checkout would otherwise break any
// anchor whose newline sits mid-string.
const listenPath = join(__dirname, 'listen.ts')
const listenSrc = readFileSync(listenPath, 'utf8').replace(/\r\n/g, '\n')

function descendants(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (child: ts.Node): void => {
    found.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function only<T>(values: T[], description: string): T {
  if (values.length !== 1) throw new Error(`Expected one ${description}, found ${values.length}`)
  return values[0]
}

function requireImportedCall(call: ts.CallExpression, source: ts.SourceFile, name: string): void {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== name) throw new Error(`Expected ${name} call`)
  const binds = (binding: ts.BindingName): boolean =>
    ts.isIdentifier(binding)
      ? binding.text === name
      : binding.elements.some((element) => !ts.isOmittedExpression(element) && binds(element.name))
  const declares = (node: ts.Node): boolean =>
    ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && binds(node.name)) ||
    ((ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isImportEqualsDeclaration(node)) &&
      node.name?.text === name)
  if (
    source.statements.some(
      (statement) =>
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((item) => binds(item.name))) ||
        ((ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement)) &&
          statement.name?.text === name)
    )
  )
    throw new Error(`Module-level ${name} shadows its import`)
  for (let scope: ts.Node | undefined = call.parent; scope && scope !== source; scope = scope.parent) {
    if (
      (ts.isFunctionDeclaration(scope) ||
        ts.isFunctionExpression(scope) ||
        ts.isArrowFunction(scope) ||
        ts.isMethodDeclaration(scope) ||
        ts.isConstructorDeclaration(scope) ||
        ts.isGetAccessorDeclaration(scope) ||
        ts.isSetAccessorDeclaration(scope)) &&
      (scope.parameters.some((parameter) => binds(parameter.name)) ||
        (scope.body && descendants(scope.body).some(declares)))
    )
      throw new Error(`Shadowed ${name} call`)
  }
}

function requireRecoveryConsumerBinding(): void {
  const source = ts.createSourceFile(listenPath, listenSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const sourceDiagnostics = ts.transpileModule(listenSrc, { fileName: listenPath, reportDiagnostics: true }).diagnostics
  if (!sourceDiagnostics || sourceDiagnostics.length) throw new Error('Invalid listen syntax')
  const nodes = descendants(source)
  const factoryBinding = only(
    nodes.filter(
      (node): node is ts.ImportSpecifier => ts.isImportSpecifier(node) && node.name.text === 'createListenAudioRecovery'
    ),
    'runtime recovery factory binding'
  )
  const factoryImport = factoryBinding.parent.parent.parent
  if (
    !ts.isImportDeclaration(factoryImport) ||
    factoryImport.moduleSpecifier.getText(source) !== "'./listen-audio-recovery'" ||
    factoryImport.importClause?.isTypeOnly ||
    factoryBinding.isTypeOnly ||
    (factoryBinding.propertyName?.text ?? factoryBinding.name.text) !== 'createListenAudioRecovery'
  )
    throw new Error('Expected runtime recovery factory import')
  const useListen = only(
    source.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'useListen' &&
        !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ),
    'exported useListen declaration'
  )
  const audioRecovery = only(
    nodes.filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'audioRecovery' &&
        !!node.initializer
    ),
    'audioRecovery binding'
  )
  if (!useListen.body || audioRecovery.parent.parent.parent !== useListen.body)
    throw new Error('audioRecovery must bind directly in useListen')
  if (
    !ts.isCallExpression(audioRecovery.initializer!) ||
    audioRecovery.initializer!.expression.getText(source) !== 'useMemo'
  )
    throw new Error('Expected audioRecovery useMemo initializer')
  const memo = audioRecovery.initializer!.arguments[0]
  if (!memo || !ts.isArrowFunction(memo) || ts.isBlock(memo.body)) throw new Error('Expected returned recovery factory')
  let factoryExpression: ts.Expression = memo.body
  while (ts.isParenthesizedExpression(factoryExpression)) factoryExpression = factoryExpression.expression
  if (
    !ts.isCallExpression(factoryExpression) ||
    factoryExpression.expression.getText(source) !== 'createListenAudioRecovery'
  )
    throw new Error('Expected actual returned recovery factory')
  const factory = factoryExpression
  requireImportedCall(factory, source, 'createListenAudioRecovery')
  const hostFactory = factory.arguments[0]
  if (!hostFactory || !ts.isArrowFunction(hostFactory)) throw new Error('Expected recovery host callback')
  if (ts.isBlock(hostFactory.body)) throw new Error('Expected returned host object')
  let hostExpression: ts.Expression = hostFactory.body
  while (ts.isParenthesizedExpression(hostExpression)) hostExpression = hostExpression.expression
  if (!ts.isObjectLiteralExpression(hostExpression)) throw new Error('Expected actual returned host object')
  const names = hostExpression.properties.map((entry) => {
    if ((!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)) || !ts.isIdentifier(entry.name))
      throw new Error('Recovery host requires plain identifier properties')
    return entry.name.text
  })
  if (new Set(names).size !== names.length) throw new Error('Duplicate recovery host property')
  const property = (name: string) =>
    only(
      hostExpression.properties.filter(
        (entry): entry is ts.PropertyAssignment =>
          ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && entry.name.text === name
      ),
      name
    )
  for (const [name, value] of Object.entries({
    currentEpoch: '() => sessionEpochRef.current',
    admissionOpen: 'captureAdmissionIsOpen',
    wantsSystemAudio: '() => wantsSystemRef.current',
    isListening: '() => liveRef.current',
    getPermissions: '() => window.toto.getPermissions()',
    isWindows: '() => isWindows'
  }))
    expect(property(name).initializer.getText(source)).toBe(value)
  const refWiring = nodes.filter(
    (node): node is ts.BinaryExpression =>
      ts.isBinaryExpression(node) &&
      node.left.getText(source) === 'recoverSystemAudioRef.current' &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.right.getText(source) === 'audioRecovery.recoverSystemAudio'
  )
  const ref = only(refWiring, 'recovery method ref wiring')
  if (ref.parent.parent !== audioRecovery.parent.parent.parent)
    throw new Error('Recovery ref must bind in the factory scope')
  const directRecovery = property('recoverSystemNow')
  if (!ts.isArrowFunction(directRecovery.initializer) || !ts.isBlock(directRecovery.initializer.body))
    throw new Error('Expected guarded recovery callback block')
  expect(directRecovery.initializer.body.statements.map((statement) => statement.getText(source))).toEqual([
    "if (failBrokerAudioRecovery('system')) return",
    'void recoverSystemAudioRef.current?.()'
  ])
  const effect = only(
    nodes.filter(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'useEffect' &&
        node.arguments[0]?.getText(source) === '() => audioRecovery.watchSystemPermission()'
    ),
    'permission watcher effect'
  )
  if (effect.parent.parent !== audioRecovery.parent.parent.parent)
    throw new Error('Permission effect must bind in the factory scope')
  expect(effect.arguments[1]?.getText(source)).toBe('[audioRecovery, state.listening]')
  const admission = only(
    nodes.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'captureAdmissionIsOpen'
    ),
    'capture admission function'
  )
  expect(
    only(
      descendants(admission).filter((node): node is ts.ReturnStatement => ts.isReturnStatement(node)),
      'admission result'
    ).expression?.getText(source)
  ).toBe('meetingAdmittedRef.current && captureSessionIsOpen(epoch)')
  // Meeting admission (14ccce62) narrows the recovery gate; the session half keeps the exact prior check.
  const session = only(
    nodes.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'captureSessionIsOpen'
    ),
    'capture session function'
  )
  if (session.parent !== admission.parent) throw new Error('Session and admission gates must share a scope')
  expect(
    only(
      descendants(session).filter((node): node is ts.ReturnStatement => ts.isReturnStatement(node)),
      'session result'
    ).expression?.getText(source)
  ).toBe('liveRef.current && !stoppingRef.current && sessionEpochRef.current === epoch')
}

function recoveryFixture(overrides: Partial<ListenAudioRecoveryHost> = {}) {
  const controls = {
    epoch: 7,
    admitted: true,
    wants: true,
    listening: true,
    hasThem: false
  }
  const recoverNow = vi.fn()
  const getPermissions = vi.fn(async () => ({ screenRecording: 'denied' }))
  const systemSucceeded = vi.fn()
  const systemFailed = vi.fn()
  const permissionNote = vi.fn()
  const unused = (name: string) => (): never => {
    throw new Error(`Unexpected recovery host call: ${name}`)
  }
  const host: ListenAudioRecoveryHost = {
    currentEpoch: () => controls.epoch,
    admissionOpen: (epoch) => controls.admitted && controls.epoch === epoch,
    wantsSystemAudio: () => controls.wants,
    wantsMic: () => false,
    micDeviceId: () => '',
    acquireMic: unused('acquireMic'),
    acquireLoopback: unused('acquireLoopback'),
    armAudio: unused('armAudio'),
    openChannel: unused('openChannel'),
    hasChannel: (speaker) => speaker === 'them' && controls.hasThem,
    stopStream: unused('stopStream'),
    publishMicRecoveryFailure: unused('publishMicRecoveryFailure'),
    micRecoverySucceeded: unused('micRecoverySucceeded'),
    micRecoveryFailed: unused('micRecoveryFailed'),
    micRecoveryExhausted: unused('micRecoveryExhausted'),
    systemRecoverySucceeded: systemSucceeded,
    systemRecoveryFailed: systemFailed,
    isLive: () => controls.listening,
    isStopping: () => false,
    isPaused: () => false,
    isListening: () => controls.listening,
    scheduleThemProbation: unused('scheduleThemProbation'),
    themChannel: () => undefined,
    themHeard: () => false,
    themWindowSeen: () => false,
    setThemWindowSeen: unused('setThemWindowSeen'),
    onThemProbationRecycle: unused('onThemProbationRecycle'),
    themProbationDuration: () => 1,
    themDeviceChangeAction: () => 'ignore',
    recoverMicNow: unused('recoverMicNow'),
    recoverSystemNow: recoverNow,
    setSystemPermissionNote: permissionNote,
    getPermissions,
    deviceChangeTarget: () => new EventTarget(),
    isWindows: () => true,
    ...overrides
  }
  return {
    controls,
    host,
    recoverNow,
    getPermissions: vi.mocked(host.getPermissions),
    systemSucceeded,
    systemFailed,
    permissionNote
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function syntheticStream(): MediaStream {
  const track = { readyState: 'live', stop: vi.fn() }
  return { getAudioTracks: () => [track] } as unknown as MediaStream
}

async function withWatch(
  fixture: ReturnType<typeof recoveryFixture>,
  recovery: ReturnType<typeof createListenAudioRecovery>,
  entryTimers: number,
  body: (dispose: () => void) => Promise<void> | void,
  finish?: () => Promise<void>
): Promise<void> {
  const dispose = recovery.watchSystemPermission()
  const failures: unknown[] = []
  try {
    await body(dispose)
  } catch (error) {
    failures.push(error)
  }
  try {
    dispose()
  } catch (error) {
    failures.push(error)
  }
  try {
    expect(vi.getTimerCount()).toBe(entryTimers)
  } catch (error) {
    failures.push(error)
  }
  try {
    await finish?.()
  } catch (error) {
    failures.push(error)
  }
  try {
    const observed = [
      fixture.recoverNow,
      fixture.getPermissions,
      fixture.permissionNote,
      fixture.systemSucceeded,
      fixture.systemFailed
    ]
    const calls = observed.map((spy) => spy.mock.calls.length)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(observed.map((spy) => spy.mock.calls.length)).toEqual(calls)
    expect(vi.getTimerCount()).toBe(entryTimers)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) throw new AggregateError(failures, 'Watcher body or cleanup failed')
}

// MQA-041 — the same commit that taught the system-audio watcher to retry off capture state on Windows
// left an earlier `isWindows ||` in the effect's own early return, so the interval was never created there
// and the Windows branch inside it was unreachable in every state. A start-time loopback failure (default
// output mid-switch, another app holding the render endpoint) that healed seconds later therefore ran the
// whole meeting mic-only: no 'them' track exists, so no 'ended' event can fire, and the devicechange
// handler only re-acquires the mic. The only recovery left was Stop → Listen, which splits the transcript.
describe('windows system-audio retry watcher (MQA-041)', () => {
  it('creates the interval on Windows — the effect gates on session state only', async () => {
    requireRecoveryConsumerBinding()
    vi.useFakeTimers()
    const entryTimers = vi.getTimerCount()
    try {
      for (const [listening, wants] of [
        [false, true],
        [true, false],
        [true, true]
      ]) {
        const fixture = recoveryFixture()
        fixture.controls.listening = listening
        fixture.controls.wants = wants
        const recovery = createListenAudioRecovery(() => fixture.host)
        await withWatch(fixture, recovery, entryTimers, () => {
          if (!listening || !wants) {
            expect(vi.getTimerCount()).toBe(entryTimers)
            vi.advanceTimersByTime(6_000)
          } else {
            vi.advanceTimersByTime(2_999)
            expect(fixture.recoverNow).not.toHaveBeenCalled()
            vi.advanceTimersByTime(1)
          }
          expect(fixture.recoverNow).toHaveBeenCalledTimes(listening && wants ? 1 : 0)
          expect(fixture.getPermissions).not.toHaveBeenCalled()
        })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries capture directly on Windows instead of polling a permission that never flips', async () => {
    requireRecoveryConsumerBinding()
    vi.useFakeTimers()
    const entryTimers = vi.getTimerCount()
    try {
      const direct = recoveryFixture()
      const directRecovery = createListenAudioRecovery(() => direct.host)
      await withWatch(direct, directRecovery, entryTimers, () => {
        for (const calls of [1, 2, 2, 3]) {
          vi.advanceTimersByTime(3_000)
          expect(direct.recoverNow).toHaveBeenCalledTimes(calls)
        }
        expect(direct.getPermissions).not.toHaveBeenCalled()
      })
      expect(direct.recoverNow).toHaveBeenCalledTimes(3)

      for (const refusal of [{ admitted: false }, { wants: false }, { hasThem: true }]) {
        const fixture = recoveryFixture()
        if (!('wants' in refusal)) Object.assign(fixture.controls, refusal)
        const recovery = createListenAudioRecovery(() => fixture.host)
        await withWatch(fixture, recovery, entryTimers, () => {
          if ('wants' in refusal) fixture.controls.wants = false
          vi.advanceTimersByTime(3_000)
          expect(fixture.recoverNow).not.toHaveBeenCalled()
          expect(fixture.getPermissions).not.toHaveBeenCalled()
        })
      }

      const acquisition = deferred<MediaStream>()
      const acquire = vi.fn(() => acquisition.promise)
      const arm = vi.fn(async (_armed: boolean) => {})
      const open = vi.fn(async (_speaker: string, _stream: MediaStream, _epoch: number) => true)
      const pending = recoveryFixture({
        acquireLoopback: acquire,
        armAudio: arm,
        openChannel: open
      })
      const pendingRecovery = createListenAudioRecovery(() => pending.host)
      let operation: Promise<void> | undefined
      await withWatch(
        pending,
        pendingRecovery,
        entryTimers,
        async () => {
          operation = pendingRecovery.recoverSystemAudio()
          await vi.advanceTimersByTimeAsync(0)
          expect(acquire).toHaveBeenCalledTimes(1)
          expect(acquire.mock.results[0].value).toBe(acquisition.promise)
          expect(arm).toHaveBeenCalledWith(true)
          vi.advanceTimersByTime(3_000)
          expect(acquire).toHaveBeenCalledTimes(1)
          expect(pending.recoverNow).not.toHaveBeenCalled()
          expect(pending.getPermissions).not.toHaveBeenCalled()
        },
        async () => {
          const stream = syntheticStream()
          acquisition.resolve(stream)
          if (!operation) throw new Error('Missing original recovery operation')
          await operation
          expect(acquire).toHaveBeenCalledTimes(1)
          expect(arm.mock.calls).toEqual([[true], [false]])
          expect(open).toHaveBeenCalledTimes(1)
          expect(open).toHaveBeenCalledWith('them', stream, 7)
          expect(pending.systemSucceeded).toHaveBeenCalledTimes(1)
        }
      )
      expect(pending.systemSucceeded).toHaveBeenCalledTimes(1)
      expect(pending.systemFailed).not.toHaveBeenCalled()

      const deniedDiagnosis: ScreenDiagnosis = {
        state: 'denied',
        reasons: [],
        action: 'open-settings',
        duplicates: [],
        grantedFor: null,
        repairFailed: false
      }
      const permissionResults: Awaited<ReturnType<ListenAudioRecoveryHost['getPermissions']>>[] = [
        { screenRecording: 'granted' },
        { screenRecording: 'denied', screenDiagnosis: deniedDiagnosis }
      ]
      for (const [index, permission] of permissionResults.entries()) {
        const result = deferred<(typeof permissionResults)[number]>()
        const permissionSpy = vi.fn(() => result.promise)
        const fixture = recoveryFixture({ isWindows: () => false, getPermissions: permissionSpy })
        await withWatch(
          fixture,
          createListenAudioRecovery(() => fixture.host),
          entryTimers,
          async (stop) => {
            vi.advanceTimersByTime(3_000)
            expect(permissionSpy).toHaveBeenCalledTimes(1)
            expect(permissionSpy.mock.results[0].value).toBe(result.promise)
            expect(fixture.recoverNow).not.toHaveBeenCalled()
            stop()
            result.resolve(permission)
            await vi.advanceTimersByTimeAsync(0)
            expect(fixture.recoverNow).toHaveBeenCalledTimes(index === 0 ? 1 : 0)
            expect(fixture.permissionNote).toHaveBeenCalledTimes(index === 0 ? 0 : 1)
            if (index === 1) expect(fixture.permissionNote).toHaveBeenCalledWith(deniedDiagnosis)
          },
          async () => {
            result.resolve(permission)
            await result.promise
            await vi.advanceTimersByTimeAsync(0)
          }
        )
      }

      for (const stale of ['epoch', 'wants', 'channel', 'reject']) {
        const result = deferred<{ screenRecording?: string }>()
        const permissionSpy = vi.fn(() => result.promise)
        const fixture = recoveryFixture({
          isWindows: () => false,
          getPermissions: permissionSpy
        })
        await withWatch(
          fixture,
          createListenAudioRecovery(() => fixture.host),
          entryTimers,
          async (stop) => {
            vi.advanceTimersByTime(3_000)
            expect(permissionSpy).toHaveBeenCalledTimes(1)
            expect(permissionSpy.mock.results[0].value).toBe(result.promise)
            stop()
            if (stale === 'epoch') fixture.controls.epoch += 1
            if (stale === 'wants') fixture.controls.wants = false
            if (stale === 'channel') fixture.controls.hasThem = true
            if (stale === 'reject') result.reject(new Error('synthetic permission failure'))
            else result.resolve({ screenRecording: 'granted' })
            await vi.advanceTimersByTimeAsync(0)
            expect(fixture.recoverNow).not.toHaveBeenCalled()
            if (stale === 'wants') expect(fixture.permissionNote).toHaveBeenCalledTimes(1)
            else expect(fixture.permissionNote).not.toHaveBeenCalled()
          },
          async () => {
            if (stale === 'reject') result.reject(new Error('synthetic permission failure'))
            else result.resolve({ screenRecording: 'granted' })
            await result.promise.catch(() => {})
            await vi.advanceTimersByTimeAsync(0)
          }
        )
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
