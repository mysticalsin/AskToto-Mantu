import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { BrowserWindow, MessageChannelMain, app, session, webContents } from 'electron'
import { createRuntimeResourceProtocol, type HostAsset } from './runtime-resource-protocol'
import type { RuntimeFeatureLease } from './runtime-lease'

const SCHEME = 'metis-runtime'
const HOST_CHANNEL = 'metis-runtime-host-channel'
const HOST_STOP = 'metis-runtime-host-stop'
const MAX_HOST_ASSETS_BYTES = 4 * 1024 * 1024

let hostAssetsPromise: Promise<Readonly<Record<string, HostAsset>>> | null = null

async function readHostAssets(): Promise<Readonly<Record<string, HostAsset>>> {
  if (!app.isPackaged) throw new Error('RUNTIME_HOST_PACKAGE_REQUIRED')
  const rendererRoot = resolve(app.getAppPath(), 'out', 'renderer')
  const htmlPath = join(rendererRoot, 'runtime-worker-host.html')
  const html = await readFile(htmlPath)
  if (html.byteLength < 1 || html.byteLength > MAX_HOST_ASSETS_BYTES) throw new Error('RUNTIME_HOST_ASSET_INVALID')
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
  const scriptBytes = await readFile(scriptPath)
  if (scriptBytes.byteLength < 1 || scriptBytes.byteLength > MAX_HOST_ASSETS_BYTES) {
    throw new Error('RUNTIME_HOST_ASSET_INVALID')
  }
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
  let resolveRenderProcessExit!: () => void
  const renderProcessExit = new Promise<void>((resolvePromise) => {
    resolveRenderProcessExit = resolvePromise
  })
  host.webContents.on('render-process-gone', () => {
    renderProcessExited = true
    resolveRenderProcessExit()
  })
  host.webContents.once('destroyed', () => {
    // Destruction alone is not an exit barrier. The promise deliberately remains pending without the
    // separate render-process-gone observation, so the lease cannot be released early.
  })

  const { port1, port2 } = new MessageChannelMain()
  let uiPort: Electron.MessagePortMain | null = port2
  let stopPromise: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    unconfirmedRuntimeHosts.add(runtimeHost)
    stopPromise = (async () => {
      if (!renderProcessExited && !host.webContents.isDestroyed()) {
        try {
          host.webContents.send(HOST_STOP)
        } catch {
          // The process exit event remains the only release barrier.
        }
        await resource.revoke()
        host.webContents.forcefullyCrashRenderer()
        await renderProcessExit
      } else {
        await resource.revoke()
        if (!renderProcessExited) await renderProcessExit
      }
      if (uiPort) {
        try {
          uiPort.close()
        } catch {
          // It may already have been transferred to the UI frame.
        }
        uiPort = null
      }
      if (!host.isDestroyed()) host.destroy()
      hostSession.protocol.unhandle(SCHEME)
      await input.lease.release()
      unconfirmedRuntimeHosts.delete(runtimeHost)
    })()
    return stopPromise
  }

  const runtimeHost: RuntimeWhisperHost = Object.freeze({
    sessionId,
    generationIdentity: input.lease.generationIdentity,
    uiPort: port2,
    stop
  })

  try {
    await host.loadURL(hostUrl)
    await input.assertCurrent()
    if (samePidAsOtherContents(host.webContents)) throw new Error('RUNTIME_HOST_PROCESS_NOT_ISOLATED')
    const workerUrl = `${SCHEME}://${token}/runtime/${workerPath}`
    if (!resources.has(workerPath)) throw new Error('RUNTIME_HOST_WORKER_NOT_PINNED')
    port1.postMessage({ type: 'configure', token, workerPath, modelRoot, wasmRoot })
    host.webContents.postMessage(HOST_CHANNEL, null, [port1])
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
