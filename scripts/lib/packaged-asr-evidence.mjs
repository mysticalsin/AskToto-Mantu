// MQA-306: passive release-harness observation, not an application IPC or engine override.
// Self-contained because Playwright serializes this function into the real Electron main process.
export function installAsrObserver({ utilityProcess }) {
  const observation = { sequence: 0, hosts: [] }
  globalThis.__metisPackagedAsrGate = observation
  const fork = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (...args) => {
    const child = fork(...args)
    const entry = String(args[0])
    if (!/(?:^|[\\/])(?:whisper|parakeet)-asr-host\.js$/.test(entry)) return child
    const host = { entry, serviceName: args[2]?.serviceName, pid: child.pid, requests: [] }
    observation.hosts.push(host)
    const pending = new Map()
    let tier
    let modelsPath
    child.on('spawn', () => { host.pid = child.pid })
    const postMessage = child.postMessage.bind(child)
    child.postMessage = (...messages) => {
      const message = messages[0]
      if (message?.type === 'init') modelsPath = message.modelsPath
      if (message?.type === 'transcribe') {
        const request = {
          id: message.id,
          sequence: ++observation.sequence,
          pcmBytes: message.pcm?.byteLength,
          files: message.files ? { ...message.files } : undefined
        }
        host.requests.push(request)
        pending.set(message.id, request)
      }
      // Forward the very same message/ports to the original child. Never synthesize a reply or PCM.
      return postMessage(...messages)
    }
    child.on('message', (message) => {
      if (message?.type === 'ready') tier = message.tier
      const request = pending.get(message?.id)
      if (!request || (message.type !== 'result' && message.type !== 'error')) return
      pending.delete(message.id)
      request.complete = true
      request.tier = tier
      request.modelsPath = modelsPath
      if (message.type === 'error') request.error = message.message || 'native decode failed'
      else request.text = message.text
    })
    child.on('exit', (code) => {
      for (const request of pending.values()) {
        request.error = `native helper exited during decode (code ${code ?? 'unknown'})`
      }
      pending.clear()
    })
    return child
  }
}

const WHISPER_MODEL = 'Xenova/whisper-base'
const PARAKEET_MODEL = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const normalizePath = (path) => String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const recognizable = (text) => /seven million|revenue/i.test(String(text ?? ''))

export function assertPackagedAsrEvidence(engine, evidence) {
  if (engine !== 'whisper' && engine !== 'parakeet') throw new Error(`Unsupported ASR gate engine: ${engine}`)
  if (!recognizable(evidence.transcript)) throw new Error(`${engine}: the saved transcript has no recognizable fixture content`)
  if (/whisper transcriber unavailable|falling back to Parakeet/i.test(evidence.mainLog ?? '')) {
    throw new Error(`${engine}: the import used a silent Whisper-to-Parakeet fallback`)
  }
  const root = normalizePath(evidence.resourcesPath)
  if (!root) throw new Error('Missing packaged resources path')
  const expectedEntry = `${root}/app.asar/out/main/${engine}-asr-host.js`
  const hosts = (evidence.hosts ?? []).filter((host) =>
    normalizePath(host.entry).endsWith(`/${engine}-asr-host.js`)
  )
  const results = []
  const processIds = new Set()
  let unfinished = 0
  for (const host of hosts) {
    const requests = host.requests.filter((request) => request.sequence > evidence.afterSequence)
    if (!requests.length) continue
    const serviceMatches = engine === 'whisper'
      ? host.serviceName === 'metis-whisper-import'
      : /^metis-parakeet-asr-\d+$/.test(host.serviceName ?? '')
    if (normalizePath(host.entry) !== expectedEntry || !serviceMatches || !Number.isInteger(host.pid) || host.pid <= 0) {
      throw new Error(`${engine}: native helper identity is not the expected packaged utility process`)
    }
    for (const request of requests) {
      if (request.error) throw new Error(`${engine}: ${request.error}`)
      if (!request.complete) {
        unfinished += 1
        continue
      }
      if (!Number.isInteger(request.pcmBytes) || request.pcmBytes <= 0 || request.pcmBytes % 4 !== 0) {
        throw new Error(`${engine}: native result has no matching PCM decode request`)
      }
      if (engine === 'whisper') {
        if (request.tier !== WHISPER_MODEL) throw new Error(`Whisper model mismatch: ${request.tier ?? 'unknown'}`)
        if (normalizePath(request.modelsPath) !== `${root}/models`) {
          throw new Error('Whisper did not decode with the bundled installation models')
        }
      } else {
        for (const [key, name] of Object.entries({ encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' })) {
          if (normalizePath(request.files?.[key]) !== `${root}/asr/${PARAKEET_MODEL}/${name}`) {
            throw new Error(`Parakeet model mismatch: ${key}`)
          }
        }
      }
      results.push(request)
      processIds.add(host.pid)
    }
  }
  if (!results.length) throw new Error(`No successful ${engine === 'whisper' ? 'Whisper' : 'Parakeet'} native PCM decode was observed`)
  if (unfinished) throw new Error(`${engine}: ${unfinished} native decode request(s) are unfinished`)
  if (!recognizable(results.map((result) => result.text ?? '').join(' '))) {
    throw new Error(`${engine}: the native engine result has no recognizable fixture content`)
  }
  return { engine, model: engine === 'whisper' ? WHISPER_MODEL : PARAKEET_MODEL, processIds: [...processIds], resultCount: results.length }
}
