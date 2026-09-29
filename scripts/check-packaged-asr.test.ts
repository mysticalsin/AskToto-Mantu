import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertPackagedAsrEvidence, installAsrObserver } from './lib/packaged-asr-evidence.mjs'
import {
  describeFixture,
  fixtureProblem,
  importDiagnostics,
  inspectWav,
  MIN_FIXTURE_DURATION_MS,
  MIN_FIXTURE_RMS
} from './lib/packaged-asr-fixture.mjs'

const source = readFileSync(join(__dirname, 'check-packaged-asr.mjs'), 'utf8')

describe('MQA-306 packaged Windows transcription gate', () => {
  it('requests separate real Whisper and Parakeet imports before reporting success', () => {
    expect(source).toMatch(/const ENGINES = \['whisper', 'parakeet'\]/)
    expect(source).toMatch(/for \(const engine of ENGINES\)/)
    expect(source).toMatch(/asrEngine: args\.engine/)
    expect(source).toMatch(/window\.toto\.importAudioStart\(token\)/)
    expect(source).toMatch(/assertPackagedAsrEvidence\(engine,/)
  })

  it('installs passive observation before import and keeps native-dialog coverage explicit', () => {
    expect(source.indexOf('await app.evaluate(installAsrObserver)')).toBeLessThan(source.indexOf('app.firstWindow()'))
    expect(source).toMatch(/MQA-233/)
    expect(source).toMatch(/const timeoutSeconds = timeoutIndex === -1 \? 180/)
    expect(source).toMatch(/readFileSync\(mainLogPath, 'utf8'\)/)
  })
})

class FakeChild extends EventEmitter {
  pid = 1729
  postMessage = vi.fn((_message: unknown) => {})
}

const model = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const resourcesPath = 'C:\\Metis\\resources'
const text = 'The quarterly revenue target is seven million dollars.'
const gateGlobal = globalThis as typeof globalThis & { __metisPackagedAsrGate?: { sequence: number; hosts: unknown[] } }

afterEach(() => { delete gateGlobal.__metisPackagedAsrGate })

function fixture(engine: 'whisper' | 'parakeet') {
  const child = new FakeChild()
  const originalPost = child.postMessage
  const originalFork = vi.fn((_path: string, _args: string[], _options: { serviceName: string }) => child)
  const utilityProcess = { fork: originalFork }
  installAsrObserver({ utilityProcess })
  const serviceName = engine === 'whisper' ? 'metis-whisper-import' : 'metis-parakeet-asr-1'
  utilityProcess.fork(`${resourcesPath}\\app.asar\\out\\main\\${engine}-asr-host.js`, [], { serviceName })
  child.emit('spawn')
  const files = Object.fromEntries(
    Object.entries({ encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' })
      .map(([key, name]) => [key, `${resourcesPath}\\asr\\${model}\\${name}`])
  )
  if (engine === 'whisper') {
    child.postMessage({ type: 'init', modelsPath: `${resourcesPath}\\models` })
    child.emit('message', { type: 'ready', tier: 'Xenova/whisper-base', degraded: true })
  }
  const input = { type: 'transcribe', id: 7, pcm: new Float32Array(16_000).buffer, ...(engine === 'parakeet' ? { files } : {}) }
  child.postMessage(input)
  return {
    child, input, utilityProcess, originalPost, originalFork,
    evidence: () => ({ ...gateGlobal.__metisPackagedAsrGate, resourcesPath, afterSequence: 0, transcript: text, mainLog: '' })
  }
}

describe('MQA-306 actual packaged engine evidence', () => {
  it.each(['whisper', 'parakeet'] as const)('accepts %s only after a matching real PCM result and model identity', (engine) => {
    const f = fixture(engine)
    f.child.emit('message', { type: 'result', id: 7, text })
    expect(assertPackagedAsrEvidence(engine, f.evidence())).toMatchObject({
      engine, model: engine === 'whisper' ? 'Xenova/whisper-base' : model, processIds: [1729], resultCount: 1
    })
  })

  it('forwards the original PCM unchanged and never manufactures child results', () => {
    const f = fixture('whisper')
    expect(f.originalPost).toHaveBeenLastCalledWith(f.input)
    expect(f.originalPost.mock.calls.at(-1)?.[0]).toBe(f.input)
    expect(f.originalFork).toHaveBeenCalledOnce()
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/successful.*Whisper|Whisper.*successful/i)
    // The observer stores byte counts and identities, never a copy of the audio payload.
    expect(JSON.stringify(f.evidence())).not.toContain('"pcm":')
  })

  it('rejects a successful Parakeet fallback when Whisper was requested', () => {
    const f = fixture('parakeet')
    f.child.emit('message', { type: 'result', id: 7, text })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/Whisper/i)
  })

  it('rejects a Whisper-ready message without a successful decode', () => {
    const f = fixture('whisper')
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/successful/i)
  })

  it('rejects orphan responses and a completed request from a previous import', () => {
    const f = fixture('whisper')
    f.child.emit('message', { type: 'result', id: 8, text })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/successful/i)
    f.child.emit('message', { type: 'result', id: 7, text })
    expect(() => assertPackagedAsrEvidence('whisper', { ...f.evidence(), afterSequence: gateGlobal.__metisPackagedAsrGate!.sequence })).toThrow(/successful/i)
  })

  it('rejects any failed Whisper decode even if another window succeeded', () => {
    const f = fixture('whisper')
    f.child.emit('message', { type: 'result', id: 7, text })
    f.child.postMessage({ ...f.input, id: 8 })
    f.child.emit('message', { type: 'error', id: 8, message: 'ERR_DLOPEN_FAILED' })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/ERR_DLOPEN_FAILED/)
  })

  it('rejects a native child exit while its decode is pending', () => {
    const f = fixture('whisper')
    f.child.emit('exit', 1)
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/exited/i)
  })

  it('rejects an unfinished native decode even when an earlier window succeeded', () => {
    const f = fixture('whisper')
    f.child.emit('message', { type: 'result', id: 7, text })
    f.child.postMessage({ ...f.input, id: 8 })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/unfinished|incomplete/i)
  })

  it('requires an observed native child PID and a nonempty aligned PCM request', () => {
    const f = fixture('whisper')
    f.child.pid = 0
    f.child.emit('spawn')
    f.child.emit('message', { type: 'result', id: 7, text })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/identity/i)
    f.child.pid = 1729
    f.child.emit('spawn')
    f.child.postMessage({ ...f.input, id: 8, pcm: new ArrayBuffer(3) })
    f.child.emit('message', { type: 'result', id: 8, text })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/PCM/i)
  })

  it('can be serialized into the Electron main process without a module closure', () => {
    const child = new FakeChild()
    const context = {
      electron: { utilityProcess: { fork: () => child } },
      __metisPackagedAsrGate: undefined as { hosts: Array<{ requests: Array<{ text?: string }> }> } | undefined
    }
    runInNewContext(`(${installAsrObserver.toString()})(electron)`, context)
    runInNewContext(`{
      const child = electron.utilityProcess.fork('C:/Metis/resources/app.asar/out/main/whisper-asr-host.js', [], { serviceName: 'metis-whisper-import' });
      child.postMessage({ type: 'transcribe', id: 1, pcm: new ArrayBuffer(4) });
    }`, context)
    child.emit('message', { type: 'result', id: 1, text })
    expect(context.__metisPackagedAsrGate?.hosts[0].requests[0].text).toBe(text)
  })

  it('rejects the import fallback warning even after an earlier successful Whisper window', () => {
    const f = fixture('whisper')
    f.child.emit('message', { type: 'result', id: 7, text })
    expect(() => assertPackagedAsrEvidence('whisper', {
      ...f.evidence(), mainLog: '[warn] [import] whisper transcriber unavailable, falling back to Parakeet: DLL failure'
    })).toThrow(/fallback/i)
  })

  it('rejects an unexpected Whisper model and models loaded outside the package', () => {
    const f = fixture('whisper')
    f.child.emit('message', { type: 'ready', tier: 'unexpected/model' })
    f.child.emit('message', { type: 'result', id: 7, text })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/model/i)
  })

  it('rejects Whisper weights obtained outside the fresh installation', () => {
    const f = fixture('whisper')
    f.child.emit('message', { type: 'ready', tier: 'Xenova/whisper-base' })
    f.child.postMessage({ type: 'init', modelsPath: 'C:\\downloaded-models' })
    f.child.emit('message', { type: 'result', id: 7, text })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/bundled|package/i)
  })

  it('rejects a Parakeet model-file mismatch', () => {
    const f = fixture('parakeet')
    f.child.emit('message', { type: 'result', id: 7, text })
    f.child.postMessage({ ...f.input, id: 8, files: { ...f.input.files, encoder: 'C:\\wrong\\encoder.onnx' } })
    f.child.emit('message', { type: 'result', id: 8, text })
    expect(() => assertPackagedAsrEvidence('parakeet', f.evidence())).toThrow(/model/i)
  })

  it('rejects a probe-only response, an empty engine output, and unrecognizable saved content', () => {
    const f = fixture('whisper')
    f.child.postMessage({ type: 'probe', id: 8 })
    f.child.emit('message', { type: 'result', id: 8, text })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/successful/i)
    f.child.emit('message', { type: 'result', id: 7, text: '' })
    expect(() => assertPackagedAsrEvidence('whisper', f.evidence())).toThrow(/recognizable/i)
    expect(() => assertPackagedAsrEvidence('whisper', { ...f.evidence(), transcript: 'unrelated' })).toThrow(/saved/i)
  })
})

/** A 16-bit mono PCM WAVE file of `ms` of a 220 Hz tone at `amplitude` (0 = silence). */
function wav(ms: number, amplitude: number, { sampleRate = 22_050, truncateBy = 0 } = {}): Buffer {
  const samples = Math.round((sampleRate * ms) / 1000)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)), i * 2)
  }
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const chunk = (id: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.write(id, 0, 'ascii')
    head.writeUInt32LE(body.length, 4)
    return Buffer.concat([head, body])
  }
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', data)])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  const file = Buffer.concat([riff, body])
  return truncateBy ? file.subarray(0, file.length - truncateBy) : file
}

describe('M2-0445 packaged-ASR fixture verification', () => {
  it('accepts a full-length spoken-level fixture and measures its duration and energy', () => {
    const bytes = wav(3_000, 0.2)
    expect(fixtureProblem(bytes)).toBeNull()
    expect(inspectWav(bytes)).toMatchObject({ sampleRate: 22_050, channels: 1, bitsPerSample: 16, durationMs: 3_000 })
    expect(inspectWav(bytes).rms).toBeGreaterThan(0.1)
    expect(describeFixture(bytes)).toMatch(/^\d+ bytes, 22050 Hz 16-bit 1ch, 3000 ms, RMS 0\.14\d\d$/)
  })

  it('rejects a truncated, a too-short, a silent and an unreadable fixture', () => {
    expect(fixtureProblem(wav(3_000, 0.2, { truncateBy: 20_000 }))).toMatch(/^truncated/)
    expect(fixtureProblem(wav(MIN_FIXTURE_DURATION_MS - 100, 0.2))).toMatch(/^too short/)
    expect(fixtureProblem(wav(3_000, 0))).toMatch(/^silent/)
    expect(fixtureProblem(wav(3_000, MIN_FIXTURE_RMS / 2))).toMatch(/^silent/)
    expect(fixtureProblem(Buffer.from('not a wave file'))).toMatch(/^unreadable WAV/)
  })

  it('the gate re-synthesizes a rejected fixture once, before launch, and then fails as a harness fault', () => {
    expect(source.split('fixtureFault = synthesizeFixture()').length - 1).toBe(2)
    expect(source).toMatch(/fixture rejected \(\$\{fixtureFault\}\); re-synthesizing once/)
    expect(source).toMatch(/harness fault: the SAPI fixture is unusable twice/)
    expect(source.lastIndexOf('fixtureFault = synthesizeFixture()')).toBeLessThan(source.indexOf('electron.launch('))
  })
})

describe('M2-0445 packaged-ASR failure report', () => {
  const transcriptText = 'The quarterly revenue target is seven million dollars.'
  const observed = {
    sequence: 3,
    hosts: [{
      entry: 'x/whisper-asr-host.js', serviceName: 'metis-whisper-import', pid: 42,
      requests: [
        { id: 1, sequence: 1, pcmBytes: 64, complete: true, text: 'earlier import' },
        { id: 2, sequence: 2, pcmBytes: 128_000, complete: true, text: transcriptText },
        { id: 3, sequence: 3, pcmBytes: 64_000, error: 'native helper exited during decode (code 1)' }
      ]
    }]
  }
  const report = importDiagnostics({
    engine: 'whisper',
    job: { state: 'done', file: 'meeting.md' },
    meeting: { ok: false, error: 'Could not read the meeting file.' },
    fixture: '90000 bytes, 22050 Hz 16-bit 1ch, 3000 ms, RMS 0.1000',
    observed,
    afterSequence: 1,
    mainLog: [
      '[info] [dataless] probe failed; files treated as cloud-only',
      `[info] [renderer] ${transcriptText}`,
      '[info] [whisper-host] transcription tier: Xenova/whisper-base'
    ].join('\r\n')
  })

  it('prints job state, read-back result, line count, fixture, and this job\'s ASR requests and pipeline log', () => {
    expect(report).toEqual([
      'whisper job: state=done error=null file=yes',
      'whisper recallRead: ok=false error="Could not read the meeting file." lines=0',
      'fixture: 90000 bytes, 22050 Hz 16-bit 1ch, 3000 ms, RMS 0.1000',
      'asr request: host=metis-whisper-import pid=42 id=2 seq=2 pcmBytes=128000 result chars=54',
      'asr request: host=metis-whisper-import pid=42 id=3 seq=3 pcmBytes=64000 error="native helper exited during decode (code 1)"',
      'main log: [info] [dataless] probe failed; files treated as cloud-only',
      'main log: [info] [whisper-host] transcription tier: Xenova/whisper-base'
    ])
  })

  it('never includes decoded text', () => {
    expect(report.join('\n')).not.toContain('revenue')
  })

  it('says when nothing was observed or the read never ran', () => {
    expect(importDiagnostics({ engine: 'parakeet', job: undefined, meeting: undefined, fixture: 'f', observed: undefined, afterSequence: 0, mainLog: '' }))
      .toEqual([
        'parakeet job: state=missing error=null file=no',
        'parakeet recallRead: not called',
        'fixture: f',
        'asr requests: none observed',
        'main log: no import/ASR/storage lines'
      ])
  })

  it('the gate prints the report before every post-start failure, including an evidence rejection', () => {
    const loop = source.slice(source.indexOf('const failImport'), source.indexOf('decoded transcript: '))
    expect(loop).toMatch(/importDiagnostics\(/)
    expect(loop).not.toMatch(/return fail\(`/)
    expect(loop).toMatch(/catch \(error\) \{\s+return failImport\(/)
  })
})
