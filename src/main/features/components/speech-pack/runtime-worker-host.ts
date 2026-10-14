import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { BrowserWindow, MessageChannelMain, app, session, webContents } from 'electron'
import { createRuntimeResourceProtocol, type HostAsset } from './runtime-resource-protocol'
import type { RuntimeFeatureLease } from './runtime-lease'

const SCHEME = 'metis-runtime'
const HOST_CHANNEL = 'metis-runtime-host-channel'
const HOST_STOP = 'metis-runtime-host-stop'
const MAX_HOST_ASSETS_BYTES = 4 * 1024 * 1024
const STOP_BARRIER_MS = 15_000

let hostAssetsPromise: Promise<Readonly<Record<string, HostAsset>>> | null = null

async function readBoundedHostAsset(path: string): Promise<Buffer> {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error('RUNTIME_HOST_ASSET_OPEN_UNAVAILABLE')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(MAX_HOST_ASSETS_BYTES) ||
      !named.isFile() ||
      named.nlink !== 1n ||
      named.ino !== before.ino ||
      named.dev !== before.dev
    ) {
      throw new Error('RUNTIME_HOST_ASSET_INVALID')
    }
    const chunks: Buffer[] = []
    let total = 0
    let position = 0
    while (total <= MAX_HOST_ASSETS_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_HOST_ASSETS_BYTES + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const namedAfter = await lstat(path, { bigint: true })
    if (
      total > MAX_HOST_ASSETS_BYTES ||
      BigInt(total) !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      namedAfter.ino !== before.ino ||
      namedAfter.dev !== before.dev ||
      namedAfter.size !== before.size ||
      namedAfter.mtimeNs !== before.mtimeNs ||
      namedAfter.ctimeNs !== before.ctimeNs
    ) {
      throw new Error('RUNTIME_HOST_ASSET_CHANGED')
    }
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RUNTIME_HOST_EXIT_UNCONFIRMED')), ms)
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

async function readHostAssets(): Promise<Readonly<Record<string, HostAsset>>> {
  if (!app.isPackaged) throw new Error('RUNTIME_HOST_PACKAGE_REQUIRED')
  const rendererRoot = resolve(app.getAppPath(), 'out', 'renderer')
  const htmlPath = join(rendererRoot, 'runtime-worker-host.html')
  const html = await readBoundedHostAsset(htmlPath)
  const htmlText = html.toString('utf8')
  const script = /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/.exec(htmlText)?.[1]
  if (
    !script ||
    !script.startsWith('/assets/') ||
    script.includes('..') ||
    script.includes('%') ||
    script.includes('\\')
  ) {
    throw new Error('RUNTIME_HOST_ASSET_INVALID')
  }
  const scriptRelative = script.slice(1)
  const scriptPath = resolve(rendererRoot, scriptRelative)
  const scriptFromRoot = relative(rendererRoot, scriptPath)
  if (!scriptFromRoot || scriptFromRoot === '..' || scriptFromRoot.startsWith(`..${sep}`)) {
    throw new Error('RUNTIME_HOST_ASSET_INVALID')
  }
  const scriptBytes = await readBoundedHostAsset(scriptPath)
  return Object.freeze({
    '/host/index.html': Object.freeze({
      bytes: html,
      contentType: 'text/html; charset=utf-8',
      contentSecurityPolicy:
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'none'; img-src 'none'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    }),
    [`/${scriptRelative}`]: Object.freeze({ bytes: scriptBytes, contentType: 'text/javascript; charset=utf-8' })
  })
}

export interface RuntimeWhisperHost {
  readonly sessionId: string
  readonly generationIdentity: string
  readonly uiPort: Electron.MessagePortMain
  /** Resolves only after the renderer exit and resource revoke barriers release the lease. */
  readonly settled: Promise<void>
  stop(): Promise<void>
}

export class RetainedRuntimeWhisperHostError extends Error {
  readonly host: RuntimeWhisperHost

  constructor(host: RuntimeWhisperHost) {
    super('RUNTIME_HOST_EXIT_UNOBSERVED')
    this.host = host
  }
}

const unconfirmedRuntimeHosts = new Set<RuntimeWhisperHost>()

function samePidAsOtherContents(host: Electron.WebContents): boolean {
  const pid = host.getOSProcessId()
  return (
    pid <= 0 ||
    webContents
      .getAllWebContents()
      .some((candidate) => candidate !== host && !candidate.isDestroyed() && candidate.getOSProcessId() === pid)
  )
}

function validRelative(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..')
  )
}

/** One hidden, isolated Session owns one worker, resource handler and ASR generation lease. */
export async function createRuntimeWhisperHost(input: {
  readonly lease: RuntimeFeatureLease
  readonly assertCurrent: () => Promise<void>
  readonly assertAudioCurrent: () => Promise<void>
}): Promise<RuntimeWhisperHost> {
  if (!app.isPackaged || input.lease.feature !== 'offline-asr') throw new Error('RUNTIME_HOST_NOT_CONFIGURED')
  const token = randomBytes(32).toString('hex')
  const sessionId = randomBytes(32).toString('hex')
  const workerPath = input.lease.rendererRolePath('whisper-renderer-worker')
  const modelRoot = input.lease.rendererModelRoot('asr.whisper-base-q8')
  const resources = input.lease.rendererResources()
  const wasmFiles = [...resources.keys()].filter((path) => path.endsWith('.wasm'))
  if (wasmFiles.length === 0 || wasmFiles.some((path) => !validRelative(path))) {
    throw new Error('RUNTIME_HOST_WASM_CLOSURE_UNAVAILABLE')
  }
  const wasmRoots = new Set(wasmFiles.map((path) => path.slice(0, path.lastIndexOf('/'))))
  if (wasmRoots.size !== 1) throw new Error('RUNTIME_HOST_WASM_CLOSURE_AMBIGUOUS')
  const wasmRoot = [...wasmRoots][0]
  if (!validRelative(workerPath) || !validRelative(modelRoot) || !validRelative(wasmRoot)) {
    throw new Error('RUNTIME_HOST_RESOURCE_MAPPING_INVALID')
  }
  hostAssetsPromise ??= readHostAssets()
  const hostAssets = await hostAssetsPromise
  await input.assertCurrent()

  const hostSession = session.fromPartition(`metis-runtime-${token}`, { cache: false })
  const resource = createRuntimeResourceProtocol({
    token,
    lease: input.lease,
    hostAssets,
    assertCurrent: input.assertCurrent
  })
  hostSession.protocol.handle(SCHEME, resource.handle)
  hostSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  hostSession.setPermissionCheckHandler(() => false)
  hostSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let url: URL | null = null
    try {
      url = new URL(details.url)
    } catch {
      // Closed below.
    }
    callback({ cancel: !url || url.protocol !== `${SCHEME}:` || url.hostname !== token })
  })

  const preload = resolve(app.getAppPath(), 'out', 'preload', 'runtime-worker-host.js')
  const host = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    focusable: false,
    webPreferences: {
      session: hostSession,
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false
    }
  })
  host.setMenu(null)
  host.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const hostUrl = `${SCHEME}://${token}/host/index.html`
  const denyNavigation = (event: Electron.Event, url: string): void => {
    if (url !== hostUrl) event.preventDefault()
  }
  host.webContents.on('will-navigate', denyNavigation)
  host.webContents.on('will-redirect', denyNavigation)
  host.webContents.on('will-attach-webview', (event) => event.preventDefault())
  let renderProcessExited = false
  let hostWebContentsDestroyed = false
  let resolveWebContentsDestroyed!: () => void
  const webContentsDestroyed = new Promise<void>((resolvePromise) => {
    resolveWebContentsDestroyed = resolvePromise
  })
  host.webContents.once('destroyed', () => {
    hostWebContentsDestroyed = true
    resolveWebContentsDestroyed()
  })
  let resolveRenderProcessExit!: () => void
  const renderProcessExit = new Promise<void>((resolvePromise) => {
    resolveRenderProcessExit = resolvePromise
  })
  let finishAfterRenderExit: () => void = () => undefined
  host.webContents.on('render-process-gone', () => {
    renderProcessExited = true
    resolveRenderProcessExit()
    finishAfterRenderExit()
  })

  const { port1: hostPort, port2: hostBridgePort } = new MessageChannelMain()
  const { port1: uiBridgePort, port2: uiPort } = new MessageChannelMain()
  let uiPortForClose: Electron.MessagePortMain | null = uiPort
  let acceptingMessages = true
  let pendingAudio = 0
  let stopPromise: Promise<void> | null = null
  let workerStarted = false
  let isolatedRendererProcess = false
  let finalizePromise: Promise<void> | null = null
  let stopRequested = false
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolvePromise) => {
    resolveSettled = resolvePromise
  })
  const finalize = (): Promise<void> => {
    if (finalizePromise) return finalizePromise
    finalizePromise = (async () => {
      await resource.revoke()
      if (uiPortForClose) {
        try {
          uiPortForClose?.close()
        } catch {
          // It may already have been transferred to the UI frame.
        }
        uiPortForClose = null
      }
      hostBridgePort.close()
      uiBridgePort.close()
      hostPort.close()
      if (!host.isDestroyed()) host.destroy()
      hostSession.protocol.unhandle(SCHEME)
      await input.lease.release()
      unconfirmedRuntimeHosts.delete(runtimeHost)
      resolveSettled()
    })()
    return finalizePromise
  }
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopRequested = true
    acceptingMessages = false
    try {
      uiBridgePort.close()
    } catch {
      /* already closed */
    }
    unconfirmedRuntimeHosts.add(runtimeHost)
    stopPromise = (async () => {
      // Revoke first. The bounded wait lets teardown proceed while the worker is still protected by its
      // lease; release occurs only in finalize after both stream settlement and the execution barrier.
      const revoke = resource.revoke()
      if (workerStarted) {
        if (!renderProcessExited && !host.webContents.isDestroyed()) {
          try {
            host.webContents.send(HOST_STOP)
          } catch {
            // The process exit event remains the only release barrier.
          }
          if (!isolatedRendererProcess || samePidAsOtherContents(host.webContents)) {
            throw new RetainedRuntimeWhisperHostError(runtimeHost)
          }
          host.webContents.forcefullyCrashRenderer()
        }
        await within(renderProcessExit, STOP_BARRIER_MS)
      } else {
        if (!host.isDestroyed()) host.destroy()
        if (!hostWebContentsDestroyed) await within(webContentsDestroyed, STOP_BARRIER_MS)
      }
      await within(revoke, STOP_BARRIER_MS)
      await finalize()
    })()
    return stopPromise
  }

  const runtimeHost: RuntimeWhisperHost = Object.freeze({
    sessionId,
    generationIdentity: input.lease.generationIdentity,
    uiPort,
    settled,
    stop
  })
  finishAfterRenderExit = () => {
    stopRequested = true
    acceptingMessages = false
    void finalize().catch(() => undefined)
  }

  const validUiMessage = (value: unknown): { message: unknown; bytes: number; audio: boolean } | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const message = value as Record<string, unknown>
    if (message.type === 'init') {
      if (
        Object.keys(message).some((key) => !['type', 'quality', 'language', 'resetFollow', 'bundled'].includes(key)) ||
        (message.quality !== undefined && message.quality !== 'best' && message.quality !== 'fast') ||
        (message.language !== undefined &&
          (typeof message.language !== 'string' || !/^(?:auto|[a-z]{2,3})$/.test(message.language))) ||
        (message.resetFollow !== undefined && typeof message.resetFollow !== 'boolean') ||
        (message.bundled !== undefined && typeof message.bundled !== 'boolean')
      )
        return null
      return { message: structuredClone(value), bytes: 0, audio: false }
    }
    if (message.type === 'pinLanguage') {
      if (
        Object.keys(message).sort().join(',') !== 'language,type' ||
        typeof message.language !== 'string' ||
        !/^(?:auto|[a-z]{2,3})$/.test(message.language)
      )
        return null
      return { message: structuredClone(value), bytes: 0, audio: false }
    }
    const audio = message.audio
    if (
      message.type !== 'audio' ||
      Object.keys(message).sort().join(',') !==
        ['audio', 'partial', 'speaker', 'type']
          .filter((key) => key in message)
          .sort()
          .join(',') ||
      !(audio instanceof Float32Array) ||
      audio.length < 1 ||
      audio.length > 480_000 ||
      audio.byteOffset !== 0 ||
      audio.byteLength !== audio.buffer.byteLength ||
      (message.speaker !== 'you' && message.speaker !== 'them') ||
      (message.partial !== undefined && typeof message.partial !== 'boolean')
    )
      return null
    const copied = new Float32Array(audio)
    return { message: { ...message, audio: copied }, bytes: copied.byteLength, audio: true }
  }
  const safeHostResponse = (value: unknown): { message: unknown; audioSettled: boolean } | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const message = value as Record<string, unknown>
    if (
      message.type === 'ready' &&
      Object.keys(message).sort().join(',') === 'engine,qualityDegraded,requestedQuality,type' &&
      (message.engine === 'wasm' || message.engine === 'webgpu') &&
      (message.requestedQuality === 'best' || message.requestedQuality === 'fast') &&
      typeof message.qualityDegraded === 'boolean'
    ) {
      return { message: structuredClone(value), audioSettled: false }
    }
    if (
      message.type === 'progress' &&
      Object.keys(message).sort().join(',') === 'pct,type' &&
      Number.isInteger(message.pct) &&
      (message.pct as number) >= 0 &&
      (message.pct as number) <= 100
    ) {
      return { message: structuredClone(value), audioSettled: false }
    }
    if (
      message.type === 'text' &&
      Object.keys(message).sort().join(',') === 'partial,speaker,text,type' &&
      typeof message.text === 'string' &&
      message.text.length <= 20_000 &&
      (message.speaker === 'you' || message.speaker === 'them') &&
      typeof message.partial === 'boolean'
    ) {
      return { message: structuredClone(value), audioSettled: true }
    }
    if (
      message.type === 'error' &&
      Object.keys(message).sort().join(',') === 'message,speaker,type' &&
      typeof message.message === 'string' &&
      message.message.length <= 512 &&
      (message.speaker === 'you' || message.speaker === 'them')
    ) {
      return { message: structuredClone(value), audioSettled: true }
    }
    return null
  }
  uiBridgePort.on('message', (event) => {
    void (async () => {
      if (!acceptingMessages) return
      const parsed = validUiMessage(event.data)
      if (!parsed) throw new Error('RUNTIME_HOST_INPUT_INVALID')
      if (parsed.audio && pendingAudio >= 2) {
        uiBridgePort.postMessage({
          type: 'error',
          message: 'The offline speech runtime is busy.',
          speaker: (event.data as { speaker: string }).speaker
        })
        return
      }
      await (parsed.audio ? input.assertAudioCurrent() : input.assertCurrent())
      if (!acceptingMessages) return
      if (parsed.audio) pendingAudio += 1
      hostBridgePort.postMessage(parsed.message)
    })().catch(() => {
      void stop().catch(() => undefined)
    })
  })
  hostBridgePort.on('message', (event) => {
    const safe = safeHostResponse(event.data)
    if (!safe) {
      void stop().catch(() => undefined)
      return
    }
    if (safe.audioSettled) pendingAudio = Math.max(0, pendingAudio - 1)
    if (!acceptingMessages) return
    void input
      .assertCurrent()
      .then(() => uiBridgePort.postMessage(safe.message))
      .catch(() => {
        void stop().catch(() => undefined)
      })
  })
  uiBridgePort.start()
  hostBridgePort.start()

  try {
    await host.loadURL(hostUrl)
    await input.assertCurrent()
    if (samePidAsOtherContents(host.webContents)) throw new Error('RUNTIME_HOST_PROCESS_NOT_ISOLATED')
    isolatedRendererProcess = true
    const workerUrl = `${SCHEME}://${token}/runtime/${workerPath}`
    if (!resources.has(workerPath)) throw new Error('RUNTIME_HOST_WORKER_NOT_PINNED')
    hostPort.postMessage({ type: 'configure', token, workerPath, modelRoot, wasmRoot })
    workerStarted = true
    host.webContents.postMessage(HOST_CHANNEL, null, [hostPort])
    await input.assertCurrent()
    return runtimeHost
  } catch (error) {
    try {
      await stop()
    } catch {
      throw new RetainedRuntimeWhisperHostError(runtimeHost)
    }
    throw error
  }
}
