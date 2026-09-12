import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertPackagedAsrEvidence, installAsrObserver } from './lib/packaged-asr-evidence.mjs'

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
