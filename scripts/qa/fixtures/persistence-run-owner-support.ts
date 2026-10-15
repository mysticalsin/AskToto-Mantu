import { createPrivateKey, createHash, sign } from 'node:crypto'
import { mkdir, mkdtemp, lstat, realpath, rm, chmod } from 'node:fs/promises'
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { afterAll, beforeEach, expect, inject } from 'vitest'
import { readPrivateCurrentUserAclReceipt } from '../../../src/main/win-security'
import { PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT } from '../../../src/main/persistence/native-key-intent'
import {
  QA_HEARTBEAT_SCHEMA,
  QA_LAUNCH_ENVELOPE_SCHEMA,
  compiledQaPersistenceRunContext,
  newQaPersistenceBootChallenge,
  qaPersistenceCanonical,
  type QaPersistenceLaunchPayload
} from '../../../src/main/persistence/qa-run-protocol'

const launchDomain = Buffer.from('metis-persistence-qa-launch/v1\n', 'utf8')
const heartbeatDomain = Buffer.from('metis-persistence-qa-heartbeat/v1\n', 'utf8')
const injectedString = (key: string): string => (inject as unknown as (name: string) => unknown)(key) as string
const fixturePrivateKey = createPrivateKey(injectedString('qaPersistenceFixturePrivateKeyPem'))
const fixtureBuildStamp = injectedString('qaPersistenceFixtureBuildStamp')
const sourceElectronHost = join(__dirname, 'persistence-run-owner.electron-host.ts')
const sourceChild = join(__dirname, 'persistence-run-owner.child.ts')

type DiagnosticState = 'not-started' | 'pending' | 'fulfilled' | 'rejected'
type DiagnosticError =
  | 'none'
  | 'EPIPE'
  | 'EBADF'
  | 'ECANCELED'
  | 'EIO'
  | 'ERR_STREAM_DESTROYED'
  | 'ERR_STREAM_PREMATURE_CLOSE'
  | 'known-qa-refusal'
  | 'known-profile-refusal'
  | 'injected-close'
  | 'aggregate'
  | 'other'
type DiagnosticRole =
  | 'reader3'
  | 'writer4'
  | 'profile-parent'
  | 'profile'
  | 'registry-root'
  | 'writer-lock'
  | 'probe'
  | 'other'
  | 'none'
type DiagnosticStage =
  | 'transport-open'
  | 'read-start'
  | 'read-done'
  | 'write-start'
  | 'write-done'
  | 'destroy-request'
  | 'stream-end'
  | 'stream-close'
  | 'stream-error'
  | 'native-close-start'
  | 'native-close-done'
  | 'file-open'
  | 'file-close-start'
  | 'file-close-done'
  | 'settle-start'
  | 'settle-fulfilled'
  | 'settle-rejected'
  | 'gate-held'
  | 'gate-released'
  | 'prototype-hook-armed'
  | 'parent-input-end'
  | 'parent-output-destroy'
  | 'child-exit'
  | 'fixture-refusal'
  | 'aggregate-member'
  | 'aggregate-overflow'
type DiagnosticObservation = {
  schema: 'metis-qa-owner-diagnostic/v1'
  sequence: number
  command: string
  stage: DiagnosticStage
  role: DiagnosticRole
  handleOrdinal: number
  state: DiagnosticState
  error: DiagnosticError
  ownClose: boolean | null
  hookInvoked: boolean | null
  teardown: boolean
}

type DiagnosticSummary = {
  settlement: DiagnosticState
  settlementSamePromise: boolean | null
  readerIo: DiagnosticState
  writerIo: DiagnosticState
  readerClose: DiagnosticState
  writerClose: DiagnosticState
  profileClose: DiagnosticState
  destroyRequested: boolean
  nativeClose: DiagnosticState
  streamCloseObserved: boolean
  parentInputEnd: boolean
  parentOutputDestroy: boolean
  perHandleClose: Record<string, { role: DiagnosticRole; state: DiagnosticState; count: number }>
  hookInvocationCount: number
}

type ChildDiagnostic = {
  caseId: string
  childOrdinal: number
  sourceHead: string
  runId: string
  runAttempt: number
  target: string
  node: string
  observations: DiagnosticObservation[]
  overflow: boolean
  stderrBytes: number
  stderrOverflow: boolean
  unexpectedTerminalReports: string[]
  settlementPromiseObservation: boolean | null
  preTeardown: DiagnosticSummary
  final: DiagnosticSummary
  childExit: { state: DiagnosticState; code: number | null; signal: string | null; error: DiagnosticError }
}

const diagnosticStages = new Set<DiagnosticStage>([
  'transport-open',
  'read-start',
  'read-done',
  'write-start',
  'write-done',
  'destroy-request',
  'stream-end',
  'stream-close',
  'stream-error',
  'native-close-start',
  'native-close-done',
  'file-open',
  'file-close-start',
  'file-close-done',
  'settle-start',
  'settle-fulfilled',
  'settle-rejected',
  'gate-held',
  'gate-released',
  'prototype-hook-armed',
  'parent-input-end',
  'parent-output-destroy',
  'child-exit',
  'fixture-refusal',
  'aggregate-member',
  'aggregate-overflow'
])
const diagnosticCommands = new Set([
  'check',
  'create-root',
  'registry-negative',
  'settle',
  'hide-check',
  'navigate-aba',
  'duplicate-prepare',
  'successor',
  'stale-owner',
  'create-root-held',
  'change-userdata-resume',
  'retire-during-preparation',
  'registry-cleanup',
  'hold-profile-preparation',
  'release-profile-preparation',
  'fail-profile-close',
  'release-failed-close',
  'create-root-physical-held',
  'retire-window-resume',
  'release-profile-physical-check',
  'prepare',
  'none'
])
const diagnosticRoles = new Set<DiagnosticRole>([
  'reader3',
  'writer4',
  'profile-parent',
  'profile',
  'registry-root',
  'writer-lock',
  'probe',
  'other',
  'none'
])
const diagnosticStates = new Set<DiagnosticState>(['not-started', 'pending', 'fulfilled', 'rejected'])
const diagnosticErrors = new Set<DiagnosticError>([
  'none',
  'EPIPE',
  'EBADF',
  'ECANCELED',
  'EIO',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'known-qa-refusal',
  'known-profile-refusal',
  'injected-close',
  'aggregate',
  'other'
])
const reportTypes = new Set([
  'preparing',
  'refused',
  'active',
  'current',
  'hidden',
  'navigation-aba',
  'duplicate-prepare',
  'successor-active',
  'successor-refused',
  'stale-owner',
  'root-held',
  'gateway-held',
  'preparation-window-retired',
  'profile-preparation-stat-held',
  'profile-preparation-hold-ready',
  'profile-preparation-descriptors-settled',
  'registry-profile-physical-held',
  'registry-profile-physical-result',
  'profile-close-failure-armed',
  'root',
  'registry-negative',
  'registry-cleanup',
  'settled',
  'settlement-failed',
  'fixture-error'
])

const ownerRoster: readonly [string, string][] = [
  ['uses the actual first-show proof, inherited pipe, signed launch, profile and guarded registry', 'R01'],
  ['refuses no bound window before hello, pipe use or profile preparation', 'R02'],
  ['refuses unshown bound window before hello, pipe use or profile preparation', 'R03'],
  ['refuses hidden bound window before hello, pipe use or profile preparation', 'R04'],
  ['refuses uncommitted main frame before hello, pipe use or profile preparation', 'R05'],
  ['keeps the first-show proof across hide and permanently retires it across A-to-B-to-A navigation', 'R06'],
  ['uses the shared terminal path for EOF before launch, mid-frame and after activation', 'R07'],
  ['retires the in-flight handshake on first-show document navigate events before active publication', 'R08'],
  ['retires the in-flight handshake on first-show document replace events before active publication', 'R09'],
  ['retires the in-flight handshake on first-show document close events before active publication', 'R10'],
  [
    'retires the in-flight handshake on first-show document render-process-loss events before active publication',
    'R11'
  ],
  ['retires an active run immediately for invalid heartbeat signature', 'R12'],
  ['retires an active run immediately for replayed/decreasing sequence', 'R13'],
  ['retires an active run immediately for oversized active frame', 'R14'],
  ['accepts only a higher-generation successor after full settlement and rejects the old run at RootRegistry', 'R15'],
  ['retires from its scheduled signed-expiry deadline without an intervening status call', 'R16'],
  ['refuses a malformed compiled stamp before issuing a challenge or opening the fixed transport', 'R17'],
  ['rechecks the actual run after a held gateway bind and publishes no root after userData changes', 'R18'],
  ['keeps a timed-out handshake reserved until held profile descriptors actually close', 'R19'],
  ['keeps a partial-frame transport failure reserved until held profile preparation actually settles', 'R20'],
  ['retires on the real scheduled heartbeat-age timer without an intervening owner assertion', 'R21'],
  ['retains run capacity and the same failed settlement after an actual profile descriptor close failure', 'R22'],
  ['binds a real guarded root and refuses missing, forged and overridden QA owners before callbacks', 'G01'],
  ['preserves a replaced writer path and retains root capacity after descriptor close failure', 'G02'],
  ['checks the run after a held profile physical await before creating registry paths', 'G03'],
  ['rechecks the run after a held gateway bind before publishing a root for a retired document', 'G04']
]

type SharedHarnessState = {
  children: ChildDiagnostic[]
  nextChildOrdinal: number
  overflow: boolean
  invalid: Set<string>
  role: 'run-owner' | 'root-registry' | null
  workerId: number | null
  shardPath: string | null
  shardFd: number | null
  completed: boolean
  published: boolean
  revoked: boolean
  pendingCloses: number
  finalizationAttempted: boolean
  caseCounts: Map<string, number>
  cases: {
    caseId: string
    finished: boolean
    finishCount: number
    aborted: boolean
    signal: AbortSignal
    onAbort: () => void
  }[]
  childViews: { snapshot: () => ChildClosureSnapshot; refreshFinal: () => void }[]
  activeCallbacks: number
}
type ChildClosureSnapshot = {
  closed: boolean
  reportWaiters: number
  reportTimers: number
  frameWaiters: number
  writeCallbacks: number
}
type ObservationEpoch = {
  schema: 'metis-qa-owner-observation-epoch/v1'
  closed: boolean
  sourceHead: string
  runId: string
  runAttempt: number
  target: string
  node: string
  workerId: number | null
  role: 'run-owner' | 'root-registry' | null
  cases: { caseId: string; finished: boolean; aborted: boolean }[]
  childStarted: number
  childClosed: number
  pendingChildCloses: number
  pendingReportWaiters: number
  pendingReportTimers: number
  pendingFrameWaiters: number
  pendingWriteCallbacks: number
  activeCallbacks: number
  drained: boolean
}
const harnessStateKey = Symbol.for('metis.qa.owner.diagnostic.harness.v1')
const processState = process as unknown as Record<PropertyKey, unknown>
const harnessState = (processState[harnessStateKey] ??= {
  children: [],
  nextChildOrdinal: 0,
  overflow: false,
  invalid: new Set<string>(),
  role: null,
  workerId: null,
  shardPath: null,
  shardFd: null,
  completed: false,
  published: false,
  revoked: false,
  pendingCloses: 0,
  finalizationAttempted: false,
  caseCounts: new Map<string, number>(),
  cases: [],
  childViews: [],
  activeCallbacks: 0
}) as SharedHarnessState
const childDiagnostics = harnessState.children
const diagnosticSourceFiles = [
  '.github/workflows/qa-persistence-owners.yml',
  'vitest.qa-persistence-owners.config.ts',
  'package.json',
  'package-lock.json',
  'src/main/persistence/qa-run-protocol.ts',
  'src/main/persistence/qa-run-protocol.test.ts',
  'src/main/persistence/qa-run-protocol.qa-case.ts',
  'src/main/persistence/qa-run-owner.ts',
  'src/main/persistence/qa-run-owner.qa-case.ts',
  'src/main/persistence/qa-profile-root-owner.ts',
  'src/main/persistence/qa-profile-root-owner.qa-case.ts',
  'src/main/persistence/root-registry.ts',
  'src/main/persistence/root-registry.qa-case.ts',
  'src/main/persistence/native-key-intent.ts',
  'src/main/persistence/native-key-intent.test.ts',
  'src/main/persistence/qa-main-action-owner.ts',
  'src/main/persistence/qa-main-action-owner.test.ts',
  'src/main/persistence/bootstrap.ts',
  'src/main/index.ts',
  'src/main/auth-boundary-adapters.ts',
  'src/main/auth-config.ts',
  'src/main/auth-persistence-observation.test.ts',
  'src/main/auth-persistence-observation.ts',
  'src/main/auth-speech-boundary-readers.test.ts',
  'src/main/auth-speech-boundary-readers.ts',
  'src/main/auth-speech-boundary.ts',
  'src/main/auth-speech-lease.test.ts',
  'src/main/auth-speech-lease.ts',
  'src/main/auth.test.ts',
  'src/main/auth.ts',
  'src/main/fresh-lean-speech-defaults.ts',
  'src/main/fresh-lean-speech-defaults.test.ts',
  'src/main/settings-auth-authority-frame.ts',
  'src/main/settings-observation.test.ts',
  'src/main/speech-desktop-boundary.ts',
  'src/main/store.test.ts',
  'src/main/store.ts',
  'src/main/win-security.ts',
  'src/main/win-security.test.ts',
  'src/main/auth-authority-source-pins.ts',
  'scripts/qa/fixtures/persistence-run-owner-support.ts',
  'scripts/qa/fixtures/persistence-run-owner.child.ts',
  'scripts/qa/fixtures/persistence-run-owner.electron-host.ts',
  'scripts/qa/fixtures/persistence-owner-diagnostic-reporter.mjs',
  'tsconfig.tests.json',
  'tsconfig.node.json',
  'src/main/settings-observation.ts',
  'src/main/qa-identity.ts'
]

function withActiveCallback<T>(callback: () => T): T {
  harnessState.activeCallbacks += 1
  try {
    return callback()
  } finally {
    harnessState.activeCallbacks -= 1
  }
}

beforeEach((context) => {
  const file = context.task.file?.filepath?.replaceAll('\\', '/') ?? ''
  const role = file.endsWith('/src/main/persistence/qa-run-owner.qa-case.ts')
    ? 'run-owner'
    : file.endsWith('/src/main/persistence/root-registry.qa-case.ts')
      ? 'root-registry'
      : null
  if (role === null) return
  const matched = ownerRoster.find(
    ([title, id]) => context.task.name === title && (role === 'run-owner' ? id.startsWith('R') : id.startsWith('G'))
  )
  if (!matched) {
    markDiagnosticInvalid('missing-case')
    return
  }
  const caseId = matched[1]
  acquireDiagnosticShard(caseId)
  if (
    harnessState.cases.some((item) => item.caseId === caseId) ||
    harnessState.cases.length >= (role === 'run-owner' ? 22 : 4) ||
    !context.signal ||
    typeof context.signal.aborted !== 'boolean' ||
    typeof context.signal.addEventListener !== 'function' ||
    typeof context.onTestFinished !== 'function'
  ) {
    markDiagnosticInvalid('missing-case')
    return
  }
  const caseRecord = {
    caseId,
    finished: false,
    finishCount: 0,
    aborted: context.signal.aborted,
    signal: context.signal,
    onAbort: () => {}
  }
  harnessState.cases.push(caseRecord)
  if (caseRecord.aborted) markDiagnosticInvalid('terminal-invalid')
  caseRecord.onAbort = () =>
    withActiveCallback(() => {
      caseRecord.aborted = true
      markDiagnosticInvalid('terminal-invalid')
    })
  context.signal.addEventListener('abort', caseRecord.onAbort, { once: true })
  context.onTestFinished(() =>
    withActiveCallback(() => {
      caseRecord.finishCount += 1
      if (caseRecord.finishCount !== 1) markDiagnosticInvalid('terminal-invalid')
      caseRecord.finished = true
      if (context.signal.aborted) {
        caseRecord.aborted = true
        markDiagnosticInvalid('terminal-invalid')
      }
    })
  )
})

function observationEpoch(drained: boolean): ObservationEpoch {
  const expectedIds = ownerRoster
    .filter(([, id]) => (harnessState.role === 'run-owner' ? id.startsWith('R') : id.startsWith('G')))
    .map(([, id]) => id)
  const cases = harnessState.cases.map((record) =>
    Object.freeze({
      caseId: record.caseId,
      finished: record.finished,
      aborted: record.aborted || record.signal.aborted
    })
  )
  const childViews = harnessState.childViews.map((view) => view.snapshot())
  const caseStarts = expectedIds.map((id) => harnessState.caseCounts.get(id) ?? 0)
  const totals = {
    childClosed: childViews.filter((view) => view.closed).length,
    pendingReportWaiters: childViews.reduce((sum, view) => sum + view.reportWaiters, 0),
    pendingReportTimers: childViews.reduce((sum, view) => sum + view.reportTimers, 0),
    pendingFrameWaiters: childViews.reduce((sum, view) => sum + view.frameWaiters, 0),
    pendingWriteCallbacks: childViews.reduce((sum, view) => sum + view.writeCallbacks, 0)
  }
  const closed =
    drained &&
    harnessState.role !== null &&
    cases.length === expectedIds.length &&
    expectedIds.every((id) => cases.some((record) => record.caseId === id)) &&
    cases.every((record) => record.finished && !record.aborted) &&
    harnessState.cases.every((record) => record.finishCount === 1) &&
    expectedIds.every((id, index) => caseStarts[index] >= 1 && caseStarts[index] <= (id === 'R07' ? 4 : 1)) &&
    caseStarts.reduce((sum, count) => sum + count, 0) === harnessState.nextChildOrdinal &&
    harnessState.nextChildOrdinal === childViews.length &&
    totals.childClosed === harnessState.nextChildOrdinal &&
    harnessState.pendingCloses === 0 &&
    totals.pendingReportWaiters === 0 &&
    totals.pendingReportTimers === 0 &&
    totals.pendingFrameWaiters === 0 &&
    totals.pendingWriteCallbacks === 0 &&
    harnessState.activeCallbacks === 0 &&
    harnessState.invalid.size === 0 &&
    !harnessState.overflow
  return Object.freeze({
    schema: 'metis-qa-owner-observation-epoch/v1',
    closed,
    sourceHead: process.env.QA_OWNER_SOURCE_SHA ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? ''),
    target: process.env.QA_OWNER_TARGET ?? '',
    node: process.version,
    workerId: harnessState.workerId,
    role: harnessState.role,
    cases: Object.freeze(cases),
    childStarted: harnessState.nextChildOrdinal,
    childClosed: totals.childClosed,
    pendingChildCloses: harnessState.pendingCloses,
    pendingReportWaiters: totals.pendingReportWaiters,
    pendingReportTimers: totals.pendingReportTimers,
    pendingFrameWaiters: totals.pendingFrameWaiters,
    pendingWriteCallbacks: totals.pendingWriteCallbacks,
    activeCallbacks: harnessState.activeCallbacks,
    drained
  }) as ObservationEpoch
}

function emptyDiagnosticSummary(): DiagnosticSummary {
  return {
    settlement: 'not-started',
    settlementSamePromise: null,
    readerIo: 'not-started',
    writerIo: 'not-started',
    readerClose: 'not-started',
    writerClose: 'not-started',
    profileClose: 'not-started',
    destroyRequested: false,
    nativeClose: 'not-started',
    streamCloseObserved: false,
    parentInputEnd: false,
    parentOutputDestroy: false,
    perHandleClose: Object.create(null) as DiagnosticSummary['perHandleClose'],
    hookInvocationCount: 0
  }
}

function snapshotSummary(summary: DiagnosticSummary): DiagnosticSummary {
  return JSON.parse(JSON.stringify(summary)) as DiagnosticSummary
}

function classifyDiagnosticError(code: unknown): DiagnosticError {
  if (typeof code !== 'string') return 'none'
  if (diagnosticErrors.has(code as DiagnosticError)) return code as DiagnosticError
  if (
    [
      'window-proof-unavailable',
      'not-qa-build',
      'not-packaged',
      'wrong-runtime-name',
      'not-single-instance',
      'unsupported-target',
      'build-stamp-missing',
      'transport-unavailable',
      'transport-malformed',
      'launch-signature-invalid',
      'native-key-intent-changed',
      'launch-context-invalid',
      'run-expired',
      'run-retired',
      'run-already-owned',
      'profile-owner-invalid'
    ].includes(code)
  )
    return 'known-qa-refusal'
  if (code === 'QA_PROFILE_OWNER_UNAVAILABLE') return 'known-profile-refusal'
  return 'other'
}

const pendingFileCloses = new WeakMap<DiagnosticSummary, Map<string, number>>()
const rejectedFileCloses = new WeakMap<DiagnosticSummary, Set<string>>()

function recordSummary(summary: DiagnosticSummary, observation: DiagnosticObservation): void {
  const { stage, role, state, handleOrdinal } = observation
  if (stage === 'settle-start' || stage === 'settle-fulfilled' || stage === 'settle-rejected')
    summary.settlement = state
  if (role === 'reader3' && (stage === 'read-start' || stage === 'read-done')) summary.readerIo = state
  if (role === 'writer4' && (stage === 'write-start' || stage === 'write-done')) summary.writerIo = state
  if (stage === 'destroy-request' && (role === 'reader3' || role === 'writer4')) summary.destroyRequested = true
  if (stage === 'native-close-start' || stage === 'native-close-done') {
    if (role === 'reader3') summary.readerClose = state
    if (role === 'writer4') summary.writerClose = state
    if (summary.readerClose === 'fulfilled' && summary.writerClose === 'fulfilled') summary.nativeClose = 'fulfilled'
    else if (
      (summary.readerClose === 'rejected' || summary.writerClose === 'rejected') &&
      summary.readerClose !== 'pending' &&
      summary.writerClose !== 'pending' &&
      summary.readerClose !== 'not-started' &&
      summary.writerClose !== 'not-started'
    )
      summary.nativeClose = 'rejected'
    else summary.nativeClose = 'pending'
  }
  if (stage === 'stream-close' && (role === 'reader3' || role === 'writer4')) summary.streamCloseObserved = true
  if (stage === 'parent-input-end') summary.parentInputEnd = true
  if (stage === 'parent-output-destroy') summary.parentOutputDestroy = true
  if (stage === 'prototype-hook-armed' && observation.hookInvoked === true) summary.hookInvocationCount += 1
  if (handleOrdinal > 0) {
    const key = String(handleOrdinal)
    const current = summary.perHandleClose[key] ?? { role, state: 'not-started' as DiagnosticState, count: 0 }
    if (stage === 'file-open') {
      current.state = 'pending'
    } else if (stage === 'file-close-start') {
      current.state = 'pending'
      current.count += 1
      const pending = pendingFileCloses.get(summary) ?? new Map<string, number>()
      pending.set(key, (pending.get(key) ?? 0) + 1)
      pendingFileCloses.set(summary, pending)
    } else if (stage === 'file-close-done') {
      const pending = pendingFileCloses.get(summary)
      const remaining = Math.max(0, (pending?.get(key) ?? 0) - 1)
      pending?.set(key, remaining)
      if (state === 'rejected') {
        const rejected = rejectedFileCloses.get(summary) ?? new Set<string>()
        rejected.add(key)
        rejectedFileCloses.set(summary, rejected)
      }
      current.state = remaining > 0 ? 'pending' : rejectedFileCloses.get(summary)?.has(key) ? 'rejected' : state
    }
    summary.perHandleClose[key] = current
    const profileHandles = Object.values(summary.perHandleClose).filter(
      (handle) => handle.role === 'profile' || handle.role === 'profile-parent'
    )
    if (profileHandles.some((handle) => handle.state === 'pending')) summary.profileClose = 'pending'
    else if (profileHandles.some((handle) => handle.state === 'rejected')) summary.profileClose = 'rejected'
    else if (profileHandles.length > 0 && profileHandles.every((handle) => handle.state === 'fulfilled'))
      summary.profileClose = 'fulfilled'
  }
}

function validDiagnosticObservation(value: unknown): value is DiagnosticObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = [
    'schema',
    'sequence',
    'command',
    'stage',
    'role',
    'handleOrdinal',
    'state',
    'error',
    'ownClose',
    'hookInvoked',
    'teardown'
  ]
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key)) &&
    record.schema === 'metis-qa-owner-diagnostic/v1' &&
    Number.isInteger(record.sequence) &&
    (record.sequence as number) >= 0 &&
    (record.sequence as number) <= 63 &&
    typeof record.command === 'string' &&
    diagnosticCommands.has(record.command) &&
    diagnosticStages.has(record.stage as DiagnosticStage) &&
    diagnosticRoles.has(record.role as DiagnosticRole) &&
    Number.isInteger(record.handleOrdinal) &&
    (record.handleOrdinal as number) >= 0 &&
    (record.handleOrdinal as number) <= 8 &&
    diagnosticStates.has(record.state as DiagnosticState) &&
    diagnosticErrors.has(record.error as DiagnosticError) &&
    (record.ownClose === null || typeof record.ownClose === 'boolean') &&
    (record.hookInvoked === null || typeof record.hookInvoked === 'boolean') &&
    typeof record.teardown === 'boolean'
  )
}

function markDiagnosticInvalid(reason: string): void {
  const allowed = new Set([
    'missing-shard',
    'unexpected-shard',
    'shard-identity',
    'incomplete-shard',
    'size-limit',
    'write-failure',
    'invalid-envelope',
    'invalid-observation',
    'binding-mismatch',
    'source-hash-mismatch',
    'child-bound',
    'event-bound',
    'sequence-mismatch',
    'missing-case',
    'terminal-invalid',
    'overflow'
  ])
  if (!allowed.has(reason)) reason = 'invalid-envelope'
  if (!harnessState.invalid.has(reason)) {
    if (harnessState.invalid.size < 16) harnessState.invalid.add(reason)
    else {
      harnessState.invalid.clear()
      harnessState.invalid.add('overflow')
    }
  }
  revokePublishedShard()
}

function workerIdFromEnvironment(): number | null {
  const value = process.env.VITEST_WORKER_ID ?? ''
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value)) return null
  const id = Number(value)
  return id <= 65535 ? id : null
}

function shardBytes(complete: boolean, epoch: ObservationEpoch | null): Buffer {
  const sourceHashes = Object.fromEntries(
    diagnosticSourceFiles.map((file) => {
      try {
        return [
          file,
          createHash('sha256')
            .update(readFileSync(resolve(process.cwd(), file)))
            .digest('hex')
        ]
      } catch {
        markDiagnosticInvalid('source-hash-mismatch')
        return [file, null]
      }
    })
  )
  const roleMax = harnessState.role === 'root-registry' ? 4 : 28
  return Buffer.from(
    `${JSON.stringify({
      schema: 'metis-qa-owner-diagnostic-shard/v1',
      sourceHead: process.env.QA_OWNER_SOURCE_SHA ?? '',
      runId: process.env.GITHUB_RUN_ID ?? '',
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? ''),
      target: process.env.QA_OWNER_TARGET ?? '',
      node: process.version,
      sourceHashes,
      workerId: harnessState.workerId,
      role: harnessState.role,
      complete,
      observationEpoch: epoch,
      invalid: [...harnessState.invalid].sort(),
      overflow:
        harnessState.overflow || childDiagnostics.length > roleMax || childDiagnostics.some((child) => child.overflow),
      children: childDiagnostics
    })}\n`,
    'utf8'
  )
}

function revokePublishedShard(): void {
  if (!harnessState.published || harnessState.revoked || harnessState.shardPath === null) return
  const accepted = harnessState.shardPath.replace(/\.pending$/, '.json')
  const marker = harnessState.shardPath.replace(/\.pending$/, '.invalid')
  try {
    const markerFd = openSync(marker, 'wx', 0o600)
    try {
      const bytes = Buffer.from('terminal-invalid\n')
      if (writeSync(markerFd, bytes) !== bytes.byteLength) throw new Error('short invalidation marker write')
      fsyncSync(markerFd)
    } finally {
      closeSync(markerFd)
    }
    harnessState.revoked = true
  } catch {
    try {
      renameSync(accepted, marker)
      harnessState.revoked = true
    } catch {
      try {
        unlinkSync(accepted)
        harnessState.revoked = true
      } catch {
        // The directory can refuse entry changes while the accepted file remains writable.
        let acceptedFd: number | null = null
        try {
          acceptedFd = openSync(accepted, 'r+')
          ftruncateSync(acceptedFd, 0)
          fsyncSync(acceptedFd)
          closeSync(acceptedFd)
          acceptedFd = null
          harnessState.revoked = true
        } catch {
          // If all durable revocations fail, the framework must receive this error.
          throw new Error('QA_DIAGNOSTIC_LATE_SHARD_REVOCATION_FAILED')
        } finally {
          if (acceptedFd !== null) closeSync(acceptedFd)
        }
      }
    }
  }
}

function markLateDiagnosticMutation(): void {
  markDiagnosticInvalid('terminal-invalid')
}

function flushDiagnosticShard(complete = false, epoch: ObservationEpoch | null = null, finalize = complete): void {
  if (harnessState.shardFd === null || harnessState.completed || harnessState.finalizationAttempted) return
  if (finalize) harnessState.finalizationAttempted = true
  try {
    const bytes = shardBytes(complete, epoch)
    if (bytes.byteLength > 256 * 1024) {
      markDiagnosticInvalid('size-limit')
      harnessState.overflow = true
      return
    }
    ftruncateSync(harnessState.shardFd, 0)
    const written = writeSync(harnessState.shardFd, bytes, 0, bytes.byteLength, 0)
    if (written !== bytes.byteLength) throw new Error('short diagnostic shard write')
    fsyncSync(harnessState.shardFd)
    if (finalize) {
      closeSync(harnessState.shardFd)
      harnessState.shardFd = null
      harnessState.completed = true
    }
  } catch {
    markDiagnosticInvalid('write-failure')
    harnessState.overflow = true
  }
}

function acquireDiagnosticShard(caseId: string): void {
  const id = workerIdFromEnvironment()
  const directory = process.env.QA_OWNER_DIAGNOSTIC_DIR
  const role = caseId.startsWith('G') ? 'root-registry' : 'run-owner'
  if (harnessState.completed) {
    markLateDiagnosticMutation()
    return
  }
  if (id === null || !directory) {
    markDiagnosticInvalid('shard-identity')
    return
  }
  if (harnessState.role !== null && (harnessState.role !== role || harnessState.workerId !== id)) {
    markDiagnosticInvalid('shard-identity')
    return
  }
  if (harnessState.shardFd !== null) return
  harnessState.role = role
  harnessState.workerId = id
  const filename = `owner-${role}-worker-${id}.pending`
  try {
    harnessState.shardFd = openSync(join(directory, filename), 'wx', 0o600)
    harnessState.shardPath = join(directory, filename)
    flushDiagnosticShard(false)
  } catch {
    markDiagnosticInvalid('shard-identity')
  }
}

afterAll(async () => {
  await new Promise<void>((resolveDrain) => process.nextTick(resolveDrain))
  for (const view of harnessState.childViews) view.refreshFinal()
  const epoch = observationEpoch(true)
  if (!epoch.closed) markDiagnosticInvalid('incomplete-shard')
  else for (const record of harnessState.cases) record.signal.removeEventListener('abort', record.onAbort)
  if (harnessState.shardFd !== null) {
    flushDiagnosticShard(epoch.closed, epoch, true)
  }
  if (
    epoch.closed &&
    harnessState.completed &&
    harnessState.shardPath !== null &&
    harnessState.invalid.size === 0 &&
    harnessState.pendingCloses === 0
  ) {
    try {
      renameSync(harnessState.shardPath, harnessState.shardPath.replace(/\.pending$/, '.json'))
      harnessState.published = true
    } catch {
      markDiagnosticInvalid('write-failure')
    }
  }
})
process.on('exit', () => {
  if (harnessState.shardFd !== null && !harnessState.finalizationAttempted) flushDiagnosticShard(false)
})

export type PhysicalDirectoryIdentity = {
  path: string
  device: string
  inode: string
  birthtimeMs: number
  owner: string
  mode: number
}

export type QaFixtureProfile = {
  readonly directory: string
  readonly parent: PhysicalDirectoryIdentity
  readonly profile: PhysicalDirectoryIdentity
  readonly ownerSid: string | null
  cleanup(): Promise<void>
}

function principalAssociation(sid: string): string {
  return createHash('sha256').update('metis-qa-os-principal/v1\n', 'utf8').update(sid, 'utf8').digest('hex')
}

async function physicalIdentity(path: string, ownerSid: string | null): Promise<PhysicalDirectoryIdentity> {
  const canonicalPath = await realpath(path)
  const stat = await lstat(canonicalPath, { bigint: true })
  return {
    path: canonicalPath,
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtimeMs: Math.round(Number(stat.birthtimeMs)),
    owner: process.platform === 'win32' ? (ownerSid ?? '') : String(process.getuid?.() ?? ''),
    mode: Number(stat.mode) & 0o7777
  }
}

export async function createQaFixtureProfile(): Promise<QaFixtureProfile> {
  const directory = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-'))
  const parentPath = await realpath(directory)
  const profilePath = join(parentPath, 'profile')
  await mkdir(profilePath, { mode: 0o700 })
  if (process.platform === 'darwin') {
    await chmod(parentPath, 0o700)
    await chmod(profilePath, 0o700)
  }
  let ownerSid: string | null = null
  if (process.platform === 'win32') {
    const receipt = await readPrivateCurrentUserAclReceipt(parentPath)
    if (!receipt) throw new Error('Windows QA fixture parent has no fresh private current-user ACL receipt')
    ownerSid = receipt.ownerSid
    const profileReceipt = await readPrivateCurrentUserAclReceipt(profilePath)
    if (!profileReceipt || profileReceipt.ownerSid !== ownerSid)
      throw new Error('Windows QA fixture profile has no matching fresh current-user ACL receipt')
  }
  const parent = await physicalIdentity(parentPath, ownerSid)
  const profile = await physicalIdentity(profilePath, ownerSid)
  return {
    directory,
    parent,
    profile,
    ownerSid,
    cleanup: () => rm(directory, { recursive: true, force: true })
  }
}

export function signQaFixtureLaunch(
  challenge: string,
  physical: Pick<QaFixtureProfile, 'parent' | 'profile' | 'ownerSid'>,
  overrides: Partial<QaPersistenceLaunchPayload> = {}
): Buffer {
  const stamp = compiledQaPersistenceRunContext()
  if (!stamp) throw new Error('QA fixture stamp is missing')
  const now = Date.now()
  const principal =
    process.platform === 'win32'
      ? {
          platform: 'win32' as const,
          sidAssociationSha256: principalAssociation(physical.ownerSid ?? '')
        }
      : {
          platform: 'darwin' as const,
          uid: process.getuid?.() ?? 0,
          effectiveUid: process.geteuid?.() ?? process.getuid?.() ?? 0
        }
  const payload: QaPersistenceLaunchPayload = {
    purpose: 'isolated-persistence-qualification',
    bootChallenge: challenge,
    sourceCommit: stamp.context.commit,
    buildContext: stamp.context,
    runId: stamp.context.runId,
    runGeneration: 1,
    candidateSha256: stamp.candidateSha256,
    implementationSha256: stamp.implementationSha256,
    profileMeasurementSha256: stamp.profileMeasurementSha256,
    caseRosterSha256: stamp.caseRosterSha256,
    runtime: stamp.runtime,
    qaIdentity: stamp.qaIdentity,
    allowedCases: ['before-show-refusal', 'status-no-side-effects'],
    notBefore: now - 1000,
    expiresAt: now + 60_000,
    profile: physical.profile,
    parent: physical.parent,
    osPrincipalAssociation: principal,
    nativeKeyIntent: PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT,
    ...overrides
  }
  const payloadBytes = Buffer.from(qaPersistenceCanonical(payload), 'utf8')
  const signature = sign(null, Buffer.concat([launchDomain, payloadBytes]), fixturePrivateKey)
  return Buffer.from(
    qaPersistenceCanonical({
      schema: QA_LAUNCH_ENVELOPE_SCHEMA,
      payload: payloadBytes.toString('base64url'),
      signature: signature.toString('base64url')
    }),
    'utf8'
  )
}

export function signQaFixtureHeartbeat(sequence = 1, issuedAt = Date.now()): Buffer {
  const stamp = compiledQaPersistenceRunContext()
  if (!stamp) throw new Error('QA fixture stamp is missing')
  const unsigned = {
    schema: QA_HEARTBEAT_SCHEMA,
    runId: stamp.context.runId,
    runGeneration: 1,
    sequence,
    issuedAt
  }
  const signature = sign(
    null,
    Buffer.concat([heartbeatDomain, Buffer.from(qaPersistenceCanonical(unsigned), 'utf8')]),
    fixturePrivateKey
  )
  return Buffer.from(qaPersistenceCanonical({ ...unsigned, signature: signature.toString('base64url') }), 'utf8')
}

export function newQaFixtureChallenge(): string {
  return newQaPersistenceBootChallenge()
}

export async function buildQaRunOwnerChild(
  outputDirectory: string,
  compiledStamp = fixtureBuildStamp
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true })
  const outfile = join(outputDirectory, 'persistence-run-owner-child.cjs')
  await build({
    entryPoints: [sourceChild],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define: {
      __METIS_QA_IDENTITY__: 'true',
      __METIS_QA_PERSISTENCE_BUILD_STAMP__: JSON.stringify(compiledStamp)
    },
    alias: {
      '@shared': resolve(__dirname, '../../../src/shared'),
      electron: sourceElectronHost
    },
    external: ['electron-log']
  })
  return outfile
}

export type QaRunOwnerChild = {
  readonly process: ChildProcess
  readonly receivedFrameCount: number
  reportCount(type: string): number
  sendFrame(bytes: Uint8Array): Promise<void>
  sendPartialFrameAndEnd(bytes: Uint8Array, sentBytes: number): Promise<void>
  endInput(): void
  closeOutput(): void
  sendInvalidFrameLength(length: number): Promise<void>
  readFrame(): Promise<Buffer>
  sendCommand(
    command:
      | 'check'
      | 'create-root'
      | 'registry-negative'
      | 'settle'
      | 'hide-check'
      | 'navigate-aba'
      | 'duplicate-prepare'
      | 'successor'
      | 'stale-owner'
      | 'create-root-held'
      | 'change-userdata-resume'
      | 'registry-cleanup'
      | 'hold-profile-preparation'
      | 'release-profile-preparation'
      | 'fail-profile-close'
      | 'release-failed-close'
      | 'create-root-physical-held'
      | 'retire-window-resume'
      | 'release-profile-physical-check'
  ): void
  retireWindowDuringPreparation(event: 'navigate' | 'replace' | 'close' | 'render-process-loss'): void
  waitForReport(type: string, timeoutMs?: number): Promise<Record<string, unknown>>
  terminate(): Promise<void>
}

export function startQaRunOwnerChild(entry: string, userDataPath: string, mode = 'shown'): QaRunOwnerChild {
  const testName = expect.getState().currentTestName ?? ''
  const caseId = ownerRoster.find(([title]) => testName.endsWith(title))?.[1] ?? 'unmapped'
  if (
    !harnessState.cases.some(
      (record) => record.caseId === caseId && !record.finished && !record.aborted && !record.signal.aborted
    )
  )
    markDiagnosticInvalid('missing-case')
  if (caseId !== 'unmapped') acquireDiagnosticShard(caseId)
  if (harnessState.completed) markLateDiagnosticMutation()
  const priorCaseStarts = harnessState.caseCounts.get(caseId) ?? 0
  harnessState.caseCounts.set(caseId, priorCaseStarts + 1)
  if (priorCaseStarts >= (caseId === 'R07' ? 4 : 1)) markDiagnosticInvalid('child-bound')
  const childOrdinal = ++harnessState.nextChildOrdinal
  const roleLimit = caseId.startsWith('G') ? 4 : 28
  if (caseId === 'unmapped' || childOrdinal > roleLimit) {
    harnessState.overflow = true
    markDiagnosticInvalid('child-bound')
  }
  const child = spawn(process.execPath, [entry, userDataPath, mode], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }
  })
  harnessState.pendingCloses += 1
  const reportQueue: Record<string, unknown>[] = []
  const reportWaiters: {
    type: string
    resolve: (report: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }[] = []
  const reportCounts = new Map<string, number>()
  const summary = emptyDiagnosticSummary()
  const diagnostic: ChildDiagnostic = {
    caseId,
    childOrdinal: childDiagnostics.length + 1,
    sourceHead: process.env.QA_OWNER_SOURCE_SHA ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? ''),
    target: process.env.QA_OWNER_TARGET ?? '',
    node: process.version,
    observations: [],
    overflow: caseId === 'unmapped' || childOrdinal > roleLimit,
    stderrBytes: 0,
    stderrOverflow: false,
    unexpectedTerminalReports: [],
    settlementPromiseObservation: null,
    preTeardown: emptyDiagnosticSummary(),
    final: summary,
    childExit: { state: 'pending', code: null, signal: null, error: 'none' }
  }
  if (childDiagnostics.length < roleLimit && caseId !== 'unmapped') childDiagnostics.push(diagnostic)
  else {
    harnessState.overflow = true
    markDiagnosticInvalid('child-bound')
  }
  flushDiagnosticShard(false)
  let currentCommand = 'prepare'
  let terminating = false
  let hasClosed = false
  let terminal: Error | null = null
  let preTeardownCaptured = false
  let childExitCaptured = false
  let childSequenceExpected = 0
  let pendingReportTimers = 0
  let pendingWriteCallbacks = 0
  const writeObserved = (
    input: NodeJS.WritableStream,
    bytes: Buffer,
    callback: (error?: Error | null) => void
  ): void => {
    let pending = true
    const settle = (): void => {
      if (pending) {
        pending = false
        pendingWriteCallbacks -= 1
      }
    }
    pendingWriteCallbacks += 1
    try {
      input.write(bytes, (error) =>
        withActiveCallback(() => {
          settle()
          callback(error)
        })
      )
    } catch (error) {
      settle()
      throw error
    }
  }
  const appendObservation = (input: Omit<DiagnosticObservation, 'sequence'>): void => {
    if (harnessState.completed) {
      markLateDiagnosticMutation()
      return
    }
    if (diagnostic.observations.length >= 64) {
      diagnostic.overflow = true
      harnessState.overflow = true
      markDiagnosticInvalid('event-bound')
      return
    }
    const observation = {
      ...input,
      teardown: input.teardown || terminating || terminal !== null,
      sequence: diagnostic.observations.length
    }
    if (!validDiagnosticObservation(observation)) {
      diagnostic.overflow = true
      harnessState.overflow = true
      markDiagnosticInvalid('invalid-observation')
      return
    }
    diagnostic.observations.push(observation)
    recordSummary(summary, observation)
  }
  const wakeWaiters = (error: Error): void => {
    for (const waiter of reportWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      pendingReportTimers -= 1
      waiter.reject(error)
    }
  }
  child.stderr?.on('data', (chunk: Buffer | string) =>
    withActiveCallback(() => {
      if (harnessState.published) markLateDiagnosticMutation()
      const length = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
      const total = diagnostic.stderrBytes + length
      diagnostic.stderrBytes = Math.min(65_536, total)
      if (total > 65_536) {
        diagnostic.stderrOverflow = true
        markDiagnosticInvalid('overflow')
      }
    })
  )
  child.on('message', (value) =>
    withActiveCallback(() => {
      if (harnessState.published) markLateDiagnosticMutation()
      if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return
      const report = value as Record<string, unknown>
      if (report.type === 'owner-diagnostic-overflow') {
        diagnostic.overflow = true
        markDiagnosticInvalid('overflow')
        return
      }
      if (report.type === 'owner-diagnostic') {
        const envelope = report as { observation?: unknown; overflow?: unknown; samePromise?: unknown }
        const keys = ['type', 'observation', 'overflow', 'samePromise']
        const observation = envelope.observation
        if (
          Object.keys(report).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(report, key)) ||
          !validDiagnosticObservation(observation) ||
          typeof envelope.overflow !== 'boolean' ||
          !(envelope.samePromise === null || typeof envelope.samePromise === 'boolean') ||
          ((observation as DiagnosticObservation).stage === 'settle-start' &&
            typeof envelope.samePromise !== 'boolean') ||
          ((observation as DiagnosticObservation).stage !== 'settle-start' && envelope.samePromise !== null)
        ) {
          diagnostic.overflow = true
          harnessState.overflow = true
          markDiagnosticInvalid('invalid-observation')
          return
        }
        if ((observation as DiagnosticObservation).sequence !== childSequenceExpected) {
          diagnostic.overflow = true
          harnessState.overflow = true
          markDiagnosticInvalid('sequence-mismatch')
          return
        }
        childSequenceExpected += 1
        if (envelope.overflow === true) {
          diagnostic.overflow = true
          markDiagnosticInvalid('overflow')
        }
        const { sequence: _childSequence, ...fields } = observation as DiagnosticObservation
        fields.teardown = terminating || terminal !== null || fields.teardown
        appendObservation(fields)
        if ((observation as DiagnosticObservation).stage === 'settle-start') {
          if (diagnostic.settlementPromiseObservation !== null) markDiagnosticInvalid('invalid-observation')
          diagnostic.settlementPromiseObservation = envelope.samePromise as boolean
          summary.settlementSamePromise = envelope.samePromise as boolean
        }
        flushDiagnosticShard(false)
        return
      }
      reportCounts.set(report.type as string, (reportCounts.get(report.type as string) ?? 0) + 1)
      const isTerminalReport =
        report.type === 'refused' ||
        report.type === 'settlement-failed' ||
        report.type === 'successor-refused' ||
        report.type === 'fixture-error'
      if (isTerminalReport) {
        if (
          !reportWaiters.some((waiter) => waiter.type === report.type) &&
          diagnostic.unexpectedTerminalReports.length < 8
        )
          diagnostic.unexpectedTerminalReports.push(
            typeof report.type === 'string' && reportTypes.has(report.type) ? report.type : 'other'
          )
        else if (!reportWaiters.some((waiter) => waiter.type === report.type)) {
          diagnostic.overflow = true
          harnessState.overflow = true
          markDiagnosticInvalid('terminal-invalid')
        }
        const code =
          typeof report.code === 'string'
            ? report.code
            : typeof report.refusal === 'string'
              ? report.refusal
              : undefined
        appendObservation({
          schema: 'metis-qa-owner-diagnostic/v1',
          command: currentCommand,
          stage: 'fixture-refusal',
          role: 'none',
          handleOrdinal: 0,
          state: 'rejected',
          error: classifyDiagnosticError(code),
          ownClose: null,
          hookInvoked: null,
          teardown: terminating
        })
      }
      const index = reportWaiters.findIndex((waiter) => waiter.type === report.type)
      if (index >= 0) {
        const waiter = reportWaiters.splice(index, 1)[0]
        clearTimeout(waiter.timer)
        pendingReportTimers -= 1
        waiter.resolve(report)
      } else reportQueue.push(report)
    })
  )
  child.once('error', () =>
    withActiveCallback(() => {
      if (harnessState.published) markLateDiagnosticMutation()
      terminal = new Error('QA_DIAGNOSTIC_CHILD_EXIT')
      childExitCaptured = true
      diagnostic.childExit = { state: 'rejected', code: null, signal: null, error: 'other' }
      if (!preTeardownCaptured) {
        diagnostic.preTeardown = snapshotSummary(summary)
        preTeardownCaptured = true
      }
      appendObservation({
        schema: 'metis-qa-owner-diagnostic/v1',
        command: currentCommand,
        stage: 'child-exit',
        role: 'none',
        handleOrdinal: 0,
        state: 'rejected',
        error: 'other',
        ownClose: null,
        hookInvoked: null,
        teardown: terminating
      })
      flushDiagnosticShard(false)
      wakeWaiters(new Error('QA_DIAGNOSTIC_CHILD_EXIT'))
    })
  )
  child.once('exit', (code, signal) =>
    withActiveCallback(() => {
      if (harnessState.published) markLateDiagnosticMutation()
      if (!preTeardownCaptured) {
        diagnostic.preTeardown = snapshotSummary(summary)
        preTeardownCaptured = true
      }
      terminal = new Error('QA_DIAGNOSTIC_CHILD_EXIT')
      const priorError = childExitCaptured && diagnostic.childExit.error !== 'none'
      childExitCaptured = true
      diagnostic.childExit = {
        state: priorError || code !== 0 || signal !== null ? 'rejected' : 'fulfilled',
        code: Number.isInteger(code) ? code : null,
        signal:
          signal && ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT'].includes(signal)
            ? signal
            : signal
              ? 'other'
              : null,
        error: priorError || code !== 0 || signal !== null ? 'other' : 'none'
      }
      appendObservation({
        schema: 'metis-qa-owner-diagnostic/v1',
        command: currentCommand,
        stage: 'child-exit',
        role: 'none',
        handleOrdinal: 0,
        state: diagnostic.childExit.state,
        error: diagnostic.childExit.error,
        ownClose: null,
        hookInvoked: null,
        teardown: terminating
      })
      wakeWaiters(new Error('QA_DIAGNOSTIC_CHILD_EXIT'))
    })
  )
  child.once('close', () =>
    withActiveCallback(() => {
      if (harnessState.published) markLateDiagnosticMutation()
      hasClosed = true
      harnessState.pendingCloses -= 1
      diagnostic.final = snapshotSummary(summary)
      flushDiagnosticShard(false)
      for (const waiter of frameWaiters.splice(0)) waiter.reject(new Error('QA_DIAGNOSTIC_CHILD_EXIT'))
    })
  )

  let frameBuffer = Buffer.alloc(0)
  const frameQueue: Buffer[] = []
  const frameWaiters: { resolve: (value: Buffer) => void; reject: (error: Error) => void }[] = []
  child.once('error', () =>
    withActiveCallback(() => {
      for (const waiter of frameWaiters.splice(0)) waiter.reject(new Error('QA_DIAGNOSTIC_CHILD_EXIT'))
    })
  )
  child.once('exit', () =>
    withActiveCallback(() => {
      for (const waiter of frameWaiters.splice(0)) waiter.reject(new Error('QA_DIAGNOSTIC_CHILD_EXIT'))
    })
  )
  let receivedFrameCount = 0
  child.stdio[4]?.on('data', (chunk: Buffer) =>
    withActiveCallback(() => {
      if (harnessState.published) markLateDiagnosticMutation()
      frameBuffer = Buffer.concat([frameBuffer, chunk])
      if (frameBuffer.byteLength > 65_540) {
        child.kill()
        return
      }
      while (frameBuffer.byteLength >= 4) {
        const size = frameBuffer.readUInt32BE(0)
        if (size === 0 || size > 65_536) {
          child.kill()
          return
        }
        if (frameBuffer.byteLength < size + 4) return
        const message = frameBuffer.subarray(4, size + 4)
        frameBuffer = frameBuffer.subarray(size + 4)
        receivedFrameCount += 1
        const waiter = frameWaiters.shift()
        if (waiter) waiter.resolve(message)
        else frameQueue.push(message)
      }
    })
  )

  if (harnessState.childViews.length < 32)
    harnessState.childViews.push({
      snapshot: () => ({
        closed: hasClosed,
        reportWaiters: reportWaiters.length,
        reportTimers: pendingReportTimers,
        frameWaiters: frameWaiters.length,
        writeCallbacks: pendingWriteCallbacks
      }),
      refreshFinal: () => {
        diagnostic.final = snapshotSummary(summary)
      }
    })
  else markDiagnosticInvalid('child-bound')

  return {
    process: child,
    get receivedFrameCount() {
      return receivedFrameCount
    },
    reportCount(type) {
      return reportCounts.get(type) ?? 0
    },
    sendFrame(bytes) {
      if (harnessState.published) markLateDiagnosticMutation()
      if (bytes.byteLength === 0 || bytes.byteLength > 65_536)
        return Promise.reject(new Error('Fixture frame is outside bounds'))
      const frame = Buffer.allocUnsafe(bytes.byteLength + 4)
      frame.writeUInt32BE(bytes.byteLength, 0)
      Buffer.from(bytes).copy(frame, 4)
      return new Promise<void>((resolve, rejectWrite) => {
        const input = child.stdio[3] as NodeJS.WritableStream | null
        if (!input) {
          rejectWrite(new Error('QA fixture child input pipe is unavailable'))
          return
        }
        writeObserved(input, frame, (error) => (error ? rejectWrite(error) : resolve()))
      })
    },
    sendPartialFrameAndEnd(bytes, sentBytes) {
      if (harnessState.published) markLateDiagnosticMutation()
      if (bytes.byteLength === 0 || bytes.byteLength > 65_536 || sentBytes < 1 || sentBytes >= bytes.byteLength + 4)
        return Promise.reject(new Error('Fixture partial frame is outside bounds'))
      const frame = Buffer.allocUnsafe(bytes.byteLength + 4)
      frame.writeUInt32BE(bytes.byteLength, 0)
      Buffer.from(bytes).copy(frame, 4)
      return new Promise<void>((resolvePartial, rejectPartial) => {
        const input = child.stdio[3] as NodeJS.WritableStream | null
        if (!input) {
          rejectPartial(new Error('QA fixture child input pipe is unavailable'))
          return
        }
        writeObserved(input, frame.subarray(0, sentBytes), (error) => {
          if (error) rejectPartial(error)
          else {
            appendObservation({
              schema: 'metis-qa-owner-diagnostic/v1',
              command: currentCommand,
              stage: 'parent-input-end',
              role: 'reader3',
              handleOrdinal: 0,
              state: 'fulfilled',
              error: 'none',
              ownClose: null,
              hookInvoked: null,
              teardown: terminating
            })
            summary.parentInputEnd = true
            input.end()
            resolvePartial()
          }
        })
      })
    },
    endInput() {
      const input = child.stdio[3] as NodeJS.WritableStream | null
      appendObservation({
        schema: 'metis-qa-owner-diagnostic/v1',
        command: currentCommand,
        stage: 'parent-input-end',
        role: 'reader3',
        handleOrdinal: 0,
        state: 'fulfilled',
        error: 'none',
        ownClose: null,
        hookInvoked: null,
        teardown: terminating
      })
      input?.end()
    },
    closeOutput() {
      appendObservation({
        schema: 'metis-qa-owner-diagnostic/v1',
        command: currentCommand,
        stage: 'parent-output-destroy',
        role: 'writer4',
        handleOrdinal: 0,
        state: 'fulfilled',
        error: 'none',
        ownClose: null,
        hookInvoked: null,
        teardown: terminating
      })
      child.stdio[4]?.destroy()
    },
    sendInvalidFrameLength(length) {
      if (harnessState.published) markLateDiagnosticMutation()
      const frame = Buffer.alloc(4)
      frame.writeUInt32BE(length, 0)
      return new Promise<void>((resolveInvalid, rejectInvalid) => {
        const input = child.stdio[3] as NodeJS.WritableStream | null
        if (!input) {
          rejectInvalid(new Error('QA fixture child input pipe is unavailable'))
          return
        }
        writeObserved(input, frame, (error) => (error ? rejectInvalid(error) : resolveInvalid()))
      })
    },
    readFrame() {
      if (harnessState.published) markLateDiagnosticMutation()
      const queued = frameQueue.shift()
      if (queued) return Promise.resolve(queued)
      if (terminal || child.exitCode !== null || child.signalCode !== null)
        return Promise.reject(terminal ?? new Error('QA_DIAGNOSTIC_CHILD_EXIT'))
      return new Promise<Buffer>((resolveFrame, rejectFrame) =>
        frameWaiters.push({ resolve: resolveFrame, reject: rejectFrame })
      )
    },
    sendCommand(command) {
      if (harnessState.published) markLateDiagnosticMutation()
      currentCommand = command
      child.send({ command })
    },
    retireWindowDuringPreparation(event) {
      if (harnessState.published) markLateDiagnosticMutation()
      currentCommand = 'retire-during-preparation'
      child.send({ command: 'retire-during-preparation', event })
    },
    waitForReport(type, timeoutMs = 15_000) {
      if (harnessState.published) markLateDiagnosticMutation()
      const queuedIndex = reportQueue.findIndex((report) => report.type === type)
      if (queuedIndex >= 0) {
        const queued = reportQueue.splice(queuedIndex, 1)[0]
        const unexpectedIndex = diagnostic.unexpectedTerminalReports.indexOf(type)
        if (unexpectedIndex >= 0) diagnostic.unexpectedTerminalReports.splice(unexpectedIndex, 1)
        return Promise.resolve(queued)
      }
      if (terminal || child.exitCode !== null || child.signalCode !== null)
        return Promise.reject(terminal ?? new Error('QA_DIAGNOSTIC_CHILD_EXIT'))
      return new Promise((resolveReport, rejectReport) => {
        let waiter: (typeof reportWaiters)[number]
        const timer = setTimeout(
          () =>
            withActiveCallback(() => {
              pendingReportTimers -= 1
              const index = reportWaiters.indexOf(waiter)
              if (index >= 0) reportWaiters.splice(index, 1)
              const lastState = diagnostic.observations.at(-1)?.state ?? 'rejected'
              appendObservation({
                schema: 'metis-qa-owner-diagnostic/v1',
                command: currentCommand,
                stage: 'fixture-refusal',
                role: 'none',
                handleOrdinal: 0,
                state: lastState,
                error: 'other',
                ownClose: null,
                hookInvoked: null,
                teardown: terminating
              })
              rejectReport(new Error('QA_DIAGNOSTIC_REPORT_TIMEOUT'))
            }),
          timeoutMs
        )
        pendingReportTimers += 1
        waiter = { type, resolve: resolveReport, reject: rejectReport, timer }
        reportWaiters.push(waiter)
      })
    },
    terminate() {
      if (harnessState.published) markLateDiagnosticMutation()
      if (!terminating) {
        terminating = true
        if (!preTeardownCaptured) {
          diagnostic.preTeardown = snapshotSummary(summary)
          preTeardownCaptured = true
        }
        flushDiagnosticShard(false)
      }
      if (hasClosed) return Promise.resolve()
      return new Promise<void>((resolveExit) => {
        child.once('close', () => resolveExit())
        if (child.exitCode === null && child.signalCode === null) child.kill()
      })
    }
  }
}

export function parentPathForProfile(profile: PhysicalDirectoryIdentity): string {
  return dirname(profile.path)
}
