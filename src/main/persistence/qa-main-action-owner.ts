import { app, type BrowserWindow, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { QA_IDENTITY_BUILD } from '../qa-identity'
import { PERSISTENCE_NATIVE_KEY_INTENT } from './native-key-intent'
import { capturePublishedMainPersistenceSessionBoundary } from '../auth'
import { getPublishedSettingsObservation } from '../settings-observation'
import { captureSettingsAuthority, isSettingsAuthorityCurrent } from '../settings-authority-history'

const nativeKeyIntentAllowed = PERSISTENCE_NATIVE_KEY_INTENT === 'allowed'

export type QaPersistenceCaseId =
  | 'native-journal-create-append'
  | 'native-journal-reopen'
  | 'native-explicit-optout-refusal'
  | 'native-unavailable-refusal'
  | 'before-show-refusal'
  | 'status-no-side-effects'

export type QaPersistenceActionRefusal =
  | 'not-qa-build'
  | 'invalid-case'
  | 'not-packaged'
  | 'wrong-runtime-name'
  | 'native-key-opted-out'
  | 'auth-unavailable'
  | 'settings-unavailable'
  | 'settings-authority-not-current'
  | 'no-bound-window'
  | 'window-closed'
  | 'window-not-shown'
  | 'window-hidden'
  | 'renderer-not-trusted'
  | 'navigation-pending'
  | 'sender-mismatch'
  | 'frame-mismatch'
  | 'run-unavailable'

export type QaPersistenceActionCapture = Readonly<{
  state: 'refused'
  reason: QaPersistenceActionRefusal
}>

interface MainDocumentReceipt {
  readonly window: BrowserWindow
  readonly contents: WebContents
  readonly windowGeneration: number
  readonly documentGeneration: number
  readonly frame: WebFrameMain | null
  readonly processId: number | null
  readonly routingId: number | null
  readonly firstShowObserved: boolean
  readonly closed: boolean
  readonly navigationPending: boolean
  readonly retirement: AbortController
}

declare const qaPersistenceRunWindowProofBrand: unique symbol
export type QaPersistenceRunWindowProof = Readonly<{ readonly [qaPersistenceRunWindowProofBrand]: true }>
type RunWindowProofRecord = Readonly<{
  window: BrowserWindow
  contents: WebContents
  frame: WebFrameMain
  windowGeneration: number
  documentGeneration: number
  processId: number
  routingId: number
  retirement: AbortController
}>

const records = new WeakMap<BrowserWindow, MainDocumentReceipt>()
const runWindowProofs = new WeakMap<object, RunWindowProofRecord>()
let bound: MainDocumentReceipt | null = null
let nextWindowGeneration = 0
const CASE_IDS = new Set<QaPersistenceCaseId>([
  'native-journal-create-append',
  'native-journal-reopen',
  'native-explicit-optout-refusal',
  'native-unavailable-refusal',
  'before-show-refusal',
  'status-no-side-effects'
])

function setRecord(record: MainDocumentReceipt, patch: Partial<MainDocumentReceipt>): MainDocumentReceipt {
  const retiresDocument =
    patch.closed === true ||
    (patch.documentGeneration !== undefined && patch.documentGeneration !== record.documentGeneration)
  if (retiresDocument && !record.retirement.signal.aborted) record.retirement.abort()
  const next = Object.freeze({
    ...record,
    ...patch,
    retirement: retiresDocument && patch.closed !== true ? new AbortController() : record.retirement
  })
  records.set(record.window, next)
  if (bound?.window === record.window) bound = next
  return next
}

function liveRecord(record: MainDocumentReceipt): boolean {
  try {
    return (
      !record.closed &&
      !record.window.isDestroyed() &&
      !record.contents.isDestroyed() &&
      records.get(record.window) === record
    )
  } catch {
    return false
  }
}

function currentFrame(record: MainDocumentReceipt): WebFrameMain | null {
  try {
    return record.contents.mainFrame
  } catch {
    return null
  }
}

function currentFrameIds(frame: WebFrameMain | null): Pick<MainDocumentReceipt, 'processId' | 'routingId'> {
  return frame ? { processId: frame.processId, routingId: frame.routingId } : { processId: null, routingId: null }
}

function packagedRendererLocation(): URL {
  return new URL(pathToFileURL(join(__dirname, '../renderer/index.html')).href)
}

function hasTrustedRendererLocation(record: MainDocumentReceipt): boolean {
  try {
    const actual = new URL(record.contents.getURL())
    const expected = packagedRendererLocation()
    if (
      actual.protocol !== 'file:' ||
      actual.host !== '' ||
      actual.pathname !== expected.pathname ||
      actual.hash !== ''
    )
      return false
    const allowed = new Map<string, ReadonlySet<string>>([
      ['exclusiveOnboarding', new Set(['1'])],
      ['view', new Set(['settings'])],
      ['tab', new Set(['ai'])]
    ])
    for (const key of actual.searchParams.keys()) {
      const values = allowed.get(key)
      const supplied = actual.searchParams.getAll(key)
      if (!values || supplied.length !== 1 || !values.has(supplied[0])) return false
    }
    return true
  } catch {
    return false
  }
}

function packagedQaRuntime(): QaPersistenceActionRefusal | null {
  if (!QA_IDENTITY_BUILD) return 'not-qa-build'
  try {
    if (!app.isPackaged) return 'not-packaged'
    if (app.getName() !== 'asktoto-qa') return 'wrong-runtime-name'
    return null
  } catch {
    return 'not-packaged'
  }
}

/** Bind only the real overlay BrowserWindow, immediately after construction and before navigation. */
export function bindQaPersistenceMainWindow(window: BrowserWindow): void {
  if (!QA_IDENTITY_BUILD || packagedQaRuntime() !== null) return
  if (bound?.window === window && liveRecord(bound)) return

  if (bound && bound.window !== window) {
    setRecord(bound, { closed: true, navigationPending: true, documentGeneration: bound.documentGeneration + 1 })
    bound = null
  }

  const contents = window.webContents
  const frame = currentFrame({ window, contents } as MainDocumentReceipt)
  const frameIds = currentFrameIds(frame)
  const initial: MainDocumentReceipt = Object.freeze({
    window,
    contents,
    windowGeneration: ++nextWindowGeneration,
    documentGeneration: 0,
    frame,
    ...frameIds,
    firstShowObserved: false,
    closed: false,
    navigationPending: true,
    retirement: new AbortController()
  })
  records.set(window, initial)
  bound = initial

  window.on('show', () => {
    const current = records.get(window)
    if (current && !current.closed) setRecord(current, { firstShowObserved: true })
  })
  window.once('closed', () => retireWindow(window))
  contents.once('destroyed', () => retireWindow(window))
  contents.on('render-process-gone', () => {
    const current = records.get(window)
    if (current && !current.closed) {
      setRecord(current, { documentGeneration: current.documentGeneration + 1, navigationPending: true })
    }
  })
  contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return
    const current = records.get(window)
    if (current && !current.closed) {
      setRecord(current, {
        documentGeneration: current.documentGeneration + 1,
        navigationPending: true
      })
    }
  })
  contents.on('did-navigate', () => commitMainDocument(window))
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) commitMainDocument(window)
  })

  try {
    const current = records.get(window)
    if (current && window.isVisible()) {
      setRecord(current, { firstShowObserved: true })
    }
  } catch {
    retireWindow(window)
  }
}

/** Capture the committed packaged QA main document after first show; performs no auth or action work. */
export function captureQaPersistenceRunWindowProof(): QaPersistenceRunWindowProof | null {
  if (packagedQaRuntime() !== null) return null
  const record = bound
  if (!record || !liveRecord(record) || !record.firstShowObserved || record.navigationPending) return null
  try {
    if (!record.window.isVisible() || !hasTrustedRendererLocation(record)) return null
  } catch {
    return null
  }
  const frame = currentFrame(record)
  if (
    !frame ||
    record.retirement.signal.aborted ||
    frame !== record.frame ||
    frame.parent !== null ||
    !Number.isInteger(frame.processId) ||
    !Number.isInteger(frame.routingId)
  )
    return null
  const proof = Object.freeze(Object.create(null)) as QaPersistenceRunWindowProof
  runWindowProofs.set(
    proof as object,
    Object.freeze({
      window: record.window,
      contents: record.contents,
      frame,
      windowGeneration: record.windowGeneration,
      documentGeneration: record.documentGeneration,
      processId: frame.processId,
      routingId: frame.routingId,
      retirement: record.retirement
    })
  )
  return proof
}

/** Assert exact captured document membership. Visibility after capture is intentionally irrelevant. */
export function assertQaPersistenceRunWindowCurrent(proof: QaPersistenceRunWindowProof): void {
  const captured = runWindowProofs.get(proof as object)
  if (!captured) throw new Error('Unknown QA persistence run window proof')
  const current = records.get(captured.window)
  if (
    captured.retirement.signal.aborted ||
    packagedQaRuntime() !== null ||
    !current ||
    !liveRecord(current) ||
    current.closed ||
    bound?.window !== captured.window ||
    current.contents !== captured.contents ||
    current.windowGeneration !== captured.windowGeneration ||
    current.documentGeneration !== captured.documentGeneration ||
    current.frame !== captured.frame ||
    currentFrame(current) !== captured.frame ||
    captured.frame.processId !== captured.processId ||
    captured.frame.routingId !== captured.routingId ||
    !hasTrustedRendererLocation(current)
  ) {
    captured.retirement.abort()
    throw new Error('QA persistence run window proof retired')
  }
}

/** Read-only retirement signal owned by the captured main document. */
export function qaPersistenceRunWindowRetirementSignal(proof: QaPersistenceRunWindowProof): AbortSignal {
  const captured = runWindowProofs.get(proof as object)
  if (!captured) throw new Error('Unknown QA persistence run window proof')
  return captured.retirement.signal
}

function commitMainDocument(window: BrowserWindow): void {
  const current = records.get(window)
  if (!current || current.closed) return
  const frame = currentFrame(current)
  const missingStart = !current.navigationPending
  setRecord(current, {
    documentGeneration: current.documentGeneration + (missingStart ? 1 : 0),
    frame,
    ...currentFrameIds(frame),
    navigationPending: false
  })
}

function retireWindow(window: BrowserWindow): void {
  const current = records.get(window)
  if (!current || current.closed) return
  setRecord(current, {
    closed: true,
    documentGeneration: current.documentGeneration + 1,
    navigationPending: true
  })
  if (bound?.window === window) bound = null
}

function validateActionEvent(event: IpcMainInvokeEvent, caseId: unknown): QaPersistenceActionRefusal | null {
  if (!QA_IDENTITY_BUILD) return 'not-qa-build'
  if (typeof caseId !== 'string' || !CASE_IDS.has(caseId as QaPersistenceCaseId)) return 'invalid-case'
  const runtime = packagedQaRuntime()
  if (runtime) return runtime
  if (caseId.startsWith('native-') && !nativeKeyIntentAllowed) return 'native-key-opted-out'
  const record = bound
  if (!record) return 'no-bound-window'
  if (!liveRecord(record)) return 'window-closed'
  if (!record.firstShowObserved) return 'window-not-shown'
  try {
    if (!record.window.isVisible()) return 'window-hidden'
  } catch {
    return 'window-closed'
  }
  if (!hasTrustedRendererLocation(record)) return 'renderer-not-trusted'
  if (record.navigationPending) return 'navigation-pending'
  if (event.sender !== record.contents) return 'sender-mismatch'
  const senderFrame = event.senderFrame
  const mainFrame = currentFrame(record)
  if (
    !senderFrame ||
    senderFrame !== mainFrame ||
    senderFrame !== record.frame ||
    mainFrame !== record.frame ||
    senderFrame.parent !== null ||
    senderFrame.processId !== record.processId ||
    senderFrame.routingId !== record.routingId
  )
    return 'frame-mismatch'
  const settings = getPublishedSettingsObservation()
  if (!settings || !settings.readable) return 'settings-unavailable'
  const settingsReceipt = captureSettingsAuthority('persistence')
  if (!settingsReceipt || !isSettingsAuthorityCurrent(settingsReceipt)) return 'settings-authority-not-current'
  const authBoundary = capturePublishedMainPersistenceSessionBoundary()
  if (!authBoundary || !authBoundary.isCurrent()) return 'auth-unavailable'
  return 'run-unavailable'
}

/**
 * Captures no action token until the authenticated C2 run owner is composed. The fail-closed refusal
 * is deliberate on this C1-only branch; a window/document fact is not a prepared-run capability.
 */
export function captureQaPersistenceAction(
  event: IpcMainInvokeEvent,
  caseId: QaPersistenceCaseId
): QaPersistenceActionCapture {
  const reason = validateActionEvent(event, caseId)
  return Object.freeze({ state: 'refused', reason: reason ?? 'run-unavailable' })
}
