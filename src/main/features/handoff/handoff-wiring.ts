/**
 * Production composition of the handoff feature (G37): registers `metis://`, receives URLs from macOS `open-url`,
 * from Windows/Linux launch and second-instance arguments, and hands each valid envelope to CommandControl as one
 * `desktop.create_note` proposal. Electron is touched only through the small `HandoffApp` port.
 */
import { join } from 'node:path'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import type { CommandControlProposal } from '../../command-control'
import { scheduleCaptureDeadline } from '../../infra/scheduler/capture-deadline'
import { createFileNonceStore } from './nonce-file-store'
import { createHandoffRateLimit, type HandoffRateLimit } from './handoff-rate-limit'
import { createNonceLedger, type NonceStore } from './nonce-ledger'
import { createHandoffService, type HandoffAuditDetail, type HandoffAuditEvent } from './handoff-service'
import { extractHandoffUrls, HANDOFF_SCHEME } from './handoff-url'

/** How long a URL that arrived before the overlay window existed waits for it. */
export const HANDOFF_OWNER_WAIT_MS = 30_000
const OWNER_POLL_MS = 500

export interface HandoffApp {
  isPackaged: boolean
  on(event: 'open-url', listener: (event: { preventDefault(): void }, url: string) => void): unknown
  setAsDefaultProtocolClient(scheme: string): boolean
  whenReady(): Promise<unknown>
  getPath(name: 'userData'): string
}

export interface HandoffDeps {
  app: HandoffApp
  commandControl: {
    proposeChecked(
      owner: { webContentsId: number; revision: number },
      request: DesktopActionRequest,
      options: { provenance: 'external' }
    ): Promise<CommandControlProposal | null>
    hasPendingProposal(): boolean
  }
  /** The overlay window, if there is a live one. Its id becomes the card's owner. */
  getWindow(): { isDestroyed(): boolean; webContents: { id: number } } | null
  audit(event: HandoffAuditEvent, detail: HandoffAuditDetail): void
  argv?: readonly string[]
  now?: () => number
  rateLimit?: HandoffRateLimit
  /** Test seam; production uses the userData file. */
  nonceStore?: NonceStore
  sleep?: (ms: number) => Promise<void>
}

export interface HandoffRuntime {
  /** Second-instance command line (Windows, Linux). */
  fromArgv(argv: readonly string[]): void
}

export function installHandoff(deps: HandoffDeps): HandoffRuntime {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => void scheduleCaptureDeadline(resolve, ms)))
  let revision = 0
  let service: ReturnType<typeof createHandoffService> | null = null
  const ready = deps.app.whenReady().then(() => {
    const ledger = createNonceLedger({
      now,
      store: deps.nonceStore ?? createFileNonceStore(join(deps.app.getPath('userData'), 'handoff-nonces.json'))
    })
    service = createHandoffService({
      now,
      ledger,
      rateLimit: deps.rateLimit ?? createHandoffRateLimit(),
      isBusy: () => deps.commandControl.hasPendingProposal(),
      audit: deps.audit,
      propose: async (request) => {
        const liveOwner = (): { webContentsId: number } | null => {
          const w = deps.getWindow()
          return w && !w.isDestroyed() ? { webContentsId: w.webContents.id } : null
        }
        let owner = liveOwner()
        for (let waited = 0; !owner && waited < HANDOFF_OWNER_WAIT_MS; waited += OWNER_POLL_MS) {
          await sleep(OWNER_POLL_MS)
          owner = liveOwner()
        }
        if (!owner) return false
        try {
          return (
            (await deps.commandControl.proposeChecked(
              { webContentsId: owner.webContentsId, revision: ++revision },
              request,
              { provenance: 'external' }
            )) !== null
          )
        } catch (error) {
          // CommandControl refuses at the install boundary when an owner card appeared during the preflight.
          if (error instanceof Error && error.message === 'busy') return 'busy'
          throw error
        }
      }
    })
  })
  const submit = (url: string): void => {
    void ready.then(() => service?.receive(url)).catch(() => undefined)
  }
  // Registered before ready: macOS delivers a cold-start URL as `open-url` ahead of app-ready.
  deps.app.on('open-url', (event, url) => {
    event.preventDefault()
    submit(url)
  })
  // A development run would register the bare Electron binary as the handler, so only a packaged app claims it.
  if (deps.app.isPackaged) deps.app.setAsDefaultProtocolClient(HANDOFF_SCHEME)
  const fromArgv = (argv: readonly string[]): void => extractHandoffUrls(argv).forEach(submit)
  fromArgv(deps.argv ?? process.argv)
  return { fromArgv }
}
