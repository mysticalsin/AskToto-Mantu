import { AsyncLocalStorage } from 'node:async_hooks'
import { writeFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'

const ROLES = [
  'initial-speech',
  'held-old-speech',
  'reentrant-main',
  'explicit-status-main',
  'replacement-speech',
  'returned-account-speech'
] as const
type Role = (typeof ROLES)[number]
type Kind = 'main' | 'speech'
type Phase = 'request' | 'invalidation-status' | 'post-sign-in-status' | 'return-account-status' | 'unassigned'
type SourceRole = 'settings' | 'recovered' | 'user-managed' | 'admin-managed' | 'sticky' | 'lkg'
type ErrorCategory =
  | 'unknown-membership'
  | 'ancestor-changed'
  | 'target-changed'
  | 'absence-appeared'
  | 'source-disappeared'
  | 'admin-trust-refused'
  | 'close-failed'
  | 'settings-frame-unavailable'
  | 'original-fence-changed'
  | 'unclassified-refusal'
type Context = {
  preparation: Preparation | null
  source: Source | null
  stage: 'capture-pin' | 'read-check' | 'validate' | null
}
type StatValue = {
  kind: 'file' | 'directory'
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  uid: number
  gid: number
  mode: number
}
type PathSnapshot = { stat: StatValue }
type Divergence = {
  atTick: number
  depth: number | null
  relation: 'volume-root' | 'shared-ancestor' | 'profile' | 'immediate-source-parent' | null
  target: boolean
  fields: Record<string, boolean>
}
type Source = {
  ordinal: number
  role: SourceRole | null
  path: string
  key: string
  profilePath: string
  captureCount: number
  validationCount: number
  missing: Set<string>
  captured: Map<string, PathSnapshot>
  captureOutcome: 'not-observed' | 'captured' | 'invalid' | 'unknown'
  boundedOutcome: 'not-observed' | 'present' | 'absent' | 'invalid' | 'unknown'
  managedOutcome: 'not-observed' | 'present' | 'absent' | 'invalid' | 'unknown'
  validationOutcome: 'not-observed' | 'current' | 'refused' | 'unknown'
  validationCategory: ErrorCategory | null
  failureCategory: ErrorCategory | null
  observerMembership: 'observed' | 'unavailable'
  unchangedPathCount: number
  changedPathCount: number
  absenceAppearedCount: number
  sourceDisappearedCount: number
  firstDivergence: Divergence | null
}
type Fence = {
  captured: boolean
  boundaryGenerationCaptured: boolean
  authorityEpochCaptured: boolean
  semanticEpochCaptured: boolean
  sessionIdentityCaptured: boolean
  sessionValueCaptured: boolean
  sessionEpochCaptured: boolean
  profileCaptured: boolean
  readerIdentityCaptured: boolean
  sessionOutsideOriginalObserved: boolean
  principalAssociationAvailable: false
  checksBeforeBoundary: number
  checksAfterBoundary: number
  expectedPublicationCheckCount: number
  firstChangedCheck: number | null
  firstChangedPhase: 'before-boundary' | 'after-boundary' | 'expected-publication' | null
  boundaryGenerationEqual: boolean | null
  authorityEpochEqual: boolean | null
  semanticEpochEqual: boolean | null
  sessionIdentityEqual: boolean | null
  sessionValueEqual: boolean | null
  sessionEpochEqual: boolean | null
  profileEqual: boolean | null
  readerIdentityEqual: boolean | null
  environmentCheckCount: number
  environmentCurrent: boolean | null
  environmentSnapshotIdentityEqual: boolean | null
  receiptCheckCount: number
  receiptCurrent: boolean | null
  receiptMatchesOriginal: boolean | null
  fixtureEpochEqual: boolean | null
  storeEpochEqual: boolean | null
}
type Preparation = {
  ordinal: number
  startedTick: number
  kind: Kind
  role: Role | null
  callerPhase: Phase
  begun: true
  ended: boolean
  outcome: 'pending' | 'fulfilled-null' | 'fulfilled-present' | 'rejected'
  errorCategory: ErrorCategory | null
  joins: { role: Role; phase: Phase }[]
  fence: Fence
  session: object | null
  sessionValue: string | null
  sessionEpoch: number | null
  profilePath: string | null
  reader: object | null
  environmentSnapshot: object | null
  boundaryGeneration: number | null
  authorityEpoch: number | null
  semanticEpoch: number | null
  fixtureEpoch: number | null
  storeEpoch: number | null
  storeOutcome: 'not-observed' | 'returned-readable' | 'returned-unreadable' | 'rejected'
  storeReadable: boolean | null
  storeReceipt: object | null
  storeFramePresent: boolean | null
  storeReceiptFrameAssociated: boolean | null
  storeFrameLookup: 'not-called' | 'returned-null' | 'returned-frame'
  boundaryReadable: boolean | null
  boundaryFramePresent: boolean | null
  boundaryReceiptPresent: boolean | null
  boundaryReceiptMatchesStore: boolean | null
  verifiedBoundaryOutcome: 'not-observed' | 'current' | 'refused' | 'unknown'
  verifiedBoundaryErrorCategory: ErrorCategory | null
  boundaryObject: object | null
  boundaryReceipt: object | null
  sources: Source[]
  controller: object
  boundaryReturned: boolean
  boundaryReturnedTick: number | null
  expectedPublication: boolean
  expectedPublicationTick: number | null
  stageAtEnd: 'pending' | 'before-original-capture' | 'before-boundary-return' | 'after-boundary-return'
}
type Caller = { role: Role; phase: Phase }
type Event = {
  sequence: number
  tick: number
  kind:
    | 'preparation-begin'
    | 'preparation-end'
    | 'caller-join'
    | 'currentness'
    | 'replacement-assertion'
    | 'case-outcome'
  ordinal: number | null
  role: Role | null
  phase: Phase | null
  status: string | null
}

const sourceContext = new AsyncLocalStorage<Context>()
const errorCategories = new Set<ErrorCategory>([
  'unknown-membership',
  'ancestor-changed',
  'target-changed',
  'absence-appeared',
  'source-disappeared',
  'admin-trust-refused',
  'close-failed',
  'settings-frame-unavailable',
  'original-fence-changed',
  'unclassified-refusal'
])
const PATH = process.platform === 'win32' ? win32 : posix
const MAX_PREPARATIONS = 8
const MAX_SOURCES_PER_PREPARATION = 6
const MAX_EVENTS = 128
const MAX_BYTES = 64 * 1024
const MAX_SIDECARS = 128
const MAX_TICKS = 8192

function role(value: string): Role | null {
  return (ROLES as readonly string[]).includes(value) ? (value as Role) : null
}

function category(error: unknown): ErrorCategory {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Unknown authority source pin' || message === 'Unknown managed authority read')
    return 'unknown-membership'
  if (message === 'Authority parent changed') return 'ancestor-changed'
  if (message === 'Authority source changed') return 'target-changed'
  if (message === 'Previously absent authority source appeared') return 'absence-appeared'
  if (message === 'Managed admin source trust changed') return 'admin-trust-refused'
  if (message === 'Authority source handle close failed' || message === 'Managed authority handle close failed')
    return 'close-failed'
  if (
    message === 'Settings persistence receipt unavailable' ||
    message === 'Speech auth boundary has no verified persistence frame' ||
    message === 'Settings receipt is not current' ||
    message === 'Settings auth receipt changed' ||
    message === 'Settings authority paths changed during capture' ||
    message === 'Settings authority paths changed before frame attachment' ||
    message === 'Settings authority frame was not captured'
  )
    return 'settings-frame-unavailable'
  if (
    message === 'Original auth fence changed' ||
    message === 'Stale auth frame' ||
    message === 'Authority changed before publication' ||
    message === 'Auth environment changed during preparation' ||
    message === 'Session changed during authority read' ||
    message === 'Session validation changed the captured session'
  )
    return 'original-fence-changed'
  return 'unclassified-refusal'
}

function sourceRole(path: string, profilePath: string): SourceRole | null {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (basename === 'settings.json') return 'settings'
  if (basename === 'settings.json.recovered') return 'recovered'
  if (basename === 'managed-config.json') return 'user-managed'
  if (basename === 'admin-managed-config.json') return 'admin-managed'
  if (basename === 'auth-configured.flag') return 'sticky'
  if (basename === 'auth-lkg-config.json') return 'lkg'
  const expected = `${profilePath.replace(/[\\/]$/, '')}/managed-config.json`.replaceAll('\\', '/').toLowerCase()
  return normalized === expected ? 'user-managed' : null
}

function statValue(value: unknown): StatValue | null {
  if (!value || typeof value !== 'object') return null
  const stat = value as Record<string, unknown>
  const file = typeof stat.isFile === 'function' && (stat.isFile as () => boolean)()
  const directory = typeof stat.isDirectory === 'function' && (stat.isDirectory as () => boolean)()
  if ((!file && !directory) || (typeof stat.isSymbolicLink === 'function' && (stat.isSymbolicLink as () => boolean)()))
    return null
  const keys = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'uid', 'gid', 'mode'] as const
  if (keys.some((key) => !Number.isFinite(stat[key]))) return null
  return {
    kind: file ? 'file' : 'directory',
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    birthtimeMs: Number(stat.birthtimeMs),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode)
  }
}

function sameStat(left: StatValue, right: StatValue): Record<string, boolean> {
  return {
    kind: left.kind === right.kind,
    dev: left.dev === right.dev,
    ino: left.ino === right.ino,
    size: left.size === right.size,
    mtime: left.mtimeMs === right.mtimeMs,
    ctime: left.ctimeMs === right.ctimeMs,
    birthtime: left.birthtimeMs === right.birthtimeMs,
    uid: left.uid === right.uid,
    gid: left.gid === right.gid,
    mode: left.mode === right.mode
  }
}

function pathKey(path: string): string {
  const absolute = PATH.resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function pathDepth(path: string, targetPath: string): number | null {
  const root = PATH.parse(PATH.resolve(targetPath)).root
  const absolute = PATH.resolve(path)
  const relative = PATH.relative(root, absolute)
  if (relative === '' || relative === '.') return 0
  if (relative === '..' || relative.startsWith(`..${PATH.sep}`) || PATH.isAbsolute(relative)) return null
  return relative.split(PATH.sep).filter(Boolean).length
}

function relation(path: string, targetPath: string, profilePath: string): Divergence['relation'] {
  const key = pathKey(path)
  const target = pathKey(targetPath)
  if (key === pathKey(PATH.parse(target).root)) return 'volume-root'
  if (profilePath && key === pathKey(profilePath)) return 'profile'
  if (key === pathKey(PATH.dirname(target))) return 'immediate-source-parent'
  return 'shared-ancestor'
}

function emptyFence(): Fence {
  return {
    captured: false,
    boundaryGenerationCaptured: false,
    authorityEpochCaptured: false,
    semanticEpochCaptured: false,
    sessionIdentityCaptured: false,
    sessionValueCaptured: false,
    sessionEpochCaptured: false,
    profileCaptured: false,
    readerIdentityCaptured: false,
    sessionOutsideOriginalObserved: false,
    principalAssociationAvailable: false,
    checksBeforeBoundary: 0,
    checksAfterBoundary: 0,
    expectedPublicationCheckCount: 0,
    firstChangedCheck: null,
    firstChangedPhase: null,
    boundaryGenerationEqual: null,
    authorityEpochEqual: null,
    semanticEpochEqual: null,
    sessionIdentityEqual: null,
    sessionValueEqual: null,
    sessionEpochEqual: null,
    profileEqual: null,
    readerIdentityEqual: null,
    environmentCheckCount: 0,
    environmentCurrent: null,
    environmentSnapshotIdentityEqual: null,
    receiptCheckCount: 0,
    receiptCurrent: null,
    receiptMatchesOriginal: null,
    fixtureEpochEqual: null,
    storeEpochEqual: null
  }
}

function emptyPreparation(ordinal: number, kind: Kind, caller: Caller): Preparation {
  return {
    ordinal,
    startedTick: 0,
    kind,
    role: caller.role,
    callerPhase: caller.phase,
    begun: true,
    ended: false,
    outcome: 'pending',
    errorCategory: null,
    joins: [],
    fence: emptyFence(),
    session: null,
    sessionValue: null,
    sessionEpoch: null,
    profilePath: null,
    reader: null,
    environmentSnapshot: null,
    boundaryGeneration: null,
    authorityEpoch: null,
    semanticEpoch: null,
    fixtureEpoch: null,
    storeEpoch: null,
    storeOutcome: 'not-observed',
    storeReadable: null,
    storeReceipt: null,
    storeFramePresent: null,
    storeReceiptFrameAssociated: null,
    storeFrameLookup: 'not-called',
    boundaryReadable: null,
    boundaryFramePresent: null,
    boundaryReceiptPresent: null,
    boundaryReceiptMatchesStore: null,
    verifiedBoundaryOutcome: 'not-observed',
    verifiedBoundaryErrorCategory: null,
    boundaryObject: null,
    boundaryReceipt: null,
    sources: [],
    controller: Object.create(null) as object,
    boundaryReturned: false,
    boundaryReturnedTick: null,
    expectedPublication: false,
    expectedPublicationTick: null,
    stageAtEnd: 'pending'
  }
}

export type AuthAuthorityDiagnostic = ReturnType<typeof createAuthAuthorityDiagnostic>

export function createAuthAuthorityDiagnostic(options: { enabled: boolean; outputPath?: string; profilePath: string }) {
  let complete = options.enabled && !!options.outputPath
  let overflowReason: 'event-limit' | 'preparation-limit' | 'source-limit' | 'sidecar-limit' | 'byte-limit' | null =
    null
  let observerFailure = false
  let cleanupFailure = false
  let caseOutcome: 'interrupted' | 'replacement-assertion-failed' | 'replacement-assertion-passed' | 'complete' =
    'interrupted'
  let replacementAssertion: 'unreached' | 'passed' | 'failed' = 'unreached'
  let sequence = 0
  let tick = 0
  let openPreparations = 0
  let reservedTerminalEvents = 2
  const events: Event[] = []
  const preparations: Preparation[] = []
  const callers: Record<Kind, Caller[]> = { main: [], speech: [] }
  const claimedCallers = new Set<string>()
  const preparationByPromise = new WeakMap<Promise<unknown>, Preparation>()
  const sourceByObject = new WeakMap<object, Source>()
  const sourceByPromise = new WeakMap<Promise<unknown>, Source>()
  const frameBySnapshot = new WeakMap<object, { receipt: object | null; exact: boolean }>()
  const wrappedControllers = new WeakSet<object>()
  const wrappedReaders = new WeakSet<object>()
  const sidecars = new Set<Promise<void>>()
  const trackedPreparations = new Set<Promise<unknown>>()
  let overflowWait: Promise<void> = Promise.resolve()
  const leasePreparations = new WeakMap<object, Preparation>()

  const trackOverflow = (promise: Promise<unknown>) => {
    const settled = Promise.resolve(promise).then(
      () => undefined,
      () => undefined
    )
    overflowWait = Promise.all([overflowWait, settled]).then(() => undefined)
  }

  let sourceHashes: Record<string, string> | null = null
  if (options.enabled) {
    try {
      const parsed: unknown = JSON.parse(process.env.METIS_AUTH_AUTHORITY_SOURCE_HASHES ?? '')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad-source-hashes')
      const entries = Object.entries(parsed)
      if (
        entries.length !== 19 ||
        entries.some(
          ([path, hash]) =>
            !/^(?:\.github\/workflows\/qa-persistence-owners\.yml|vitest\.qa-persistence-owners\.config\.ts|package(?:-lock)?\.json|src\/main\/[A-Za-z0-9._/-]+|scripts\/qa\/fixtures\/auth-authority-diagnostic\.ts)$/.test(
              path
            ) ||
            typeof hash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(hash)
        )
      )
        throw new Error('bad-source-hashes')
      sourceHashes = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
    } catch {
      complete = false
    }
  }

  const fault = () => {
    observerFailure = true
    complete = false
  }

  const incrementFence = (
    prep: Preparation,
    key: 'checksBeforeBoundary' | 'checksAfterBoundary' | 'environmentCheckCount' | 'receiptCheckCount'
  ) => {
    if (prep.fence[key] >= MAX_EVENTS) {
      overflowReason ??= 'event-limit'
      complete = false
      return
    }
    prep.fence[key] += 1
  }

  const noteFirstChanged = (prep: Preparation, same: boolean) => {
    if (same || prep.fence.firstChangedCheck !== null) return
    if (++tick > MAX_TICKS) {
      complete = false
      return
    }
    prep.fence.firstChangedCheck = tick
    prep.fence.firstChangedPhase = prep.expectedPublication
      ? 'expected-publication'
      : prep.boundaryReturned
        ? 'after-boundary'
        : 'before-boundary'
  }

  const markBoundaryReturned = (prep: Preparation) => {
    if (prep.boundaryReturnedTick === null) {
      if (++tick > MAX_TICKS) complete = false
      prep.boundaryReturnedTick = tick
    }
    prep.boundaryReturned = true
    checkController(prep, prep.controller)
  }

  const event = (input: Omit<Event, 'sequence' | 'tick'>) => {
    if (!options.enabled) return
    try {
      const isBegin = input.kind === 'preparation-begin'
      const isEnd = input.kind === 'preparation-end'
      const isTerminal = input.kind === 'replacement-assertion' || input.kind === 'case-outcome'
      if (
        events.length >= MAX_EVENTS ||
        (!isEnd &&
          !isTerminal &&
          events.length + openPreparations + reservedTerminalEvents + 1 + Number(isBegin) > MAX_EVENTS) ||
        (isEnd && openPreparations === 0) ||
        (isTerminal && reservedTerminalEvents === 0)
      ) {
        overflowReason ??= 'event-limit'
        complete = false
        return
      }
      if (++tick > MAX_TICKS) {
        complete = false
        return
      }
      events.push({ sequence: sequence++, tick, ...input })
      if (isBegin) openPreparations += 1
      if (isEnd) openPreparations -= 1
      if (isTerminal) reservedTerminalEvents -= 1
    } catch {
      fault()
    }
  }

  const side = <T>(
    original: Promise<T>,
    onValue: (value: T) => void,
    onError: (error: unknown) => void
  ): Promise<T> => {
    if (options.enabled) {
      try {
        const task = Promise.resolve(original).then(
          (value) => {
            try {
              onValue(value)
            } catch {
              fault()
            }
          },
          (error: unknown) => {
            try {
              onError(error)
            } catch {
              fault()
            }
          }
        )
        const settled = task.then(
          () => undefined,
          () => {
            fault()
          }
        )
        if (sidecars.size < MAX_SIDECARS) {
          sidecars.add(settled)
          void settled.then(
            () => sidecars.delete(settled),
            () => sidecars.delete(settled)
          )
        } else {
          overflowReason ??= 'sidecar-limit'
          complete = false
        }
      } catch {
        fault()
      }
    }
    return original
  }

  const sourceFor = (prep: Preparation | null, path: string): Source | null => {
    if (!options.enabled || !prep) return null
    try {
      if (path.length > 1024 || options.profilePath.length > 1024) {
        overflowReason ??= 'source-limit'
        complete = false
        return null
      }
      const key = pathKey(path)
      const found = sourceRole(path, options.profilePath)
      const inherited = sourceContext.getStore()
      if (inherited?.preparation === prep && inherited.source?.key === key) return inherited.source
      if (prep.sources.length >= MAX_SOURCES_PER_PREPARATION) {
        overflowReason ??= 'source-limit'
        complete = false
        return null
      }
      const value: Source = {
        ordinal: prep.sources.length + 1,
        role: found,
        path,
        key,
        profilePath: options.profilePath,
        captureCount: 0,
        validationCount: 0,
        missing: new Set(),
        captured: new Map(),
        captureOutcome: 'not-observed',
        boundedOutcome: 'not-observed',
        managedOutcome: 'not-observed',
        validationOutcome: 'not-observed',
        validationCategory: null,
        failureCategory: null,
        observerMembership: found ? 'observed' : 'unavailable',
        unchangedPathCount: 0,
        changedPathCount: 0,
        absenceAppearedCount: 0,
        sourceDisappearedCount: 0,
        firstDivergence: null
      }
      prep.sources.push(value)
      if (!found) complete = false
      return value
    } catch {
      fault()
      return null
    }
  }

  const context = (): Context => sourceContext.getStore() ?? { preparation: null, source: null, stage: null }
  const callerKey = (kind: Kind, caller: Caller) => `${kind}:${caller.role}:${caller.phase}`

  const beginSource = <T>(
    path: string,
    stage: 'capture-pin' | 'read-check' | 'validate',
    originalCall: () => T,
    heldSource?: Source | null
  ): T => {
    if (!options.enabled) return originalCall()
    const inherited = context()
    const source = heldSource ?? sourceFor(inherited.preparation, path)
    if (!source) return originalCall()
    return sourceContext.run({ ...inherited, source, stage }, originalCall)
  }

  const captureSession = (prep: Preparation, session: unknown) => {
    if (prep.kind === 'speech') {
      prep.fence.sessionOutsideOriginalObserved = true
      return
    }
    const sessionValid = session === null || typeof session === 'object'
    const actualSession = sessionValid && session && typeof session === 'object' ? session : null
    const value = actualSession
      ? (() => {
          const record = actualSession as Record<string, unknown>
          return JSON.stringify([record.email, record.domain, record.tid, record.at])
        })()
      : null
    if (!prep.fence.captured) {
      const view = prep.controller as {
        boundaryGeneration?: number
        authorityEpoch?: number
        semanticEpoch?: number
        readers?: object | null
        dependencies?: { readMainPersistenceBoundary?: object | null }
      }
      prep.fence.captured = true
      prep.session = actualSession
      prep.sessionValue = value
      prep.boundaryGeneration = Number.isSafeInteger(view.boundaryGeneration) ? Number(view.boundaryGeneration) : null
      prep.authorityEpoch = Number.isSafeInteger(view.authorityEpoch) ? Number(view.authorityEpoch) : null
      prep.semanticEpoch = Number.isSafeInteger(view.semanticEpoch) ? Number(view.semanticEpoch) : null
      prep.reader = (prep.kind === 'main' ? view.dependencies?.readMainPersistenceBoundary : view.readers) ?? null
      prep.fence.sessionIdentityCaptured = sessionValid
      prep.fence.sessionValueCaptured = sessionValid && (value !== null || session === null)
      prep.fence.boundaryGenerationCaptured = prep.boundaryGeneration !== null
      prep.fence.authorityEpochCaptured = prep.authorityEpoch !== null
      prep.fence.semanticEpochCaptured = prep.semanticEpoch !== null
      prep.fence.readerIdentityCaptured = prep.reader !== null
    } else if (prep.kind === 'main') {
      const identityEqual = sessionValid ? prep.session === actualSession : null
      const valueEqual = sessionValid ? prep.sessionValue === value : null
      if (identityEqual !== null) {
        prep.fence.sessionIdentityEqual =
          prep.fence.sessionIdentityEqual === null ? identityEqual : prep.fence.sessionIdentityEqual && identityEqual
        noteFirstChanged(prep, identityEqual)
      }
      if (valueEqual !== null) {
        prep.fence.sessionValueEqual =
          prep.fence.sessionValueEqual === null ? valueEqual : prep.fence.sessionValueEqual && valueEqual
        noteFirstChanged(prep, valueEqual)
      }
    }
  }

  const captureSpeechBeforeBoundary = (prep: Preparation, controller: object, readers: unknown) => {
    if (prep.kind !== 'speech' || prep.fence.captured) return
    const view = controller as {
      boundaryGeneration?: number
      authorityEpoch?: number
      semanticEpoch?: number
      readers?: object | null
    }
    prep.fence.captured = true
    prep.boundaryGeneration = Number.isSafeInteger(view.boundaryGeneration) ? Number(view.boundaryGeneration) : null
    prep.authorityEpoch = Number.isSafeInteger(view.authorityEpoch) ? Number(view.authorityEpoch) : null
    prep.semanticEpoch = Number.isSafeInteger(view.semanticEpoch) ? Number(view.semanticEpoch) : null
    prep.reader = readers && typeof readers === 'object' ? readers : null
    prep.fence.boundaryGenerationCaptured = prep.boundaryGeneration !== null
    prep.fence.authorityEpochCaptured = prep.authorityEpoch !== null
    prep.fence.semanticEpochCaptured = prep.semanticEpoch !== null
    prep.fence.readerIdentityCaptured = prep.reader !== null && prep.reader === view.readers
    // Speech captures no session object/value before its awaited boundary. A later session read
    // belongs to later policy/currentness checks, never to this original pre-await fence.
    prep.fence.sessionIdentityCaptured = false
    prep.fence.sessionValueCaptured = false
  }

  const checkController = (prep: Preparation, controller: object) => {
    const view = controller as {
      boundaryGeneration?: number
      authorityEpoch?: number
      semanticEpoch?: number
      readers?: object | null
      dependencies?: { readMainPersistenceBoundary?: object | null }
    }
    if (!prep.fence.captured || prep.ended) return
    const afterBoundary = prep.boundaryReturned
    if (afterBoundary) incrementFence(prep, 'checksAfterBoundary')
    else incrementFence(prep, 'checksBeforeBoundary')
    if (prep.expectedPublication && prep.fence.expectedPublicationCheckCount < MAX_EVENTS)
      prep.fence.expectedPublicationCheckCount += 1
    const phase = prep.expectedPublication
      ? 'expected-publication'
      : afterBoundary
        ? 'after-boundary'
        : 'before-boundary'
    const readers =
      prep.kind === 'main' ? (view.dependencies?.readMainPersistenceBoundary ?? null) : (view.readers ?? null)
    const compare = <
      K extends 'boundaryGenerationEqual' | 'authorityEpochEqual' | 'semanticEpochEqual' | 'readerIdentityEqual'
    >(
      key: K,
      same: boolean
    ) => {
      if (phase === 'expected-publication' && (key === 'authorityEpochEqual' || key === 'semanticEpochEqual')) return
      if (prep.fence[key] === null) prep.fence[key] = same
      else if (prep.fence[key] === true && !same) prep.fence[key] = false
      noteFirstChanged(prep, same)
    }
    if (prep.boundaryGeneration !== null && Number.isSafeInteger(view.boundaryGeneration))
      compare('boundaryGenerationEqual', prep.boundaryGeneration === view.boundaryGeneration)
    if (prep.authorityEpoch !== null && Number.isSafeInteger(view.authorityEpoch))
      compare('authorityEpochEqual', prep.authorityEpoch === view.authorityEpoch)
    if (prep.semanticEpoch !== null && Number.isSafeInteger(view.semanticEpoch))
      compare('semanticEpochEqual', prep.semanticEpoch === view.semanticEpoch)
    if (prep.reader !== null) compare('readerIdentityEqual', prep.reader === readers)
  }

  return {
    enabled: options.enabled,
    queueMainRole(value: string, phase: Phase = 'post-sign-in-status') {
      const mapped = role(value)
      if (!mapped || !['reentrant-main', 'explicit-status-main', 'returned-account-speech'].includes(mapped)) {
        complete = false
        return
      }
      if (
        !['invalidation-status', 'post-sign-in-status', 'return-account-status'].includes(phase) ||
        callers.main.length >= MAX_PREPARATIONS ||
        claimedCallers.has(callerKey('main', { role: mapped, phase }))
      ) {
        overflowReason ??= 'preparation-limit'
        complete = false
        return
      }
      claimedCallers.add(callerKey('main', { role: mapped, phase }))
      callers.main.push({ role: mapped, phase })
    },
    queueSpeechRole(value: string) {
      const mapped = role(value)
      if (
        !mapped ||
        !['initial-speech', 'held-old-speech', 'replacement-speech', 'returned-account-speech'].includes(mapped)
      ) {
        complete = false
        return
      }
      if (
        callers.speech.length >= MAX_PREPARATIONS ||
        claimedCallers.has(callerKey('speech', { role: mapped, phase: 'request' }))
      ) {
        overflowReason ??= 'preparation-limit'
        complete = false
        return
      }
      claimedCallers.add(callerKey('speech', { role: mapped, phase: 'request' }))
      callers.speech.push({ role: mapped, phase: 'request' })
    },
    noteReplacementAssertion(passed: boolean) {
      replacementAssertion = passed ? 'passed' : 'failed'
      caseOutcome = passed ? 'replacement-assertion-passed' : 'replacement-assertion-failed'
      const replacement = preparations.find((prep) => prep.kind === 'speech' && prep.role === 'replacement-speech')
      if (!replacement?.ended) complete = false
      event({
        kind: 'replacement-assertion',
        ordinal: replacement?.ordinal ?? null,
        role: 'replacement-speech',
        phase: 'request',
        status: replacementAssertion
      })
    },
    noteCaseComplete() {
      caseOutcome = 'complete'
      const returned = preparations.find((prep) => prep.kind === 'speech' && prep.role === 'returned-account-speech')
      if (!returned?.ended) complete = false
      event({
        kind: 'case-outcome',
        ordinal: returned?.ordinal ?? null,
        role: 'returned-account-speech',
        phase: 'request',
        status: caseOutcome
      })
    },
    noteObserverFailure() {
      fault()
    },
    noteCleanupFailure() {
      cleanupFailure = true
      complete = false
    },
    runController<T>(controller: object, kind: Kind, originalCall: () => Promise<T>): Promise<T> {
      const caller = callers[kind].shift() ?? null
      const prior = context()
      if (!options.enabled) {
        let original: Promise<T>
        try {
          original = sourceContext.run(
            { preparation: prior.preparation, source: prior.source, stage: prior.stage },
            originalCall
          )
        } catch (error) {
          throw error
        }
        if (trackedPreparations.size < MAX_PREPARATIONS) trackedPreparations.add(original)
        else {
          overflowReason ??= 'preparation-limit'
          trackOverflow(original)
        }
        side(
          original,
          () => undefined,
          () => undefined
        )
        return original
      }
      const chosenCaller: Caller = caller ?? { role: 'returned-account-speech', phase: 'unassigned' }
      if (!caller) complete = false
      if (
        caller &&
        !(kind === 'speech'
          ? caller.phase === 'request' &&
            ['initial-speech', 'held-old-speech', 'replacement-speech', 'returned-account-speech'].includes(caller.role)
          : (caller.role === 'reentrant-main' && caller.phase === 'invalidation-status') ||
            (caller.role === 'explicit-status-main' && caller.phase === 'post-sign-in-status') ||
            (caller.role === 'returned-account-speech' && caller.phase === 'return-account-status'))
      )
        complete = false
      const provisional = emptyPreparation(preparations.length + 1, kind, chosenCaller)
      if (++tick > MAX_TICKS) complete = false
      provisional.startedTick = tick
      provisional.controller = controller
      let original: Promise<T>
      const existing = (() => {
        try {
          const p = sourceContext.run(
            { preparation: provisional, source: prior.source, stage: prior.stage },
            originalCall
          )
          original = p
          return preparationByPromise.get(p)
        } catch (error) {
          throw error
        }
      })()
      if (existing) {
        if (existing.joins.length < 8) existing.joins.push(chosenCaller)
        else {
          overflowReason ??= 'preparation-limit'
          complete = false
        }
        event({
          kind: 'caller-join',
          ordinal: existing.ordinal,
          role: chosenCaller.role,
          phase: chosenCaller.phase,
          status: 'joined-existing'
        })
        return original!
      }
      if (preparations.length >= MAX_PREPARATIONS) {
        overflowReason ??= 'preparation-limit'
        complete = false
        trackOverflow(original!)
        side(
          original!,
          () => undefined,
          () => undefined
        )
        return original!
      }
      const prep = provisional
      preparations.push(prep)
      event({
        kind: 'preparation-begin',
        ordinal: prep.ordinal,
        role: chosenCaller.role,
        phase: chosenCaller.phase,
        status: kind
      })
      trackedPreparations.add(original!)
      preparationByPromise.set(original!, prep)
      side(
        original!,
        (value) => {
          prep.ended = true
          prep.stageAtEnd = !prep.fence.captured
            ? 'before-original-capture'
            : prep.boundaryReturned
              ? 'after-boundary-return'
              : 'before-boundary-return'
          prep.outcome = value === null ? 'fulfilled-null' : 'fulfilled-present'
          if (kind === 'speech' && value && typeof value === 'object') leasePreparations.set(value as object, prep)
          if (value === null && prep.role !== 'held-old-speech') prep.errorCategory = 'unclassified-refusal'
          event({
            kind: 'preparation-end',
            ordinal: prep.ordinal,
            role: prep.role,
            phase: prep.callerPhase,
            status: prep.outcome
          })
        },
        (error) => {
          prep.ended = true
          prep.stageAtEnd = !prep.fence.captured
            ? 'before-original-capture'
            : prep.boundaryReturned
              ? 'after-boundary-return'
              : 'before-boundary-return'
          prep.outcome = 'rejected'
          prep.errorCategory = category(error)
          event({
            kind: 'preparation-end',
            ordinal: prep.ordinal,
            role: prep.role,
            phase: prep.callerPhase,
            status: 'rejected'
          })
        }
      )
      return original!
    },
    attachController(controller: object) {
      if (!options.enabled || wrappedControllers.has(controller)) return
      wrappedControllers.add(controller)
      const view = controller as {
        dependencies?: Record<string, unknown>
        readers?: object
      }
      const deps = view.dependencies
      if (!deps) {
        complete = false
        return
      }
      const wrap = (key: string, observe: (result: unknown, prep: Preparation | null, self: unknown) => void) => {
        const original = deps[key]
        if (typeof original !== 'function') return
        deps[key] = function (this: unknown, ...args: unknown[]) {
          const result = Reflect.apply(original, this, args)
          try {
            observe(result, context().preparation, controller)
          } catch {
            fault()
          }
          return result
        }
      }
      wrap('readSession', (result, prep) => {
        if (!prep) return
        captureSession(prep, result)
        checkController(prep, controller)
      })
      wrap('readSessionEpoch', (result, prep) => {
        if (!prep || !Number.isSafeInteger(result)) return
        if (prep.sessionEpoch === null) {
          prep.sessionEpoch = Number(result)
          prep.fence.sessionEpochCaptured = true
        } else {
          const same = prep.sessionEpoch === result
          prep.fence.sessionEpochEqual =
            prep.fence.sessionEpochEqual === null ? same : prep.fence.sessionEpochEqual && same
          noteFirstChanged(prep, same)
        }
        checkController(prep, controller)
      })
      wrap('readProfilePath', (result, prep) => {
        if (!prep || typeof result !== 'string') return
        if (prep.profilePath === null) {
          prep.profilePath = result
          prep.fence.profileCaptured = true
        } else {
          const same = prep.profilePath === result
          prep.fence.profileEqual = prep.fence.profileEqual === null ? same : prep.fence.profileEqual && same
          noteFirstChanged(prep, same)
        }
        checkController(prep, controller)
      })
      const originalBoundary = deps.readBoundary
      if (typeof originalBoundary !== 'function') complete = false
      else
        deps.readBoundary = function (this: unknown, ...args: unknown[]) {
          const prep = context().preparation
          if (prep) {
            try {
              captureSpeechBeforeBoundary(prep, controller, args[0])
            } catch {
              fault()
            }
          }
          let result: Promise<unknown>
          try {
            result = Reflect.apply(originalBoundary, this, args) as Promise<unknown>
          } catch (error) {
            if (prep) {
              markBoundaryReturned(prep)
              prep.errorCategory = category(error)
            }
            throw error
          }
          if (prep)
            side(
              result,
              (boundary) => {
                markBoundaryReturned(prep)
                if (boundary && typeof boundary === 'object') prep.boundaryObject = boundary
                else prep.boundaryFramePresent = false
              },
              (error) => {
                markBoundaryReturned(prep)
                prep.errorCategory = category(error)
              }
            )
          return result
        }
      const viewWithSettings = controller as { observeSettings?: (...args: unknown[]) => unknown }
      const originalObserveSettings = viewWithSettings.observeSettings
      if (typeof originalObserveSettings !== 'function') complete = false
      else
        viewWithSettings.observeSettings = function (this: unknown, ...args: unknown[]) {
          const result = Reflect.apply(originalObserveSettings, this, args)
          const prep = context().preparation
          if (prep) {
            if (prep.expectedPublicationTick === null) {
              if (++tick > MAX_TICKS) complete = false
              prep.expectedPublicationTick = tick
            }
            prep.expectedPublication = true
          }
          return result
        }
      wrap('readMainPersistenceBoundary', (result, prep) => {
        if (!prep || !result || typeof (result as Promise<unknown>).then !== 'function') return
        side(
          result as Promise<unknown>,
          (boundary) => {
            markBoundaryReturned(prep)
            if (boundary && typeof boundary === 'object') prep.boundaryObject = boundary as object
            else prep.boundaryFramePresent = false
            const observation =
              boundary && typeof boundary === 'object'
                ? (boundary as { observation?: { readable?: unknown; authoritySnapshot?: unknown } | null }).observation
                : null
            const snapshot =
              observation?.authoritySnapshot && typeof observation.authoritySnapshot === 'object'
                ? (observation.authoritySnapshot as {
                    readable?: unknown
                    epoch?: unknown
                    history?: { persistence?: unknown } | null
                  })
                : null
            const receipt = snapshot?.history?.persistence
            if (snapshot) {
              if (prep.storeOutcome === 'not-observed')
                prep.storeOutcome = snapshot.readable === true ? 'returned-readable' : 'returned-unreadable'
              prep.storeReadable = snapshot.readable === true
              const epoch = Number.isSafeInteger(snapshot.epoch) ? Number(snapshot.epoch) : null
              if (prep.storeEpoch === null) prep.storeEpoch = epoch
              else
                prep.fence.storeEpochEqual =
                  prep.fence.storeEpochEqual === null
                    ? prep.storeEpoch === epoch
                    : prep.fence.storeEpochEqual && prep.storeEpoch === epoch
              prep.storeReceipt = receipt && typeof receipt === 'object' ? receipt : null
              if (snapshot.readable !== true || !prep.storeReceipt) {
                prep.storeFramePresent = false
                prep.storeReceiptFrameAssociated = false
              }
            }
            prep.boundaryReadable = snapshot ? snapshot.readable === true : null
            const frame = snapshot ? frameBySnapshot.get(snapshot as object) : undefined
            if (frame) prep.storeReceiptFrameAssociated = frame.receipt === prep.storeReceipt && frame.exact
            else if (snapshot?.readable === true && prep.storeReceipt) prep.storeReceiptFrameAssociated = null
          },
          () => {
            markBoundaryReturned(prep)
            prep.boundaryReadable = false
            prep.errorCategory = 'unclassified-refusal'
          }
        )
      })
      const receiptCurrent = deps.isPersistenceSettingsReceiptCurrent
      if (typeof receiptCurrent === 'function') {
        deps.isPersistenceSettingsReceiptCurrent = function (this: unknown, receipt: object) {
          const result = Reflect.apply(receiptCurrent, this, [receipt])
          const prep = context().preparation
          if (prep) {
            incrementFence(prep, 'receiptCheckCount')
            prep.fence.receiptCurrent =
              prep.fence.receiptCurrent === null ? result : prep.fence.receiptCurrent && result
            prep.fence.receiptMatchesOriginal = prep.boundaryReceipt ? receipt === prep.boundaryReceipt : null
          }
          return result
        }
      }
      const environmentCurrent = deps.isAuthEnvironmentSnapshotCurrent
      if (typeof environmentCurrent === 'function') {
        deps.isAuthEnvironmentSnapshotCurrent = function (this: unknown, snapshot: object) {
          const result = Reflect.apply(environmentCurrent, this, [snapshot])
          const prep = context().preparation
          if (prep && typeof result === 'boolean') {
            if (prep.environmentSnapshot !== null)
              prep.fence.environmentSnapshotIdentityEqual =
                prep.fence.environmentSnapshotIdentityEqual === null
                  ? prep.environmentSnapshot === snapshot
                  : prep.fence.environmentSnapshotIdentityEqual && prep.environmentSnapshot === snapshot
            incrementFence(prep, 'environmentCheckCount')
            prep.fence.environmentCurrent =
              prep.fence.environmentCurrent === null ? result : prep.fence.environmentCurrent && result
          }
          return result
        }
      }
    },
    wrapReaders(readers: object) {
      if (!options.enabled || wrappedReaders.has(readers)) return
      wrappedReaders.add(readers)
      const value = readers as Record<string, unknown>
      const wrap = (key: string, observe: (result: unknown, prep: Preparation | null) => void) => {
        const original = value[key]
        if (typeof original !== 'function') return
        value[key] = function (this: unknown, ...args: unknown[]) {
          const result = Reflect.apply(original, this, args)
          try {
            observe(result, context().preparation)
          } catch {
            fault()
          }
          return result
        }
      }
      wrap('readSettingsAtBoundary', (result, prep) => {
        if (!prep || !result || typeof (result as Promise<unknown>).then !== 'function') return
        side(
          result as Promise<unknown>,
          (observation) => {
            if (!observation || typeof observation !== 'object') return
            const epoch = (observation as { epoch?: unknown }).epoch
            prep.fixtureEpoch = Number.isSafeInteger(epoch) ? Number(epoch) : null
          },
          () => {
            prep.fixtureEpoch = null
          }
        )
      })
      wrap('readSettingsEpoch', (result, prep) => {
        if (!prep || !Number.isSafeInteger(result)) return
        if (prep.fixtureEpoch === null) prep.fixtureEpoch = Number(result)
        else
          prep.fence.fixtureEpochEqual =
            prep.fence.fixtureEpochEqual === null
              ? prep.fixtureEpoch === result
              : prep.fence.fixtureEpochEqual && prep.fixtureEpoch === result
      })
    },
    observeStorePromise<T extends { readable?: unknown; epoch?: unknown; history?: { persistence?: unknown } | null }>(
      original: Promise<T>
    ): Promise<T> {
      if (!options.enabled) return original
      const prep = context().preparation
      if (!prep) return original
      return side(
        original,
        (snapshot) => {
          prep.storeOutcome = snapshot.readable === true ? 'returned-readable' : 'returned-unreadable'
          prep.storeReadable = snapshot.readable === true
          const epoch = Number.isSafeInteger(snapshot.epoch) ? Number(snapshot.epoch) : null
          if (prep.storeEpoch === null) prep.storeEpoch = epoch
          else
            prep.fence.storeEpochEqual =
              prep.fence.storeEpochEqual === null
                ? prep.storeEpoch === epoch
                : prep.fence.storeEpochEqual && prep.storeEpoch === epoch
          const receipt = snapshot.history?.persistence
          prep.storeReceipt = receipt && typeof receipt === 'object' ? receipt : null
          if (snapshot.readable !== true || !prep.storeReceipt) {
            prep.storeFramePresent = false
            prep.storeReceiptFrameAssociated = false
          }
        },
        () => {
          prep.storeOutcome = 'rejected'
          prep.storeReadable = null
          prep.storeEpoch = null
          prep.storeReceipt = null
        }
      )
    },
    observeFrame(
      snapshot: { readable?: unknown; epoch?: unknown; history?: { persistence?: unknown } | null },
      frame: unknown
    ) {
      if (!options.enabled) return
      try {
        const prep = context().preparation
        const receipt = snapshot.history?.persistence
        const shape =
          frame && typeof frame === 'object' ? (frame as { snapshot?: unknown; persistenceReceipt?: unknown }) : null
        const exact = shape?.snapshot === snapshot && shape.persistenceReceipt === receipt
        frameBySnapshot.set(snapshot as object, {
          receipt: receipt && typeof receipt === 'object' ? receipt : null,
          exact
        })
        if (prep) {
          prep.storeFrameLookup = frame === null ? 'returned-null' : 'returned-frame'
          prep.storeFramePresent = frame !== null
          prep.storeReceiptFrameAssociated = exact
        }
      } catch {
        fault()
      }
    },
    observeVerifiedBoundary(boundary: object, result: boolean) {
      if (!options.enabled) return
      const prep = context().preparation
      if (!prep) return
      if (prep.boundaryObject !== boundary) {
        complete = false
        prep.verifiedBoundaryOutcome = 'unknown'
        return
      }
      prep.boundaryFramePresent = result
    },
    observeBoundaryReceipt(boundary: object, receipt: object | null) {
      if (!options.enabled) return
      const prep = context().preparation
      if (!prep) return
      if (prep.boundaryObject !== boundary) {
        complete = false
        prep.boundaryReceiptPresent = null
        prep.boundaryReceiptMatchesStore = null
        return
      }
      prep.boundaryReceiptPresent = receipt !== null
      prep.boundaryReceipt = receipt
      prep.boundaryReceiptMatchesStore = prep.storeReceipt ? prep.storeReceipt === receipt : null
    },
    observeBoundaryEnvironment(boundary: object, snapshot: object | null) {
      if (!options.enabled) return
      const prep = context().preparation
      if (!prep) return
      if (prep.boundaryObject !== boundary || !snapshot) {
        complete = false
        prep.environmentSnapshot = null
        prep.fence.environmentSnapshotIdentityEqual = null
        return
      }
      prep.environmentSnapshot = snapshot
    },
    observeVerifiedBoundaryCurrent(boundary: object, original: Promise<void>): Promise<void> {
      if (!options.enabled) return original
      const prep = context().preparation
      if (!prep) return original
      if (prep.boundaryObject !== boundary) {
        complete = false
        prep.verifiedBoundaryOutcome = 'unknown'
        return side(
          original,
          () => undefined,
          () => undefined
        )
      }
      return side(
        original,
        () => {
          prep.verifiedBoundaryOutcome = 'current'
        },
        (error) => {
          prep.verifiedBoundaryOutcome = 'refused'
          prep.verifiedBoundaryErrorCategory = category(error)
        }
      )
    },
    observeStoreEpoch(value: number): number {
      if (options.enabled && Number.isSafeInteger(value)) {
        const prep = context().preparation
        if (prep) {
          if (prep.storeEpoch === null) prep.storeEpoch = value
          else
            prep.fence.storeEpochEqual =
              prep.fence.storeEpochEqual === null
                ? prep.storeEpoch === value
                : prep.fence.storeEpochEqual && prep.storeEpoch === value
        }
      }
      return value
    },
    runPinCapture<T>(path: string, originalCall: () => Promise<T>): Promise<T> {
      if (!options.enabled) return originalCall()
      const prep = context().preparation
      const source = sourceFor(prep, path)
      const original = beginSource(path, 'capture-pin', originalCall, source)
      return side(
        original,
        (pin) => {
          if (pin && typeof pin === 'object' && source) {
            source.captureOutcome = 'captured'
            sourceByObject.set(pin as object, source)
          } else if (source) {
            source.captureOutcome = 'invalid'
            source.failureCategory ??= 'unclassified-refusal'
          }
        },
        () => {
          if (source) {
            source.captureOutcome = 'invalid'
            source.failureCategory ??= 'unclassified-refusal'
          }
        }
      )
    },
    runPinValidation<T>(pin: object, originalCall: () => Promise<T>): Promise<T> {
      if (!options.enabled) return originalCall()
      const source = sourceByObject.get(pin) ?? null
      if (!source) {
        const inherited = context()
        if (inherited.preparation) {
          complete = false
          if (inherited.source) inherited.source.observerMembership = 'unavailable'
        }
        return originalCall()
      }
      return side(
        beginSource(source.path, 'validate', originalCall, source),
        () => {
          source.validationOutcome = 'current'
        },
        (error) => {
          source.validationOutcome = 'refused'
          const failure = source.validationCategory ?? category(error)
          source.validationCategory = failure
          source.failureCategory = failure
        }
      )
    },
    runReadCapture<T extends object>(path: string, originalCall: () => Promise<T>): Promise<T> {
      if (!options.enabled) return originalCall()
      const prep = context().preparation
      const source = sourceFor(prep, path)
      const original = beginSource(path, 'read-check', originalCall, source)
      if (source) sourceByPromise.set(original as Promise<unknown>, source)
      return side(
        original,
        (read) => {
          if (source) {
            sourceByObject.set(read, source)
          }
        },
        () => {
          if (source) {
            source.captureOutcome = 'invalid'
            source.failureCategory ??= 'unclassified-refusal'
          }
        }
      )
    },
    runReadValidation<T>(read: object, originalCall: () => Promise<T>): Promise<T> {
      if (!options.enabled) return originalCall()
      const source = sourceByObject.get(read)
      if (!source) {
        if (context().preparation) {
          complete = false
          if (context().source) context().source!.observerMembership = 'unavailable'
        }
        return originalCall()
      }
      return side(
        beginSource(source.path, 'validate', originalCall, source),
        () => {
          source.validationOutcome = 'current'
        },
        (error) => {
          source.validationOutcome = 'refused'
          const failure = source.validationCategory ?? category(error)
          source.validationCategory = failure
          source.failureCategory = failure
        }
      )
    },
    observeBoundedRead<T extends { kind?: unknown }>(path: string, original: Promise<T>): Promise<T> {
      if (!options.enabled) return original
      const source = sourceByPromise.get(original as Promise<unknown>) ?? null
      if (!source) complete = false
      return side(
        original,
        (read) => {
          const value = read?.kind
          if (source) {
            source.boundedOutcome = value === 'present' || value === 'absent' || value === 'invalid' ? value : 'unknown'
            if (source.boundedOutcome === 'invalid' || source.boundedOutcome === 'unknown')
              source.failureCategory ??= 'unclassified-refusal'
          }
        },
        () => {
          if (source) {
            source.boundedOutcome = 'unknown'
            source.failureCategory ??= 'unclassified-refusal'
          }
        }
      )
    },
    observeManagedRead<T extends { status?: unknown }>(path: string, originalCall: () => Promise<T>): Promise<T> {
      if (!options.enabled) return originalCall()
      const prep = context().preparation
      const source = sourceFor(prep, path)
      const scoped = beginSource(path, 'read-check', originalCall, source)
      return side(
        scoped,
        (read) => {
          const value = read?.status
          if (source) {
            source.managedOutcome = value === 'present' || value === 'absent' || value === 'invalid' ? value : 'unknown'
            if (source.managedOutcome === 'invalid' || source.managedOutcome === 'unknown')
              source.failureCategory ??= 'unclassified-refusal'
            if (read && typeof read === 'object') sourceByObject.set(read as object, source)
          }
        },
        () => {
          if (source) {
            source.managedOutcome = 'unknown'
            source.failureCategory ??= 'unclassified-refusal'
          }
        }
      )
    },
    observeManagedValidation<T>(read: object, originalCall: () => Promise<T>): Promise<T> {
      if (!options.enabled) return originalCall()
      const source = sourceByObject.get(read)
      if (!source) {
        if (context().preparation) {
          complete = false
          if (context().source) context().source!.observerMembership = 'unavailable'
        }
        return originalCall()
      }
      return side(
        beginSource(source.path, 'validate', originalCall, source),
        () => {
          source.validationOutcome = 'current'
        },
        (error) => {
          source.validationOutcome = 'refused'
          source.validationCategory ??= category(error)
          source.failureCategory = source.validationCategory
        }
      )
    },
    observeAdminBytes(path: string | null, original: Promise<Uint8Array | null>): Promise<Uint8Array | null> {
      if (!options.enabled) return original
      const source = path ? sourceFor(context().preparation, path) : null
      return side(
        original,
        (bytes) => {
          if (source) source.boundedOutcome = bytes === null ? 'unknown' : 'present'
        },
        () => {
          if (source) {
            source.boundedOutcome = 'unknown'
            source.failureCategory ??= 'unclassified-refusal'
          }
        }
      )
    },
    observeCurrentness(controller: object, lease: object | null, originalCall: () => boolean): boolean {
      const result = originalCall()
      if (options.enabled) {
        const prep = lease ? (leasePreparations.get(lease) ?? null) : context().preparation
        if (prep) {
          try {
            checkController(prep, controller)
            event({
              kind: 'currentness',
              ordinal: prep.ordinal,
              role: prep.role,
              phase: prep.callerPhase,
              status: result ? 'current' : 'retired'
            })
          } catch {
            fault()
          }
        }
      }
      return result
    },
    observeLstat(path: string, value: unknown) {
      if (!options.enabled) return
      try {
        const { source, stage } = context()
        if (!source || !stage) return
        const current = statValue(value)
        if (!current) {
          complete = false
          source.observerMembership = 'unavailable'
          return
        }
        const key = pathKey(path)
        if (stage === 'capture-pin') {
          if (source.captureCount >= 65) {
            overflowReason ??= 'source-limit'
            complete = false
            return
          }
          if (
            !source.captured.has(key) &&
            !source.missing.has(key) &&
            source.captured.size + source.missing.size >= 65
          ) {
            overflowReason ??= 'source-limit'
            complete = false
            return
          }
          source.captureCount += 1
          if (!source.captured.has(key) && !source.missing.has(key)) source.captured.set(key, { stat: current })
          else {
            const original = source.captured.get(key)
            if (!original || !Object.values(sameStat(original.stat, current)).every(Boolean)) {
              source.observerMembership = 'unavailable'
              complete = false
            }
          }
          return
        }
        if (source.validationCount >= 65) {
          overflowReason ??= 'source-limit'
          complete = false
          return
        }
        source.validationCount += 1
        const original = source.captured.get(key)
        if (!original) {
          if (source.missing.has(key)) source.absenceAppearedCount += 1
          else {
            source.observerMembership = 'unavailable'
            if (source.captureOutcome === 'not-observed') source.captureOutcome = 'unknown'
          }
          return
        }
        const fields = sameStat(original.stat, current)
        if (Object.values(fields).every(Boolean)) {
          source.unchangedPathCount += 1
          return
        }
        source.changedPathCount += 1
        if (!source.firstDivergence) {
          if (++tick > MAX_TICKS) {
            complete = false
            return
          }
          const target = key === pathKey(source.path)
          source.firstDivergence = {
            atTick: tick,
            depth: pathDepth(key, source.path),
            relation: target ? null : relation(key, source.path, source.profilePath),
            target,
            fields
          }
        }
      } catch {
        fault()
      }
    },
    observeLstatFailure(path: string, error: unknown) {
      if (!options.enabled) return
      try {
        const { source, stage } = context()
        if (!source || !stage) return
        const key = pathKey(path)
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null
        const originalMissing = stage === 'capture-pin' && code === 'ENOENT'
        if (originalMissing) {
          if (source.captureCount >= 65) {
            overflowReason ??= 'source-limit'
            complete = false
            return
          }
          if (
            !source.missing.has(key) &&
            !source.captured.has(key) &&
            source.captured.size + source.missing.size >= 65
          ) {
            overflowReason ??= 'source-limit'
            complete = false
            return
          }
          source.missing.add(key)
          source.captureCount += 1
          return
        }
        if (stage === 'validate' || stage === 'read-check') {
          if (source.validationCount >= 65) {
            overflowReason ??= 'source-limit'
            complete = false
            return
          }
          source.validationCount += 1
          if (code === 'ENOENT') {
            if (source.missing.has(key)) source.unchangedPathCount += 1
            else if (source.captured.has(key)) {
              source.sourceDisappearedCount += 1
              source.validationOutcome = 'refused'
              source.validationCategory = 'source-disappeared'
              source.failureCategory = 'source-disappeared'
            } else {
              source.observerMembership = 'unavailable'
              if (source.captureOutcome === 'not-observed') source.captureOutcome = 'unknown'
            }
            return
          }
          const classified = category(error)
          source.validationOutcome = 'refused'
          const exactTransition =
            code === 'ENOENT'
              ? source.missing.has(key)
                ? 'absence-appeared'
                : source.captured.has(key)
                  ? 'source-disappeared'
                  : 'unknown-membership'
              : errorCategories.has(classified)
                ? classified
                : 'unclassified-refusal'
          source.validationCategory = exactTransition
          source.failureCategory = exactTransition
        }
      } catch {
        fault()
      }
    },
    noteFenceCheck(_result: boolean) {
      // Auth config checks are recorded through the exact controller dependency invocation only.
      // This method remains a benign compatibility hook for an old test bridge call site.
    },
    async waitForObserved() {
      await Promise.allSettled([...trackedPreparations])
      await overflowWait
      while (sidecars.size) await Promise.allSettled([...sidecars])
    },
    async flush() {
      await this.waitForObserved()
      if (!options.enabled || !options.outputPath) return
      const required = [
        'initial-speech',
        'held-old-speech',
        'reentrant-main',
        'explicit-status-main',
        'replacement-speech'
      ] as const
      const seenRoles = new Set(preparations.map((prep) => prep.role).filter((item): item is Role => item !== null))
      for (const expected of required) {
        if (seenRoles.has(expected) || preparations.some((prep) => prep.joins.some((join) => join.role === expected)))
          continue
        complete = false
      }
      const hasCaller = (expectedRole: Role, expectedPhase: Phase) =>
        preparations.some(
          (prep) =>
            (prep.role === expectedRole && prep.callerPhase === expectedPhase) ||
            prep.joins.some((join) => join.role === expectedRole && join.phase === expectedPhase)
        )
      if (!hasCaller('reentrant-main', 'invalidation-status')) complete = false
      if (!hasCaller('explicit-status-main', 'post-sign-in-status')) complete = false
      if (replacementAssertion === 'passed') {
        if (!hasCaller('returned-account-speech', 'return-account-status')) complete = false
        if (!hasCaller('returned-account-speech', 'request')) complete = false
      }
      if (replacementAssertion === 'failed') {
        caseOutcome = 'replacement-assertion-failed'
      } else if (replacementAssertion === 'unreached') {
        complete = false
      } else if (replacementAssertion === 'passed' && caseOutcome !== 'complete') {
        complete = false
      }
      if (preparations.some((prep) => !prep.begun || !prep.ended || prep.outcome === 'pending')) complete = false
      if (callers.main.length !== 0 || callers.speech.length !== 0) complete = false
      if (overflowReason || observerFailure || !sourceHashes) complete = false
      const unreached =
        replacementAssertion === 'failed'
          ? [
              { phase: 'returned-account-status', reason: 'replacement-assertion-failed' },
              { phase: 'returned-account-speech', reason: 'replacement-assertion-failed' }
            ]
          : []
      const base = {
        schema: 'metis-auth-authority-diagnostic/v2',
        sourceHead: process.env.GITHUB_SHA ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        job: process.env.GITHUB_JOB ?? null,
        target: process.env.TARGET ?? null,
        runtime: { version: process.version, platform: process.platform, arch: process.arch },
        sourceHashes,
        caseId: 'auth-sign-in-replacement',
        caseOutcome,
        replacementAssertion,
        unreached,
        collectorComplete: complete,
        observerFailure,
        cleanupFailure,
        overflowReason,
        limits: {
          preparations: MAX_PREPARATIONS,
          sourcesPerPreparation: MAX_SOURCES_PER_PREPARATION,
          events: MAX_EVENTS,
          bytes: MAX_BYTES
        },
        unhandledErrorCount: { value: null, availability: 'not-in-pinned-vitest-json' as const },
        events,
        preparations: preparations.map((prep) => ({
          ordinal: prep.ordinal,
          startedTick: prep.startedTick,
          kind: prep.kind,
          role: prep.role,
          callerPhase: prep.callerPhase,
          begun: prep.begun,
          ended: prep.ended,
          outcome: prep.outcome,
          stageAtEnd: prep.stageAtEnd,
          boundaryReturnedTick: prep.boundaryReturnedTick,
          expectedPublicationTick: prep.expectedPublicationTick,
          errorCategory: prep.errorCategory,
          verifiedBoundaryOutcome: prep.verifiedBoundaryOutcome,
          verifiedBoundaryErrorCategory: prep.verifiedBoundaryErrorCategory,
          joins: prep.joins,
          fence: prep.fence,
          fixtureEpochCaptured: prep.fixtureEpoch !== null,
          storeEpochCaptured: prep.storeEpoch !== null,
          storeReadable: prep.storeReadable,
          storeOutcome: prep.storeOutcome,
          storeFramePresent: prep.storeFramePresent,
          storeFrameLookup: prep.storeFrameLookup,
          storeReceiptPresent: prep.storeReceipt !== null,
          storeReceiptFrameAssociated: prep.storeReceiptFrameAssociated,
          principalAssociationAvailable: prep.fence.principalAssociationAvailable,
          boundaryReadable: prep.boundaryReadable,
          boundaryFramePresent: prep.boundaryFramePresent,
          boundaryReceiptPresent: prep.boundaryReceiptPresent,
          boundaryReceiptMatchesStore: prep.boundaryReceiptMatchesStore,
          sources: prep.sources.map((source) => ({
            ordinal: source.ordinal,
            role: source.role,
            captureCount: source.captureCount,
            validationCount: source.validationCount,
            captureOutcome: source.captureOutcome,
            boundedOutcome: source.boundedOutcome,
            managedOutcome: source.managedOutcome,
            validationOutcome: source.validationOutcome,
            validationCategory: source.validationCategory,
            failureCategory: source.failureCategory,
            observerMembership: source.observerMembership,
            unchangedPathCount: source.unchangedPathCount,
            changedPathCount: source.changedPathCount,
            absenceAppearedCount: source.absenceAppearedCount,
            sourceDisappearedCount: source.sourceDisappearedCount,
            firstDivergence: source.firstDivergence
          }))
        }))
      }
      let payload = `${JSON.stringify(base)}\n`
      if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) {
        complete = false
        overflowReason = 'byte-limit'
        payload = `${JSON.stringify({
          schema: 'metis-auth-authority-diagnostic/v2',
          sourceHead: process.env.GITHUB_SHA ?? null,
          runId: process.env.GITHUB_RUN_ID ?? null,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
          job: process.env.GITHUB_JOB ?? null,
          target: process.env.TARGET ?? null,
          runtime: { version: process.version, platform: process.platform, arch: process.arch },
          sourceHashes: null,
          caseId: 'auth-sign-in-replacement',
          caseOutcome,
          replacementAssertion,
          unreached:
            replacementAssertion === 'failed'
              ? [
                  { phase: 'returned-account-status', reason: 'replacement-assertion-failed' },
                  { phase: 'returned-account-speech', reason: 'replacement-assertion-failed' }
                ]
              : [],
          collectorComplete: false,
          observerFailure,
          cleanupFailure,
          overflowReason,
          limits: {
            preparations: MAX_PREPARATIONS,
            sourcesPerPreparation: MAX_SOURCES_PER_PREPARATION,
            events: MAX_EVENTS,
            bytes: MAX_BYTES
          },
          unhandledErrorCount: { value: null, availability: 'not-in-pinned-vitest-json' },
          events: [],
          preparations: []
        })}\n`
      } else if (!complete) base.collectorComplete = false
      try {
        writeFileSync(options.outputPath, payload, { flag: 'wx', mode: 0o600 })
      } catch {
        complete = false
      }
    }
  }
}
