import { createHash } from 'node:crypto'
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSpeechPackInstallAdmission, resolveSpeechPackInstallAdmission } from './install-admission'
import { componentManifestIdentity } from './resolver'
import { rangeHandler, serve, type FixtureServer, type Handler } from './test-helpers/test-server.fixture'
import { prepareRuntimeOwnedTreeCreation } from '../../../infra/storage/runtime-owned-tree'
import type { RuntimeOwnedTreeWriter } from '../../../infra/storage/runtime-owned-tree-record'
import type { RuntimeOwnedTransferBounds } from '../../../infra/storage/runtime-owned-transfer'
import {
  createRuntimePayloadPlanIssuer,
  runtimePayloadPlanParentGraph
} from '../../../infra/storage/runtime-payload-plan'
import {
  captureRuntimeProfileParentPin,
  disposeRuntimeProfileParentPin
} from '../../../infra/storage/runtime-purpose-root'
import {
  captureRuntimePackNamespace,
  disposeRuntimePackNamespace,
  disposeRuntimeTreeParentPin,
  prepareRuntimeTreeParent
} from '../../../infra/storage/runtime-pack-namespace'
import {
  downloadVerifiedOwned,
  discardSpeechOwnedDownload,
  prepareSpeechOwnedDownload,
  resumeSpeechOwnedDownload,
  type OwnedDownloadNetworkDeps,
  type SpeechOwnedDownload
} from './owned-download'
import { PARAKEET_ARCHIVE_PIN, WHISPER_BASE_REVISION, speechPackFileUrl, type SpeechPackComponent } from './manifest'

const io = vi.hoisted(() => ({
  writeCount: 0,
  writeMaximum: 0,
  holdFirstWrite: false,
  firstWriteReached: null as (() => void) | null,
  releaseFirstWrite: null as Promise<void> | null,
  holdClose: false,
  closeReached: null as (() => void) | null,
  releaseClose: null as Promise<void> | null
}))
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  const write = ((...args: unknown[]) => {
    if (typeof args[5] !== 'function' || typeof args[1] === 'string')
      return Reflect.apply(original.write, undefined, args)
    io.writeCount++
    const delegated = [...args]
    if (io.writeMaximum > 0) delegated[3] = Math.min(Number(args[3]), io.writeMaximum)
    const perform = () => Reflect.apply(original.write, undefined, delegated)
    if (io.holdFirstWrite && io.writeCount === 1) {
      io.firstWriteReached?.()
      const release = io.releaseFirstWrite
      if (!release) throw new Error('OWNED_DOWNLOAD_WRITE_RELEASE_MISSING')
      void release.then(perform)
      return
    }
    return perform()
  }) as typeof original.write
  const close = ((fd: number, callback?: (error: NodeJS.ErrnoException | null) => void) => {
    if (!io.holdClose || !callback) return original.close(fd, callback)
    io.closeReached?.()
    const release = io.releaseClose
    if (!release) throw new Error('OWNED_DOWNLOAD_CLOSE_RELEASE_MISSING')
    void release.then(() => original.close(fd, callback))
  }) as typeof original.close
  return { ...original, close, write }
})

const catalog = vi.hoisted(() => ({ components: [] as SpeechPackComponent[], compiled: [] as SpeechPackComponent[] }))
vi.mock('./manifest', async (importOriginal) => {
  const original = await importOriginal<typeof import('./manifest')>()
  catalog.compiled = [...original.SPEECH_PACK_COMPONENTS]
  return { ...original, SPEECH_PACK_COMPONENTS: catalog.components }
})

const bounds: RuntimeOwnedTransferBounds = {
  maximumChunkBytes: 256 * 1024,
  maximumRequests: 12,
  maximumRestarts: 5,
  maximumHandovers: 2,
  pausedRetentionMs: 30_000
}
const payload = Buffer.from('a tiny pinned nested model file used only by owned transfer tests')
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
const servers: FixtureServer[] = []

async function waitForDiagnosticGate(promise: Promise<void>, name: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CONTROL_GATE_NOT_REACHED:${name}`)), 10_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fixture(
  options: {
    readonly body?: Buffer
    readonly pinBody?: Buffer
    readonly handler?: Parameters<typeof serve>[0]
    readonly files?: SpeechPackComponent['files']
    readonly beforePrepare?: (root: string) => Promise<void>
    readonly bounds?: RuntimeOwnedTransferBounds
    readonly component?: SpeechPackComponent
  } = {}
) {
  const body = options.body ?? payload
  const pinned = options.pinBody ?? body
  const activeServer = await serve(options.handler ?? rangeHandler(body))
  servers.push(activeServer)
  const sourceRevision = 'd'.repeat(40)
  const component: SpeechPackComponent =
    options.component ??
    Object.freeze({
      id: 'asr.whisper-base-q8',
      version: 'test-v1',
      source: Object.freeze({
        kind: 'files',
        baseUrl: `https://raw.githubusercontent.com/test/model/${sourceRevision}`
      }),
      files: Object.freeze(
        options.files ?? [
          { path: 'nested/model.bin', sourcePath: 'upstream/model.bin', bytes: pinned.byteLength, sha256: hash(pinned) }
        ]
      )
    })
  catalog.components.splice(0, catalog.components.length, component)
  const rawParent = await mkdtemp(join(tmpdir(), 'owned-speech-download-'))
  roots.push(rawParent)
  const original = await lstat(rawParent, { bigint: true })
  const parent = await realpath(rawParent)
  const canonical = await lstat(parent, { bigint: true })
  if (
    !original.isDirectory() ||
    !canonical.isDirectory() ||
    original.ino !== canonical.ino ||
    original.dev !== canonical.dev
  )
    throw new Error('OWNED_DOWNLOAD_TEST_ROOT_CHANGED')
  const packRoot = join(parent, 'speech-packs')
  const transaction = Symbol('owned-download-transaction')
  const manifestIdentity = componentManifestIdentity(component)
  const current = { value: true }
  const admission = () =>
    resolveSpeechPackInstallAdmission(
      createSpeechPackInstallAdmission({
        operation: 'install',
        componentId: component.id,
        manifestIdentity,
        resourcePolicyIdentity: 'owned-download-test-policy',
        transaction,
        assertCurrent: () => current.value,
        refreshCurrent: async () => current.value
      }),
      component.id,
      transaction
    )
  const issuer = createRuntimePayloadPlanIssuer()
  const plan = issuer.issue({
    componentId: component.id,
    componentVersion: component.version,
    manifestIdentity,
    resourcePolicyIdentity: 'owned-download-test-policy',
    rootRelativePath: `.staging/${component.id}/${component.version}`,
    files: component.files.map((file) => ({ relativePath: file.path, byteLength: file.bytes, sha256: file.sha256 })),
    admittedMaximumBytes: component.files.reduce((sum, file) => sum + file.bytes, 0),
    admittedMaximumFiles: component.files.length,
    admittedMaximumPathBytes: 1024
  })
  let profile: Awaited<ReturnType<typeof captureRuntimeProfileParentPin>> | undefined
  let namespace: Awaited<ReturnType<typeof captureRuntimePackNamespace>> | undefined
  let parentPin: Awaited<ReturnType<typeof prepareRuntimeTreeParent>> | undefined
  let writer: RuntimeOwnedTreeWriter | undefined
  try {
    profile = await captureRuntimeProfileParentPin({
      profilePath: parent,
      binding: {
        profileBinding: 'owned-download-test-profile',
        principalBinding: 'owned-download-test-user',
        persistentProfileGeneration: '1'
      },
      assertCurrentSync: () => undefined,
      assertProfilePhysicalCurrent: async () => undefined,
      assertSingleInstanceCurrentSync: () => undefined
    })
    namespace = await captureRuntimePackNamespace({ profile, mainPackRootPath: packRoot, mode: 'create-explicit' })
    parentPin = await prepareRuntimeTreeParent({
      namespace,
      relativeParent: runtimePayloadPlanParentGraph(plan).parentRelativePath,
      plan
    })
    writer = await prepareRuntimeOwnedTreeCreation({ parentPin, plan, assertCurrentSync: () => undefined })
    await writer.createRoot()
    const directories = new Set<string>()
    for (const file of component.files) {
      const segments = file.path.split('/')
      for (let index = 1; index < segments.length; index++) directories.add(segments.slice(0, index).join('/'))
    }
    for (const directory of [...directories].sort(
      (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)
    ))
      await writer.createDirectory(directory)
    if (options.beforePrepare) await options.beforePrepare(join(packRoot, '.staging', component.id, component.version))
    const download = await prepareSpeechOwnedDownload({
      admission: admission(),
      writer,
      plan,
      relativePath: component.files[0].path,
      bounds: options.bounds ?? bounds,
      assertCleanupCurrentSync: () => undefined
    })
    const network: OwnedDownloadNetworkDeps = {
      fetch: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const parsed = new URL(String(url))
        const local = `http://127.0.0.1:${new URL(activeServer.base).port}${parsed.pathname}${parsed.search}`
        return globalThis.fetch(local, init)
      }) as typeof fetch,
      random: () => 0.5,
      timing: {
        requestTimeoutMs: 2_000,
        idleTimeoutMs: 2_000,
        maxAttempts: 4,
        backoffBaseMs: 1,
        backoffCapMs: 10,
        retryAfterCapMs: 20
      }
    }
    return {
      component,
      body,
      writer,
      plan,
      download,
      network,
      admission,
      transaction,
      packRoot,
      activeServer,
      current,
      async dispose(token: SpeechOwnedDownload = download) {
        try {
          await discardSpeechOwnedDownload(token).settled
        } catch {
          /* writer remains the final owner */
        }
        await writer!.dispose()
        await disposeRuntimeTreeParentPin(parentPin!)
        await disposeRuntimePackNamespace(namespace!)
        await disposeRuntimeProfileParentPin(profile!)
      }
    }
  } catch (error) {
    if (writer) await writer.dispose().catch(() => undefined)
    if (parentPin) await disposeRuntimeTreeParentPin(parentPin).catch(() => undefined)
    if (namespace) await disposeRuntimePackNamespace(namespace).catch(() => undefined)
    if (profile) await disposeRuntimeProfileParentPin(profile).catch(() => undefined)
    throw error
  }
}

afterEach(async () => {
  io.writeCount = 0
  io.writeMaximum = 0
  io.holdFirstWrite = false
  io.firstWriteReached = null
  io.releaseFirstWrite = null
  io.holdClose = false
  io.closeReached = null
  io.releaseClose = null
  await Promise.all(servers.splice(0).map((server) => server.close()))
  catalog.components.length = 0
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('owned speech download', () => {
  it('binds compiled Whisper source paths pins and current admission before creation', async () => {
    const real = catalog.compiled.find((component) => component.id === 'asr.whisper-base-q8')
    expect(real).toBeDefined()
    const expected = [
      [
        'Xenova/whisper-base/config.json',
        'config.json',
        2248,
        'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b'
      ],
      [
        'Xenova/whisper-base/generation_config.json',
        'generation_config.json',
        3776,
        '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05'
      ],
      [
        'Xenova/whisper-base/merges.txt',
        'merges.txt',
        493869,
        '2df2990a395e35e8dfbc7511e08c12d56018d8d04691e0133e5d63b21e154dc6'
      ],
      [
        'Xenova/whisper-base/normalizer.json',
        'normalizer.json',
        52666,
        'bf1c507dc8724ca9cf9903640dacfb69dae2f00edee4f21ceba106a7392f26dd'
      ],
      [
        'Xenova/whisper-base/onnx/decoder_model_merged_quantized.onnx',
        'onnx/decoder_model_merged_quantized.onnx',
        53707539,
        'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861'
      ],
      [
        'Xenova/whisper-base/onnx/encoder_model_quantized.onnx',
        'onnx/encoder_model_quantized.onnx',
        23200850,
        '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9'
      ],
      [
        'Xenova/whisper-base/preprocessor_config.json',
        'preprocessor_config.json',
        339,
        'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'
      ],
      [
        'Xenova/whisper-base/special_tokens_map.json',
        'special_tokens_map.json',
        2194,
        'e67ae3a0aaa99abcd9f187138e12db1f65c16a14761c50ef10eef2c174a7a691'
      ],
      [
        'Xenova/whisper-base/tokenizer.json',
        'tokenizer.json',
        2480466,
        '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566'
      ],
      [
        'Xenova/whisper-base/tokenizer_config.json',
        'tokenizer_config.json',
        282683,
        '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce'
      ],
      [
        'Xenova/whisper-base/vocab.json',
        'vocab.json',
        1036584,
        '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a'
      ]
    ] as const
    expect(real!.files.map((file) => [file.path, file.sourcePath ?? file.path, file.bytes, file.sha256])).toEqual(
      expected
    )
    expect(real!.source.kind).toBe('files')
    if (real!.source.kind === 'files') {
      const baseUrl = real!.source.baseUrl
      expect(baseUrl).toBeTruthy()
      expect(real!.files.map((file) => `${baseUrl}/${file.sourcePath ?? file.path}`)).toEqual(
        expected.map(
          ([, sourcePath]) =>
            `https://huggingface.co/Xenova/whisper-base/resolve/${WHISPER_BASE_REVISION}/${sourcePath}`
        )
      )
    }
    const compiledTest = await fixture({ component: real! })
    try {
      let mapped = 0
      for (const file of real!.files) {
        const token =
          mapped === 0
            ? compiledTest.download
            : await prepareSpeechOwnedDownload({
                admission: compiledTest.admission(),
                writer: compiledTest.writer,
                plan: compiledTest.plan,
                relativePath: file.path,
                bounds,
                assertCleanupCurrentSync: () => undefined
              })
        let observed = ''
        await expect(
          downloadVerifiedOwned(
            {
              download: token,
              signal: new AbortController().signal,
              pauseSignal: new AbortController().signal,
              onProgress: () => undefined
            },
            {
              ...compiledTest.network,
              fetch: async (url) => {
                observed = String(url)
                throw new Error('H1_CAPTURED_COMPILED_URL')
              }
            }
          )
        ).rejects.toThrow('H1_CAPTURED_COMPILED_URL')
        expect(observed).toBe(speechPackFileUrl(real!, file))
        mapped++
      }
      expect(mapped).toBe(11)
      expect(compiledTest.activeServer.requests).toHaveLength(0)
    } finally {
      await compiledTest.dispose()
    }
    const test = await fixture()
    try {
      expect(test.component.files[0].sourcePath).toBe('upstream/model.bin')
      expect(componentManifestIdentity(test.component)).toMatch(/^[a-f0-9]{64}$/)
      const forged = { ...test.admission(), assertCurrent: () => undefined } as unknown as Parameters<
        typeof prepareSpeechOwnedDownload
      >[0]['admission']
      await expect(
        prepareSpeechOwnedDownload({
          admission: forged,
          writer: test.writer,
          plan: test.plan,
          relativePath: test.component.files[0].path,
          bounds,
          assertCleanupCurrentSync: () => undefined
        })
      ).rejects.toThrow('SPEECH_PACK_INSTALL_ADMISSION_INVALID')
      const wrongPlanIssuer = createRuntimePayloadPlanIssuer()
      const wrongPlan = wrongPlanIssuer.issue({
        componentId: test.component.id,
        componentVersion: test.component.version,
        manifestIdentity: 'f'.repeat(64),
        resourcePolicyIdentity: 'owned-download-test-policy',
        rootRelativePath: `.staging/${test.component.id}/${test.component.version}`,
        files: test.component.files.map((file) => ({
          relativePath: file.path,
          byteLength: file.bytes,
          sha256: file.sha256
        })),
        admittedMaximumBytes: test.component.files.reduce((sum, file) => sum + file.bytes, 0),
        admittedMaximumFiles: test.component.files.length,
        admittedMaximumPathBytes: 1024
      })
      await expect(
        prepareSpeechOwnedDownload({
          admission: test.admission(),
          writer: test.writer,
          plan: wrongPlan,
          relativePath: test.component.files[0].path,
          bounds,
          assertCleanupCurrentSync: () => undefined
        })
      ).rejects.toThrow('SPEECH_OWNED_DOWNLOAD_PLAN_IDENTITY_MISMATCH')
    } finally {
      await test.dispose()
    }
  })

  it('downloads actual HTTP bytes into a real nested owned tree', async () => {
    const test = await fixture()
    try {
      const outcome = await downloadVerifiedOwned(
        {
          download: test.download,
          signal: new AbortController().signal,
          pauseSignal: new AbortController().signal,
          onProgress: () => undefined
        },
        test.network
      )
      expect(outcome.status).toBe('verified')
      const requests = test.activeServer.requests.length
      const again = await downloadVerifiedOwned(
        {
          download: test.download,
          signal: new AbortController().signal,
          pauseSignal: new AbortController().signal,
          onProgress: () => undefined
        },
        test.network
      )
      expect(again).toEqual(outcome)
      expect(test.activeServer.requests).toHaveLength(requests)
      const receipt = await test.writer.seal()
      expect(receipt.manifest.entries.filter((entry) => entry.kind === 'file')).toHaveLength(1)
      expect(
        await readFile(
          join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin')
        )
      ).toEqual(payload)
    } finally {
      await test.dispose()
    }
  })

  it('resumes a thirty percent disconnect with exact Range and If Range', async () => {
    const body = Buffer.alloc(120_000, 0x47)
    const test = await fixture({ body, handler: rangeHandler(body, { cutFirstAt: 36_000 }) })
    try {
      const result = await downloadVerifiedOwned(
        {
          download: test.download,
          signal: new AbortController().signal,
          pauseSignal: new AbortController().signal,
          onProgress: () => undefined
        },
        test.network
      )
      expect(result.status).toBe('verified')
      expect(test.activeServer.requests.length).toBeGreaterThanOrEqual(2)
      expect(test.activeServer.requests[1].headers.range).toBe('bytes=36000-')
      expect(test.activeServer.requests[1].headers['if-range']).toBe('"v1"')
      const final = await readFile(
        join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin')
      )
      expect(final).toEqual(body)
      expect(hash(final)).toBe(hash(body))
    } finally {
      await test.dispose()
    }
  })

  it('settles a ranged 200 response before an owned restart', async () => {
    const body = Buffer.alloc(40_000, 0x38)
    const test = await fixture({ body, handler: rangeHandler(body, { cutFirstAt: 12_000, ignoreRange: true }) })
    let reached: (() => void) | undefined, release: (() => void) | undefined
    const cancelReached = new Promise<void>((resolve) => {
      reached = resolve
    })
    const cancelGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ranges: (string | null)[] = []
    const wrappedFetch: typeof fetch = async (url, init) => {
      ranges.push(new Headers(init?.headers).get('range'))
      if (ranges.length === 2) {
        const held = new ReadableStream<Uint8Array>({
          cancel() {
            reached?.()
            return cancelGate
          }
        })
        return new Response(held, { status: 200, headers: { etag: '"v1"' } })
      }
      return test.network.fetch(url, init)
    }
    try {
      const operation = downloadVerifiedOwned(
        {
          download: test.download,
          signal: new AbortController().signal,
          pauseSignal: new AbortController().signal,
          onProgress: () => undefined
        },
        { ...test.network, fetch: wrappedFetch }
      )
      void operation.catch(() => undefined)
      await cancelReached
      expect(ranges).toEqual([null, 'bytes=12000-'])
      expect(
        await readFile(
          join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin.partial')
        )
      ).toEqual(body.subarray(0, 12_000))
      release?.()
      const result = await operation
      expect(result.status).toBe('verified')
      expect(ranges).toEqual([null, 'bytes=12000-', null])
      expect(
        await readFile(
          join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin')
        )
      ).toEqual(body)
    } finally {
      release?.()
      await test.dispose()
    }
  })

  it('restarts changed validators invalid ranges and 416 under finite budgets', async () => {
    const body = Buffer.alloc(50_000, 0x41)
    const prefix = body.subarray(0, 10_000)
    const controlledCut = (next: Handler) => {
      let disconnectFirst: (() => void) | null = null
      const handler: Handler = (req, res, index) => {
        if (index !== 0) return next(req, res, index)
        res.statusCode = 200
        res.setHeader('content-type', 'application/octet-stream')
        res.setHeader('etag', '"v1"')
        res.setHeader('content-length', String(body.length))
        disconnectFirst = () => res.destroy()
        res.write(prefix)
      }
      return {
        handler,
        disconnect(required = true) {
          if (!disconnectFirst) {
            if (required) throw new Error('H05_FIRST_RESPONSE_NOT_OPEN')
            return
          }
          disconnectFirst()
        }
      }
    }
    const readOwnedPrefix = async (path: string): Promise<Buffer> => {
      const handle = await open(path, 'r')
      try {
        const stat = await handle.stat()
        if (stat.size !== prefix.byteLength) throw new Error('H05_PREFIX_SIZE_NOT_ACKNOWLEDGED')
        const bytes = Buffer.alloc(prefix.byteLength)
        let offset = 0
        while (offset < bytes.byteLength) {
          const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
          if (result.bytesRead === 0) throw new Error('H05_PREFIX_READ_SHORT')
          offset += result.bytesRead
        }
        return bytes
      } finally {
        await handle.close()
      }
    }
    const progressGate = () => {
      let resolve: (() => void) | null = null
      const reached = new Promise<void>((done) => {
        resolve = done
      })
      return {
        reached,
        acknowledge(bytes: number) {
          if (bytes === prefix.byteLength) resolve?.()
        }
      }
    }
    const invalid416: Handler = (_req, res, index) => {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('etag', '"v1"')
      if (index === 0) {
        res.statusCode = 200
        res.write(body.subarray(0, 10_000), () => res.destroy())
        return
      }
      if (index === 1) {
        res.statusCode = 416
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('content-length', String(body.length))
      res.end(body)
    }
    const badResume =
      (kind: 'invalid-range' | 'missing-validator'): Handler =>
      (_req, res, index) => {
        if (index === 0) {
          res.statusCode = 200
          res.setHeader('etag', '"v1"')
          res.setHeader('content-length', String(body.length))
          res.write(body.subarray(0, 10_000))
          setTimeout(() => res.destroy(), 20)
          return
        }
        if (index === 1) {
          res.statusCode = 206
          if (kind !== 'missing-validator') res.setHeader('etag', '"v1"')
          res.setHeader(
            'content-range',
            kind === 'invalid-range'
              ? `bytes 9999-${body.length - 1}/${body.length}`
              : `bytes 10000-${body.length - 1}/${body.length}`
          )
          res.end(body.subarray(10_000))
          return
        }
        res.statusCode = 200
        res.setHeader('etag', '"v1"')
        res.end(body)
      }
    const cases: { readonly name: string; readonly handler: Handler }[] = [
      { name: 'changed validator', handler: rangeHandler(body, { cutFirstAt: 10_000, changeValidatorOnResume: true }) },
      { name: 'range 416', handler: invalid416 },
      { name: 'invalid range', handler: badResume('invalid-range') },
      { name: 'missing validator', handler: badResume('missing-validator') }
    ]
    let executed = 0
    for (const { name, handler } of cases) {
      const cut = controlledCut(handler)
      const test = await fixture({ body, handler: cut.handler })
      const progress = progressGate()
      let operation: ReturnType<typeof downloadVerifiedOwned> | null = null
      try {
        operation = downloadVerifiedOwned(
          {
            download: test.download,
            signal: new AbortController().signal,
            pauseSignal: new AbortController().signal,
            onProgress: progress.acknowledge
          },
          test.network
        )
        void operation.catch(() => undefined)
        await waitForDiagnosticGate(progress.reached, `${name}-10k-progress`)
        const partialPath = join(
          test.packRoot,
          '.staging',
          test.component.id,
          test.component.version,
          'nested',
          'model.bin.partial'
        )
        expect(await readOwnedPrefix(partialPath), `${name}-owned-prefix`).toEqual(prefix)
        cut.disconnect()
        const result = await operation
        expect(result.status).toBe('verified')
        expect(test.activeServer.requests.length, name).toBe(3)
        expect(test.activeServer.requests[1].headers.range, name).toBe('bytes=10000-')
        expect(test.activeServer.requests[1].headers['if-range'], name).toBe('"v1"')
        expect(test.activeServer.requests[2].headers.range, name).toBeUndefined()
        expect(
          await readFile(
            join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin')
          )
        ).toEqual(body)
        executed++
      } finally {
        cut.disconnect(false)
        await operation?.catch(() => undefined)
        await test.dispose()
      }
    }
    expect(executed).toBe(cases.length)
    // A short first response consumes one transient attempt. The 416 consumes the second;
    // the independent request/restart caps are deliberately higher, so neither can mask it.
    let releaseSecond416!: () => void
    const second416Gate = new Promise<void>((resolve) => {
      releaseSecond416 = resolve
    })
    let secondReached: (() => void) | null = null
    const secondRequestReached = new Promise<void>((resolve) => {
      secondReached = resolve
    })
    let secondResponseStatus: number | null = null
    let secondResponseSent = false
    const budgetHandler: Handler = (req, res, index) => {
      if (index !== 1) return invalid416(req, res, index)
      res.statusCode = 416
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('etag', '"v1"')
      secondResponseStatus = res.statusCode
      secondReached?.()
      void second416Gate.then(() => {
        res.end()
        secondResponseSent = true
      })
    }
    const cut = controlledCut(budgetHandler)
    const exhausted = await fixture({ body, handler: cut.handler })
    const progress = progressGate()
    let operation: Promise<{ status: string | null; error: string | null }> | null = null
    try {
      operation = downloadVerifiedOwned(
        {
          download: exhausted.download,
          signal: new AbortController().signal,
          pauseSignal: new AbortController().signal,
          onProgress: progress.acknowledge
        },
        { ...exhausted.network, timing: { ...exhausted.network.timing, maxAttempts: 2 } }
      ).then(
        (result) => ({ status: result.status, error: null }),
        (error: unknown) => ({
          status: null,
          error:
            error instanceof Error && error.message === 'SPEECH_OWNED_DOWNLOAD_NETWORK_RETRY_EXHAUSTED'
              ? error.message
              : 'UNEXPECTED_TERMINAL_ERROR'
        })
      )
      await waitForDiagnosticGate(progress.reached, 'budget-10k-progress')
      const partialPath = join(
        exhausted.packRoot,
        '.staging',
        exhausted.component.id,
        exhausted.component.version,
        'nested',
        'model.bin.partial'
      )
      const prefixReadback = await readOwnedPrefix(partialPath)
      expect(prefixReadback, 'H05_BUDGET_OWNED_PREFIX').toEqual(prefix)
      cut.disconnect()
      await waitForDiagnosticGate(secondRequestReached, 'budget-second-416')
      const second = exhausted.activeServer.requests[1]
      const before416 = {
        requests: exhausted.activeServer.requests.length,
        range: second?.headers.range,
        ifRange: second?.headers['if-range'],
        responseStatus: secondResponseStatus
      }
      releaseSecond416()
      const outcome = await operation
      expect(
        { prefixReadback, before416, secondResponseSent, requests: exhausted.activeServer.requests.length, outcome },
        'H05_INDEPENDENT_TRANSIENT_BUDGET'
      ).toEqual({
        prefixReadback: prefix,
        before416: { requests: 2, range: 'bytes=10000-', ifRange: '"v1"', responseStatus: 416 },
        secondResponseSent: true,
        requests: 2,
        outcome: { status: null, error: 'SPEECH_OWNED_DOWNLOAD_NETWORK_RETRY_EXHAUSTED' }
      })
    } finally {
      releaseSecond416()
      cut.disconnect(false)
      await operation?.catch(() => undefined)
      await exhausted.dispose()
    }
  })

  it('retries one full digest mismatch and rejects the second', async () => {
    const body = Buffer.alloc(payload.length, 0x5a)
    const test = await fixture({ body, pinBody: payload })
    try {
      await expect(
        downloadVerifiedOwned(
          {
            download: test.download,
            signal: new AbortController().signal,
            pauseSignal: new AbortController().signal,
            onProgress: () => undefined
          },
          test.network
        )
      ).rejects.toThrow('RUNTIME_TRANSFER_DIGEST_MISMATCH')
      expect(test.activeServer.requests).toHaveLength(2)
      await expect(
        lstat(join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await test.dispose()
    }
  })

  it('rejects excess bytes before any part of the excess chunk is written', async () => {
    let activeResponse: Parameters<Handler>[1] | null = null
    const test = await fixture({
      handler: (_req, res) => {
        activeResponse = res
        res.statusCode = 200
        res.setHeader('transfer-encoding', 'chunked')
        res.write(payload)
      }
    })
    let reached: (() => void) | undefined, release: (() => void) | undefined
    const closeReached = new Promise<void>((resolve) => {
      reached = resolve
    })
    const closeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    io.holdClose = true
    io.closeReached = () => reached?.()
    io.releaseClose = closeGate
    try {
      const operation = downloadVerifiedOwned(
        {
          download: test.download,
          signal: new AbortController().signal,
          pauseSignal: new AbortController().signal,
          onProgress: (bytes) => {
            if (bytes === payload.byteLength && activeResponse) {
              activeResponse.end('excess')
              activeResponse = null
            }
          }
        },
        test.network
      )
      void operation.catch(() => undefined)
      await closeReached
      expect(
        await readFile(
          join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin.partial')
        )
      ).toEqual(payload)
      release?.()
      await expect(operation).rejects.toThrow('SPEECH_OWNED_DOWNLOAD_EXCESS_BYTES')
      expect(io.writeCount).toBeGreaterThan(0)
      await expect(
        lstat(join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin.partial'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      ;(activeResponse as Parameters<Handler>[1] | null)?.end()
      release?.()
      io.holdClose = false
      await test.dispose()
    }
  })

  it('rejects oversized transport chunks without buffering or writing them', async () => {
    const test = await fixture()
    const oversized: typeof fetch = async () =>
      new Response(new Uint8Array(bounds.maximumChunkBytes + 1), {
        status: 200,
        headers: { 'content-length': String(payload.length), etag: '"v1"' }
      })
    try {
      const unboundedHeader: typeof fetch = async (...args) => {
        const response = await oversized(...args)
        const headers = new Headers(response.headers)
        headers.delete('content-length')
        return new Response(response.body, { status: response.status, headers })
      }
      await expect(
        downloadVerifiedOwned(
          {
            download: test.download,
            signal: new AbortController().signal,
            pauseSignal: new AbortController().signal,
            onProgress: () => undefined
          },
          { ...test.network, fetch: unboundedHeader }
        )
      ).rejects.toThrow('SPEECH_OWNED_DOWNLOAD_CHUNK_LIMIT')
      expect(io.writeCount).toBe(0)
      await expect(
        lstat(join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin.partial'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await test.dispose()
    }
  })

  it('rejects captive HTML mutable redirects and HTTPS downgrade', async () => {
    const handlers: { readonly handler: Handler; readonly expected: string }[] = [
      {
        handler: (_req, res) => {
          res.statusCode = 200
          res.setHeader('content-type', 'text/html')
          res.end('<html>login</html>')
        },
        expected: 'SPEECH_OWNED_DOWNLOAD_CAPTIVE_HTML'
      },
      {
        handler: (_req, res) => {
          res.statusCode = 302
          res.setHeader('location', 'https://example.com/refs/heads/main/model.bin')
          res.end()
        },
        expected: 'SPEECH_OWNED_DOWNLOAD_MUTABLE_REDIRECT'
      },
      {
        handler: (_req, res) => {
          res.statusCode = 302
          res.setHeader('location', 'http://example.com/model.bin')
          res.end()
        },
        expected: 'SPEECH_OWNED_DOWNLOAD_HTTPS_DOWNGRADE'
      },
      {
        handler: (_req, res) => {
          res.statusCode = 200
          res.setHeader('transfer-encoding', 'chunked')
          res.write('   <!doc')
          res.end('type html><html>login</html>')
        },
        expected: 'SPEECH_OWNED_DOWNLOAD_CAPTIVE_PREFIX'
      },
      {
        handler: (_req, res) => {
          res.statusCode = 302
          res.setHeader('location', 'https://access.cloudflare.com/login')
          res.end()
        },
        expected: 'SPEECH_OWNED_DOWNLOAD_CAPTIVE_REDIRECT'
      },
      {
        handler: (req, res) => {
          res.statusCode = 302
          res.setHeader('location', `https://raw.githubusercontent.com${req.url}`)
          res.end()
        },
        expected: 'SPEECH_OWNED_DOWNLOAD_REDIRECT_LIMIT'
      }
    ]
    let executed = 0
    for (const { handler, expected } of handlers) {
      const test = await fixture({ handler })
      const writes = io.writeCount
      try {
        await expect(
          downloadVerifiedOwned(
            {
              download: test.download,
              signal: new AbortController().signal,
              pauseSignal: new AbortController().signal,
              onProgress: () => undefined
            },
            test.network
          )
        ).rejects.toThrow(expected)
        expect(io.writeCount, expected).toBe(writes)
        executed++
      } finally {
        await test.dispose()
      }
    }
    expect(executed).toBe(handlers.length)
  })

  it('honors bounded Retry After and cancels its backoff timer', async () => {
    const test = await fixture({
      handler: (_req, res) => {
        res.statusCode = 429
        res.setHeader('retry-after', '3600')
        res.end()
      }
    })
    vi.useFakeTimers()
    const controller = new AbortController()
    try {
      let calls = 0
      let release: (() => void) | undefined
      const firstReached = new Promise<void>((resolve) => {
        release = resolve
      })
      const retryAfterFetch: typeof fetch = async () => {
        calls++
        release?.()
        return new Response(null, { status: 429, headers: { 'retry-after': '3600' } })
      }
      const operation = downloadVerifiedOwned(
        {
          download: test.download,
          signal: controller.signal,
          pauseSignal: new AbortController().signal,
          onProgress: () => undefined
        },
        { ...test.network, fetch: retryAfterFetch }
      )
      await firstReached
      await Promise.resolve()
      await Promise.resolve()
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      controller.abort()
      const result = await operation
      expect(result.status).toBe('cancelled')
      expect(calls).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      await test.dispose()
    }
  })

  it('settles held HTTP reads and disk writes before reporting pause', async () => {
    const test = await fixture()
    const pause = new AbortController()
    let releaseRead: (() => void) | undefined
    let reportPull: (() => void) | undefined
    const pulled = new Promise<void>((resolve) => {
      reportPull = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    try {
      const heldBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          reportPull?.()
          return readGate.then(() => {
            controller.enqueue(test.body)
            controller.close()
          })
        }
      })
      const heldFetch: typeof fetch = async () => new Response(heldBody, { status: 200, headers: { etag: '"v1"' } })
      let settled = false
      const operation = downloadVerifiedOwned(
        {
          download: test.download,
          signal: new AbortController().signal,
          pauseSignal: pause.signal,
          onProgress: () => undefined
        },
        { ...test.network, fetch: heldFetch }
      ).finally(() => {
        settled = true
      })
      await pulled
      pause.abort()
      await Promise.resolve()
      expect(settled).toBe(false)
      releaseRead?.()
      const result = await operation
      expect(result.status).toBe('paused')
      if (result.status === 'paused') {
        const nextAdmission = test.admission()
        await resumeSpeechOwnedDownload({
          download: test.download,
          suspended: result.suspended,
          admission: nextAdmission
        })
        const resumed = await downloadVerifiedOwned(
          {
            download: test.download,
            signal: new AbortController().signal,
            pauseSignal: new AbortController().signal,
            onProgress: () => undefined
          },
          test.network
        )
        expect(resumed.status).toBe('verified')
        expect(
          await readFile(
            join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin')
          )
        ).toEqual(test.body)
      }
    } finally {
      releaseRead?.()
      await test.dispose()
    }
    const diskBody = Buffer.alloc(2048, 0x4b)
    const disk = await fixture({ body: diskBody })
    const diskPause = new AbortController()
    let reportWrite: (() => void) | undefined, releaseWrite: (() => void) | undefined
    const writeReached = new Promise<void>((resolve) => {
      reportWrite = resolve
    })
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    io.writeCount = 0
    io.writeMaximum = 4
    io.holdFirstWrite = true
    io.firstWriteReached = () => reportWrite?.()
    io.releaseFirstWrite = writeGate
    try {
      let settled = false
      const operation = downloadVerifiedOwned(
        {
          download: disk.download,
          signal: new AbortController().signal,
          pauseSignal: diskPause.signal,
          onProgress: () => undefined
        },
        disk.network
      ).finally(() => {
        settled = true
      })
      void operation.catch(() => undefined)
      await writeReached
      diskPause.abort()
      await Promise.resolve()
      expect(settled).toBe(false)
      releaseWrite?.()
      const result = await operation
      expect(result.status).toBe('paused')
      expect(io.writeCount).toBe(1)
      expect(
        await readFile(
          join(disk.packRoot, '.staging', disk.component.id, disk.component.version, 'nested', 'model.bin.partial')
        )
      ).toEqual(diskBody.subarray(0, 4))
      io.holdFirstWrite = false
      io.writeMaximum = 0
      if (result.status === 'paused') {
        await resumeSpeechOwnedDownload({
          download: disk.download,
          suspended: result.suspended,
          admission: disk.admission()
        })
        const resumed = await downloadVerifiedOwned(
          {
            download: disk.download,
            signal: new AbortController().signal,
            pauseSignal: new AbortController().signal,
            onProgress: () => undefined
          },
          disk.network
        )
        expect(resumed.status).toBe('verified')
        expect(
          await readFile(
            join(disk.packRoot, '.staging', disk.component.id, disk.component.version, 'nested', 'model.bin')
          )
        ).toEqual(diskBody)
      }
    } finally {
      releaseWrite?.()
      io.holdFirstWrite = false
      io.writeMaximum = 0
      await disk.dispose()
    }
  })

  it('retains the live transaction while cancel cleanup is pending', async () => {
    const test = await fixture()
    let reportClose: (() => void) | undefined, releaseClose: (() => void) | undefined
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    let reportCancel: (() => void) | undefined, releaseCancel: (() => void) | undefined
    const reached = new Promise<void>((resolve) => {
      reportClose = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    const cancelReached = new Promise<void>((resolve) => {
      reportCancel = resolve
    })
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    io.holdClose = true
    io.closeReached = () => reportClose?.()
    io.releaseClose = gate
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller
        },
        cancel() {
          reportCancel?.()
          return cancelGate
        }
      })
      const run = downloadVerifiedOwned(
        {
          download: test.download,
          signal: new AbortController().signal,
          pauseSignal: new AbortController().signal,
          onProgress: () => undefined
        },
        { ...test.network, fetch: async () => new Response(body, { status: 200, headers: { etag: '"v1"' } }) }
      )
      await vi.waitFor(() => expect(body.locked).toBe(true))
      const cleanup = discardSpeechOwnedDownload(test.download)
      const repeatedCleanup = discardSpeechOwnedDownload(test.download)
      expect(cleanup.status).toBe('pending-cleanup')
      bodyController?.enqueue(Buffer.from('x'))
      await cancelReached
      let settled = false
      void cleanup.settled.finally(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      releaseCancel?.()
      await reached
      await Promise.resolve()
      expect(settled).toBe(false)
      await expect(test.writer.seal()).rejects.toThrow('RUNTIME_TREE_TRANSFER_ACTIVE')
      releaseClose?.()
      expect(await cleanup.settled).toEqual({ status: 'removed' })
      expect(await repeatedCleanup.settled).toEqual({ status: 'removed' })
      expect((await run).status).toBe('cancelled')
      expect(repeatedCleanup.settled, 'H12_ONE_NETWORK_TERMINAL_SETTLEMENT').toBe(cleanup.settled)
    } finally {
      try {
        bodyController?.close()
      } catch {
        /* cancelled */
      }
      releaseCancel?.()
      releaseClose?.()
      io.holdClose = false
      await test.dispose()
    }
  })

  it('rejects action revocation after fetch read and redirect awaits', async () => {
    const test = await fixture()
    try {
      const revokingFetch: typeof fetch = async (...args) => {
        const response = await test.network.fetch(...args)
        test.current.value = false
        return response
      }
      await expect(
        downloadVerifiedOwned(
          {
            download: test.download,
            signal: new AbortController().signal,
            pauseSignal: new AbortController().signal,
            onProgress: () => undefined
          },
          { ...test.network, fetch: revokingFetch }
        )
      ).rejects.toThrow('SPEECH_PACK_INSTALL_ADMISSION_EXPIRED')
      expect(test.activeServer.requests).toHaveLength(1)
      await expect(
        lstat(join(test.packRoot, '.staging', test.component.id, test.component.version, 'nested', 'model.bin.partial'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await test.dispose()
    }
    const readTest = await fixture()
    try {
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller
        }
      })
      const operation = downloadVerifiedOwned(
        {
          download: readTest.download,
          signal: new AbortController().signal,
          pauseSignal: new AbortController().signal,
          onProgress: () => undefined
        },
        { ...readTest.network, fetch: async () => new Response(body, { status: 200, headers: { etag: '"v1"' } }) }
      )
      await vi.waitFor(() => expect(body.locked).toBe(true))
      readTest.current.value = false
      bodyController?.enqueue(payload)
      bodyController?.close()
      await expect(operation).rejects.toThrow('SPEECH_PACK_INSTALL_ADMISSION_EXPIRED')
      expect(io.writeCount).toBe(0)
    } finally {
      await readTest.dispose()
    }
    const redirectTest = await fixture()
    try {
      let requests = 0
      const redirectFetch: typeof fetch = async () => {
        requests++
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            redirectTest.current.value = false
          }
        })
        return new Response(body, {
          status: 302,
          headers: {
            location: 'https://raw.githubusercontent.com/test/model/' + 'd'.repeat(40) + '/upstream/model.bin'
          }
        })
      }
      await expect(
        downloadVerifiedOwned(
          {
            download: redirectTest.download,
            signal: new AbortController().signal,
            pauseSignal: new AbortController().signal,
            onProgress: () => undefined
          },
          { ...redirectTest.network, fetch: redirectFetch }
        )
      ).rejects.toThrow('SPEECH_PACK_INSTALL_ADMISSION_EXPIRED')
      expect(requests).toBe(1)
    } finally {
      await redirectTest.dispose()
    }
    const stoppedRedirect = await fixture()
    let stopRequests = 0
    let reportCancel!: () => void
    let releaseCancel!: () => void
    const cancelReached = new Promise<void>((resolve) => {
      reportCancel = resolve
    })
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    const stopping = new AbortController()
    try {
      const fetchIgnoringAbort: typeof fetch = async () => {
        stopRequests++
        if (stopRequests === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                reportCancel()
                return cancelGate
              }
            }),
            {
              status: 302,
              headers: {
                location: 'https://raw.githubusercontent.com/test/model/' + 'd'.repeat(40) + '/upstream/model.bin'
              }
            }
          )
        }
        return new Response(payload, { status: 200, headers: { etag: '"v1"' } })
      }
      const operation = downloadVerifiedOwned(
        {
          download: stoppedRedirect.download,
          signal: stopping.signal,
          pauseSignal: new AbortController().signal,
          onProgress: () => undefined
        },
        { ...stoppedRedirect.network, fetch: fetchIgnoringAbort }
      )
      const observedOperation = operation.then(
        (result) => result.status,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      await waitForDiagnosticGate(cancelReached, 'held-redirect-cancel')
      stopping.abort()
      releaseCancel()
      const outcome = await observedOperation
      expect({ stopRequests, outcome, writes: io.writeCount }, 'H13_STOP_DURING_HELD_REDIRECT_CANCEL').toEqual({
        stopRequests: 1,
        outcome: 'cancelled',
        writes: 0
      })
    } finally {
      releaseCancel()
      await stoppedRedirect.dispose()
    }
  })

  it('does not adopt cold partials metadata or a forged target', async () => {
    const test = await fixture()
    const forged = Object.freeze({}) as SpeechOwnedDownload
    try {
      expect(() =>
        downloadVerifiedOwned(
          {
            download: forged,
            signal: new AbortController().signal,
            pauseSignal: new AbortController().signal,
            onProgress: () => undefined
          },
          test.network
        )
      ).toThrow('SPEECH_OWNED_DOWNLOAD_TOKEN_INVALID')
      expect(test.activeServer.requests).toHaveLength(0)
    } finally {
      await test.dispose()
    }
    let checked = 0
    for (const name of ['model.bin.partial', 'model.bin.partial.json']) {
      let coldPath = ''
      const foreign = Buffer.from(`cold-${name}`)
      await expect(
        fixture({
          beforePrepare: async (root) => {
            coldPath = join(root, 'nested', name)
            await writeFile(coldPath, foreign, { flag: 'wx' })
          }
        })
      ).rejects.toThrow('RUNTIME_PHYSICAL_CLOSURE_CHANGED')
      expect(await readFile(coldPath)).toEqual(foreign)
      checked++
    }
    expect(checked).toBe(2)
  })

  it('bounds total requests restarts and retries despite intermittent progress', async () => {
    const body = Buffer.alloc(80_000, 0x61)
    const finiteBounds = { ...bounds, maximumRequests: 3 }
    const test = await fixture({
      body,
      bounds: finiteBounds,
      handler: (req, res) => {
        const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0)
        res.statusCode = start > 0 ? 206 : 200
        res.setHeader('etag', '"v1"')
        res.setHeader('content-type', 'application/octet-stream')
        res.setHeader('content-length', String(body.length - start))
        if (start > 0) res.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`)
        res.write(body.subarray(start, start + 1000))
        setTimeout(() => res.destroy(), 20)
      }
    })
    try {
      await expect(
        downloadVerifiedOwned(
          {
            download: test.download,
            signal: new AbortController().signal,
            pauseSignal: new AbortController().signal,
            onProgress: () => undefined
          },
          { ...test.network, timing: { ...test.network.timing, maxAttempts: 3 } }
        )
      ).rejects.toThrow('SPEECH_OWNED_DOWNLOAD_NETWORK_RETRY_EXHAUSTED')
      expect(test.activeServer.requests).toHaveLength(3)
      expect(test.activeServer.requests[1].headers.range).toBe('bytes=1000-')
    } finally {
      await test.dispose()
    }
  })

  it('keeps archive pins null and never publishes engine readiness', async () => {
    const test = await fixture()
    try {
      expect(PARAKEET_ARCHIVE_PIN).toBeNull()
      expect(catalog.compiled.find((component) => component.id === 'asr.parakeet-tdt-0.6b-v3-int8')?.source.kind).toBe(
        'files'
      )
      await expect(
        fixture({
          component: {
            ...test.component,
            source: { kind: 'archive', archive: null, entryPrefix: '', extractCapBytes: 1024 }
          }
        })
      ).rejects.toThrow('SPEECH_OWNED_DOWNLOAD_SOURCE_UNAVAILABLE')
      const result = await downloadVerifiedOwned(
        {
          download: test.download,
          signal: new AbortController().signal,
          pauseSignal: new AbortController().signal,
          onProgress: () => undefined
        },
        test.network
      )
      expect(result.status).toBe('verified')
      await expect(lstat(join(test.packRoot, test.component.id, 'active.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await test.dispose()
    }
  })
})
