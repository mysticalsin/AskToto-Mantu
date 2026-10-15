import type { BrowserWindow, DesktopCapturerSource, Session } from 'electron'
import type { SpeechCaptureContext, SpeechCaptureGrantRegistry } from './speech-capture-grant'

type Handler = NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>
type Request = Parameters<Handler>[0]
type Callback = Parameters<Handler>[1]

export type ListenDisplayMediaOptions = {
  session: Pick<Session, 'setDisplayMediaRequestHandler'>
  getWindow: () => BrowserWindow | null
  isAudioArmed: () => boolean
  acquireScreenSource: () => Promise<DesktopCapturerSource | null>
  denyDisplayMedia: Parameters<Callback>[0]
  warn: (message: string) => void
  grants: SpeechCaptureGrantRegistry
  readContext: () => SpeechCaptureContext | null
}

/** Actual Electron callback success is the loopback grant fact; arming alone never grants authority. */
export function registerListenDisplayMedia(options: ListenDisplayMediaOptions): void {
  options.session.setDisplayMediaRequestHandler(
    async (request: Request, callback: Callback) => {
      const window = options.getWindow()
      const frame = request.frame
      const mainUrl = window?.webContents.getURL() ?? ''
      const context = options.readContext()
      let pending: ReturnType<SpeechCaptureGrantRegistry['beginPendingGrant']> = null
      const respond = (spec: Parameters<Callback>[0], audioGranted = false): void => {
        try {
          callback(spec)
          if (pending && context)
            options.grants.recordGrantCallbackResult(pending, context, { callbackSucceeded: true, audioGranted })
        } catch {
          // Electron rejects invalid callback arguments. Never turn a thrown callback into an issued grant.
          options.warn('[display-media] callback rejected')
          if (pending && context)
            options.grants.recordGrantCallbackResult(pending, context, {
              callbackSucceeded: false,
              audioGranted: false
            })
        }
      }
      const current = (checkPending = true): boolean => {
        try {
          if (!window || window.isDestroyed() || options.getWindow() !== window || !options.isAudioArmed()) return false
          if (!frame || frame !== window.webContents.mainFrame || window.webContents.getURL() !== mainUrl) return false
          let expectedOrigin = ''
          try {
            expectedOrigin = new URL(mainUrl).origin
          } catch {
            expectedOrigin = mainUrl
          }
          const origin = request.securityOrigin
          const originOk =
            !mainUrl ||
            origin === expectedOrigin ||
            origin === mainUrl ||
            (expectedOrigin === 'null' && origin.startsWith('file://'))
          if (!originOk || !request.audioRequested) return false
          if (context) {
            if (context.webContents !== window.webContents || context.frame !== frame) return false
            const fresh = options.readContext()
            if (
              !fresh ||
              fresh.navigationEpoch !== context.navigationEpoch ||
              fresh.listenStartedAt !== context.listenStartedAt
            )
              return false
            if (checkPending && (!pending || !options.grants.isPendingGrantCurrent(pending, fresh))) return false
          }
          return true
        } catch {
          return false
        }
      }
      try {
        if (!current(false)) {
          respond(options.denyDisplayMedia)
          return
        }
        pending = context ? options.grants.beginPendingGrant(context) : null
        if (context && !pending) {
          respond(options.denyDisplayMedia)
          return
        }
        if (!request.videoRequested) {
          respond({ audio: 'loopback' }, true)
          return
        }
        const source = await options.acquireScreenSource()
        if (!current()) {
          respond(options.denyDisplayMedia)
          return
        }
        respond(source ? { video: source, audio: 'loopback' } : options.denyDisplayMedia, source !== null)
      } catch {
        options.warn('[display-media] handler error')
        respond(options.denyDisplayMedia)
      }
    },
    { useSystemPicker: false }
  )
}
