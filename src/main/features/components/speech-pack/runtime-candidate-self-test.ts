import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { SPEAKER_EMBEDDING_DIMENSIONS } from '../../../speaker-embedding-protocol'
import { parseFixturePcm, readPinnedFixtureFile, recognitionMatchesFixture } from './self-test'
import { SELF_TEST_FIXTURE } from './manifest'
import {
  createRuntimeFeatureLeaseForVerifiedGeneration,
  runtimeHostEnvironment,
  type RuntimeEntryRole,
  type RuntimeFeatureLease,
  type RuntimeModelId,
  type VerifiedRuntimeGeneration
} from './runtime-lease'
import type { RuntimeInstallSelfTest } from './runtime-installer'
import { createRuntimeWhisperHost, RetainedRuntimeWhisperHostError } from './runtime-worker-host'
import type { RuntimeFeatureId } from './runtime-lease'
import type { OptionalRuntimeTarget } from './runtime-components'

const TEST_TIMEOUT_MS = 120_000
const FIXTURE = join(process.resourcesPath, 'speech-pack-fixtures', SELF_TEST_FIXTURE.name)

type Response = { type?: string; id?: string | number; text?: unknown; message?: unknown; embedding?: unknown }

class RetainedRuntimeCandidateSelfTestError extends Error {
  readonly retainStaging = true

  constructor(cause: unknown) {
    super('RUNTIME_SELF_TEST_EXIT_UNOBSERVED', { cause })
  }
}

function waitFor<T>(promise: Promise<T>, ms = TEST_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RUNTIME_SELF_TEST_TIMEOUT')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function verifiedGeneration(input: Parameters<RuntimeInstallSelfTest>[0]): VerifiedRuntimeGeneration {
  const roles: readonly RuntimeEntryRole[] =
    input.feature === 'offline-asr'
      ? ['parakeet-host', 'whisper-import-host', 'whisper-renderer-worker']
      : input.feature === 'speaker-embedding'
        ? ['speaker-embedding-host']
        : ['llama-server']
  const modelIds: readonly RuntimeModelId[] =
    input.feature === 'offline-asr'
      ? ['asr.parakeet-tdt-0.6b-v3-int8', 'asr.whisper-base-q8']
      : input.feature === 'speaker-embedding'
        ? ['speaker.embedding']
        : input.selectedModelId
          ? [input.selectedModelId]
          : []
  const entries: Partial<Record<RuntimeEntryRole, string>> = {}
  const models: Partial<Record<RuntimeModelId, { root: string; members: readonly string[] }>> = {}
  const rendererFiles: Record<string, string> = {}
  const rendererPins: Record<string, { bytes: number; sha256: string }> = {}
  const nativeDirs = new Set<string>()
  for (const inventory of input.inventories) {
    for (const [role, path] of Object.entries(inventory.entrypoints)) {
      if (roles.includes(role as RuntimeEntryRole))
        entries[role as RuntimeEntryRole] = `artifacts/${inventory.artifactId}/${path}`
    }
    for (const model of inventory.models) {
      if (!modelIds.includes(model.id as RuntimeModelId)) continue
      models[model.id as RuntimeModelId] = {
        root: `artifacts/${inventory.artifactId}/${model.root}`,
        members: model.members.map((member) => member.slice(model.root.length + 1))
      }
      if (model.id === 'asr.whisper-base-q8') {
        for (const member of model.members) {
          const inventoryPath = member
          const path = `artifacts/${inventory.artifactId}/${inventoryPath}`
          const pin = inventory.files.find((file) => file.path === inventoryPath)
          if (!pin) throw new Error('RUNTIME_SELF_TEST_MODEL_PIN_MISSING')
          rendererFiles[path] = `artifacts/${inventory.artifactId}/${inventoryPath}`
          rendererPins[path] = { bytes: pin.bytes, sha256: pin.sha256 }
        }
      }
    }
    if (
      inventory.kind === 'runtime' &&
      Object.keys(inventory.entrypoints).some((role) => roles.includes(role as RuntimeEntryRole))
    ) {
      for (const file of inventory.files) {
        if (/\.(?:node|dll|so|dylib)$/i.test(file.path))
          nativeDirs.add(`artifacts/${inventory.artifactId}/${file.path.slice(0, file.path.lastIndexOf('/'))}`)
      }
    }
    const workerPath = inventory.entrypoints['whisper-renderer-worker']
    if (input.feature === 'offline-asr' && workerPath) {
      const pin = inventory.files.find((file) => file.path === workerPath)
      if (!pin) throw new Error('RUNTIME_SELF_TEST_RENDERER_PIN_MISSING')
      const path = `artifacts/${inventory.artifactId}/${workerPath}`
      rendererFiles[path] = path
      rendererPins[path] = { bytes: pin.bytes, sha256: pin.sha256 }
    }
    if (input.feature === 'offline-asr') {
      for (const path of inventory.directories['whisper-ort-wasm']?.members ?? []) {
        const pin = inventory.files.find((file) => file.path === path)
        if (!pin) throw new Error('RUNTIME_SELF_TEST_RENDERER_PIN_MISSING')
        const resource = `artifacts/${inventory.artifactId}/${path}`
        rendererFiles[resource] = resource
        rendererPins[resource] = { bytes: pin.bytes, sha256: pin.sha256 }
      }
    }
  }
  return Object.freeze({
    generationIdentity: input.generationIdentity,
    catalogIdentity: input.catalogIdentity,
    target: Object.freeze({ ...input.target }),
    rootDir: input.stagedRoot,
    entries: Object.freeze(entries),
    models: Object.freeze(models),
    nativeLibraryDirs: Object.freeze([...nativeDirs]),
    rendererFiles: Object.freeze(rendererFiles),
    rendererPins: Object.freeze(rendererPins),
    release: () => undefined
  })
}

function childMessage(
  child: UtilityProcess,
  id: string | number,
  send: (child: UtilityProcess) => void
): Promise<Response> {
  return waitFor(
    new Promise<Response>((resolve, reject) => {
      const onExit = (code: number | null): void =>
        reject(new Error(`RUNTIME_SELF_TEST_HOST_EXIT_${code ?? 'UNKNOWN'}`))
      child.on('exit', onExit)
      child.on('message', (raw: unknown) => {
        const message = raw && typeof raw === 'object' && 'data' in raw ? (raw as { data?: unknown }).data : raw
        if (!message || typeof message !== 'object') return
        const response = message as Response
        if (response.id !== id && response.type !== 'ready') return
        if (response.type === 'error') reject(new Error('RUNTIME_SELF_TEST_HOST_ERROR'))
        else if (response.id === id || response.type === 'ready') resolve(response)
      })
      send(child)
    })
  )
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED'))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function utilitySelfTest(input: {
  lease: Awaited<ReturnType<typeof createRuntimeFeatureLeaseForVerifiedGeneration>>
  role: RuntimeEntryRole
  requests: (
    child: UtilityProcess,
    paths: { model: (id: RuntimeModelId) => string; members: (id: RuntimeModelId, member: string) => string },
    pcm: ArrayBuffer,
    assertCurrent: () => Promise<void>
  ) => Promise<void>
  signal: AbortSignal
  assertCurrent: () => Promise<void>
}): Promise<void> {
  if (input.signal.aborted) throw input.signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED')
  const fixture = await readPinnedFixtureFile(FIXTURE, SELF_TEST_FIXTURE)
  await input.assertCurrent()
  if (input.signal.aborted) throw input.signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED')
  const pcm = parseFixturePcm(fixture)
  await input.assertCurrent()
  if (input.signal.aborted) throw input.signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED')
  const child = utilityProcess.fork(input.lease.entry(input.role), [], {
    serviceName: `metis-runtime-selftest-${input.role}`,
    stdio: 'pipe',
    env: runtimeHostEnvironment(input.lease)
  })
  child.stderr?.on('data', () => undefined)
  child.stdout?.on('data', () => undefined)
  let resolveExit!: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  child.once('exit', resolveExit)
  const abort = (): void => {
    try {
      child.kill()
    } catch {
      /* Exact exit remains the lease barrier. */
    }
  }
  input.signal.addEventListener('abort', abort, { once: true })
  let failure: unknown
  let exitUnconfirmed = false
  try {
    if (input.signal.aborted) throw input.signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED')
    await input.requests(
      child,
      {
        model: (id: RuntimeModelId) => input.lease.model(id),
        members: (id, member) => input.lease.modelFile(id, member)
      },
      pcm,
      input.assertCurrent
    )
    if (input.signal.aborted) throw input.signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED')
  } catch (error) {
    failure = error
  } finally {
    input.signal.removeEventListener('abort', abort)
    try {
      child.kill()
    } catch {
      /* Awaiting exit below remains mandatory. */
    }
    try {
      await waitFor(exited)
    } catch {
      exitUnconfirmed = true
    }
  }
  if (exitUnconfirmed) throw new RetainedRuntimeCandidateSelfTestError(failure)
  if (failure) throw failure
}

async function testParakeet(
  lease: Awaited<ReturnType<typeof createRuntimeFeatureLeaseForVerifiedGeneration>>,
  pcm: ArrayBuffer,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>
): Promise<void> {
  await utilitySelfTest({
    lease,
    role: 'parakeet-host',
    signal,
    assertCurrent,
    requests: async (child, paths, audio, check) => {
      const files = {
        encoder: paths.members('asr.parakeet-tdt-0.6b-v3-int8', 'encoder.int8.onnx'),
        decoder: paths.members('asr.parakeet-tdt-0.6b-v3-int8', 'decoder.int8.onnx'),
        joiner: paths.members('asr.parakeet-tdt-0.6b-v3-int8', 'joiner.int8.onnx'),
        tokens: paths.members('asr.parakeet-tdt-0.6b-v3-int8', 'tokens.txt')
      }
      await childMessage(child, 'warm', (host) => host.postMessage({ type: 'warmup', id: 'warm', files }))
      await check()
      const result = await childMessage(child, 'decode', (host) =>
        host.postMessage({ type: 'transcribe', id: 'decode', files, pcm: audio })
      )
      if (typeof result.text !== 'string' || !recognitionMatchesFixture(result.text))
        throw new Error('RUNTIME_SELF_TEST_RECOGNITION_MISMATCH')
      await check()
    }
  })
}

async function testWhisperImport(
  lease: Awaited<ReturnType<typeof createRuntimeFeatureLeaseForVerifiedGeneration>>,
  pcm: ArrayBuffer,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>
): Promise<void> {
  await utilitySelfTest({
    lease,
    role: 'whisper-import-host',
    signal,
    assertCurrent,
    requests: async (child, paths, audio, check) => {
      await childMessage(child, 'ready', (host) =>
        host.postMessage({
          type: 'init',
          modelsPath: paths.model('asr.whisper-base-q8'),
          fetchedModelsPath: null,
          allowHighMemoryTier: false
        })
      )
      await check()
      const result = await childMessage(child, 1, (host) =>
        host.postMessage({ type: 'transcribe', id: 1, pcm: audio, language: 'en', task: 'transcribe' })
      )
      if (typeof result.text !== 'string' || !recognitionMatchesFixture(result.text))
        throw new Error('RUNTIME_SELF_TEST_RECOGNITION_MISMATCH')
      await check()
    }
  })
}

async function testSpeaker(
  lease: Awaited<ReturnType<typeof createRuntimeFeatureLeaseForVerifiedGeneration>>,
  pcm: ArrayBuffer,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>
): Promise<void> {
  await utilitySelfTest({
    lease,
    role: 'speaker-embedding-host',
    signal,
    assertCurrent,
    requests: async (child, paths, audio, check) => {
      const model = paths.members('speaker.embedding', 'speaker/embedding.onnx')
      await childMessage(child, 'warm', (host) => host.postMessage({ type: 'warmup', id: 'warm', model }))
      await check()
      const result = await childMessage(child, 'embed', (host) =>
        host.postMessage({ type: 'embed', id: 'embed', model, pcm: audio })
      )
      if (!(result.embedding instanceof ArrayBuffer)) throw new Error('RUNTIME_SELF_TEST_EMBEDDING_INVALID')
      const vector = new Float32Array(result.embedding)
      if (vector.length !== SPEAKER_EMBEDDING_DIMENSIONS || [...vector].some((value) => !Number.isFinite(value)))
        throw new Error('RUNTIME_SELF_TEST_EMBEDDING_INVALID')
      await check()
    }
  })
}

async function testRendererWhisper(
  lease: Awaited<ReturnType<typeof createRuntimeFeatureLeaseForVerifiedGeneration>>,
  pcm: ArrayBuffer,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>
): Promise<void> {
  let host: Awaited<ReturnType<typeof createRuntimeWhisperHost>>
  try {
    host = await createRuntimeWhisperHost({ lease, assertCurrent, assertAudioCurrent: assertCurrent })
  } catch (error) {
    if (error instanceof RetainedRuntimeWhisperHostError) throw new RetainedRuntimeCandidateSelfTestError(error)
    throw error
  }
  let failure: unknown
  try {
    const port = host.uiPort
    const ready = waitFor(
      new Promise<void>((resolve, reject) => {
        port.on('message', (event) => {
          const value = event.data as Response
          if (value?.type === 'ready') resolve()
          else if (value?.type === 'error') reject(new Error('RUNTIME_SELF_TEST_RENDERER_ERROR'))
        })
        port.start()
        port.postMessage({ type: 'init', quality: 'fast', language: 'en', resetFollow: true })
      })
    )
    await withAbort(ready, signal)
    await assertCurrent()
    if (signal.aborted) throw signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED')
    const response = waitFor(
      new Promise<string>((resolve, reject) => {
        port.on('message', (event) => {
          const value = event.data as { type?: string; text?: string }
          if (value?.type === 'text' && value.text) resolve(value.text)
          if (value?.type === 'error') reject(new Error('RUNTIME_SELF_TEST_RENDERER_ERROR'))
        })
        port.postMessage({ type: 'audio', audio: new Float32Array(pcm), speaker: 'you', partial: false })
      })
    )
    if (!recognitionMatchesFixture(await withAbort(response, signal)))
      throw new Error('RUNTIME_SELF_TEST_RECOGNITION_MISMATCH')
    await assertCurrent()
  } catch (error) {
    failure = error
  }
  try {
    await host.stop()
  } catch (error) {
    throw new RetainedRuntimeCandidateSelfTestError(error)
  }
  if (failure) throw failure
}

async function testLlama(
  lease: RuntimeFeatureLease,
  modelId: RuntimeModelId,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>
): Promise<void> {
  const executable = lease.entry('llama-server')
  const model = lease.modelFile(modelId, 'model.gguf')
  const key = randomBytes(32).toString('hex')
  if (signal.aborted) throw signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED')
  await assertCurrent()
  if (signal.aborted) throw signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED')
  const child: ChildProcess = spawn(
    executable,
    [
      '-m',
      model,
      '--no-mmproj',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '-c',
      '1024',
      '--parallel',
      '1',
      '--cache-ram',
      '32',
      '-ngl',
      '0',
      '-t',
      '2',
      '-tb',
      '2',
      '--threads-http',
      '2',
      '--no-ui',
      '--jinja',
      '--reasoning',
      'off'
    ],
    {
      cwd: lease.model(modelId),
      env: { ...runtimeHostEnvironment(lease), LLAMA_API_KEY: key },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  let port = 0
  let outputTail = ''
  const readPort = (chunk: Buffer): void => {
    outputTail = `${outputTail}${chunk.toString('utf8')}`.slice(-64 * 1024)
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(outputTail)
    if (match) port = Number(match[1])
  }
  let spawnFailed = false
  child.on('error', () => {
    spawnFailed = true
  })
  child.stdout?.on('data', readPort)
  child.stderr?.on('data', readPort)
  const exited = new Promise<void>((resolve) => child.once('close', resolve))
  let failure: unknown
  let exitUnconfirmed = false
  try {
    const deadline = Date.now() + 90_000
    while (!port && Date.now() < deadline) {
      if (signal.aborted) throw signal.reason ?? new Error('RUNTIME_SELF_TEST_CANCELLED')
      if (spawnFailed || child.exitCode !== null) throw new Error('RUNTIME_SELF_TEST_SERVER_EXITED')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!port) throw new Error('RUNTIME_SELF_TEST_SERVER_NOT_READY')
    await assertCurrent()
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages: [{ role: 'user', content: 'Reply with exactly the word READY.' }],
        max_tokens: 16,
        temperature: 0
      })
    })
    if (!response.ok) throw new Error('RUNTIME_SELF_TEST_SERVER_REQUEST_FAILED')
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (contentLength > 64 * 1024) throw new Error('RUNTIME_SELF_TEST_SERVER_RESPONSE_INVALID')
    await assertCurrent()
    const responseText = await response.text()
    if (responseText.length > 64 * 1024) throw new Error('RUNTIME_SELF_TEST_SERVER_RESPONSE_INVALID')
    const body = JSON.parse(responseText) as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !/\bREADY\b/i.test(content))
      throw new Error('RUNTIME_SELF_TEST_SERVER_RESPONSE_INVALID')
    await assertCurrent()
  } catch (error) {
    failure = error
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    try {
      await waitFor(exited)
    } catch {
      exitUnconfirmed = true
    }
  }
  if (exitUnconfirmed) throw new RetainedRuntimeCandidateSelfTestError(failure)
  if (failure) throw failure
}

export const runRuntimeCandidateSelfTest: RuntimeInstallSelfTest = async (input) => {
  await input.assertCurrent()
  const generation = verifiedGeneration(input)
  const lease = await createRuntimeFeatureLeaseForVerifiedGeneration(
    input.feature,
    input.target,
    generation,
    input.selectedModelId ?? undefined
  )
  let retained = false
  try {
    const fixture = await readPinnedFixtureFile(FIXTURE, SELF_TEST_FIXTURE)
    const pcm = parseFixturePcm(fixture)
    if (input.feature === 'offline-asr') {
      await testParakeet(lease, pcm, input.signal, input.assertCurrent)
      await input.assertCurrent()
      await testWhisperImport(lease, pcm, input.signal, input.assertCurrent)
      await input.assertCurrent()
      await testRendererWhisper(lease, pcm, input.signal, input.assertCurrent)
    } else if (input.feature === 'speaker-embedding') {
      await testSpeaker(lease, pcm, input.signal, input.assertCurrent)
    } else {
      if (!input.selectedModelId) throw new Error('RUNTIME_SELF_TEST_MODEL_NOT_SELECTED')
      await testLlama(lease, input.selectedModelId, input.signal, input.assertCurrent)
    }
    await input.assertCurrent()
  } catch (error) {
    if (error instanceof RetainedRuntimeCandidateSelfTestError) retained = true
    throw error
  } finally {
    if (!retained) await lease.release()
  }
}
