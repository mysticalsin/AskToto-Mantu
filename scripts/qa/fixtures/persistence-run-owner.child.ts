import { join } from 'node:path'
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createStorageGateway } from '../../../src/main/infra/storage/gateway'
import { bindQaPersistenceMainWindow } from '../../../src/main/persistence/qa-main-action-owner'
import {
  captureCurrentQaPersistenceRun,
  prepareQaPersistenceRun,
  settleQaPersistenceRun,
  type QaPersistenceRunPermit
} from '../../../src/main/persistence/qa-run-owner'
import { RootRegistry, type RootScopeBinding } from '../../../src/main/persistence/root-registry'
import { applyLegacyPersistenceNativeKeyDefault } from '../../../src/main/persistence/native-key-intent'
import { QaFixtureBrowserWindow, setQaFixtureUserDataPath } from './persistence-run-owner.electron-host'

type ChildCommand = {
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
    | 'retire-during-preparation'
    | 'registry-cleanup'
    | 'hold-profile-preparation'
    | 'release-profile-preparation'
    | 'fail-profile-close'
    | 'release-failed-close'
    | 'create-root-physical-held'
    | 'retire-window-resume'
    | 'release-profile-physical-check'
  event?: 'navigate' | 'replace' | 'close' | 'render-process-loss'
}

type DiagnosticCommand = ChildCommand['command'] | 'prepare' | 'none'
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

const qaRefusals = new Set([
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
])
const profileRefusals = new Set([
  'QA_PROFILE_CHANGED_DURING_OPEN',
  'QA_PROFILE_CHANGED_DURING_PROBE',
  'QA_PROFILE_LAUNCH_UNVERIFIED',
  'QA_PROFILE_MAC_OWNER_CHANGED',
  'QA_PROFILE_MAC_OWNER_INVALID',
  'QA_PROFILE_NATIVE_INTENT_MISMATCH',
  'QA_PROFILE_NOT_EXACT_PARENT_CHILD',
  'QA_PROFILE_OWNER_UNAVAILABLE',
  'QA_PROFILE_PARENT_CHANGED',
  'QA_PROFILE_PATH_NOT_CANONICAL',
  'QA_PROFILE_PATH_REDIRECTED',
  'QA_PROFILE_PHYSICAL_IDENTITY_CHANGED',
  'QA_PROFILE_PLATFORM_MISMATCH',
  'QA_PROFILE_PREPARATION_UNAVAILABLE',
  'QA_PROFILE_PRINCIPAL_MISMATCH',
  'QA_PROFILE_RUNTIME_MISMATCH',
  'QA_PROFILE_RUN_CONTEXT_CHANGED',
  'QA_PROFILE_USERDATA_MISMATCH',
  'QA_PROFILE_WINDOWS_DACL_CHANGED',
  'QA_PROFILE_WINDOWS_DACL_INVALID'
])

function diagnosticError(error: unknown): DiagnosticError {
  if (error === undefined || error === null) return 'none'
  let code: unknown
  let message: unknown
  try {
    if (error instanceof AggregateError) return 'aggregate'
    if (typeof error === 'object' && error !== null) {
      code = (error as { code?: unknown }).code
      message = (error as { message?: unknown }).message
    }
  } catch {
    diagnosticInvalid = true
    return 'other'
  }
  if (
    typeof code === 'string' &&
    ['EPIPE', 'EBADF', 'ECANCELED', 'EIO', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code)
  )
    return code as DiagnosticError
  if (typeof code === 'string' && qaRefusals.has(code)) return 'known-qa-refusal'
  if (typeof message === 'string' && qaRefusals.has(message)) return 'known-qa-refusal'
  if (typeof code === 'string' && profileRefusals.has(code)) return 'known-profile-refusal'
  if (typeof message === 'string' && profileRefusals.has(message)) return 'known-profile-refusal'
  if (
    message === 'injected run profile descriptor close failure' ||
    message === 'injected root descriptor close failure'
  )
    return 'injected-close'
  return 'other'
}

let diagnosticSequence = 0
let diagnosticOverflow = false
let diagnosticCommand: DiagnosticCommand = 'prepare'
let diagnosticUserDataPath = ''
let diagnosticHandleOrdinal = 0
let diagnosticInvalid = false
let diagnosticSamePromise: boolean | null = null
const observedHandles = new WeakMap<object, { role: DiagnosticRole; ordinal: number }>()

function diagnosticRole(path: unknown): DiagnosticRole {
  if (typeof path !== 'string') return 'other'
  const value = path.replaceAll('\\', '/').replace(/\/+$/, '')
  const userData = diagnosticUserDataPath.replaceAll('\\', '/').replace(/\/+$/, '')
  if (value === userData) return 'profile'
  if (value === userData.slice(0, userData.lastIndexOf('/'))) return 'profile-parent'
  const meetingRoots = [
    ['fixture-main', 'fixture-meeting'],
    ['fixture-main', 'fixture-held-meeting'],
    ['fixture-physical-held', 'fixture-physical-held-meeting'],
    ['fixture-cleanup', 'fixture-cleanup-meeting'],
    ['fixture-cleanup', 'fixture-close-retained'],
    ['fixture-cleanup', 'fixture-capacity-must-remain-held']
  ]
  for (const [namespace, meeting] of meetingRoots) {
    const root = `${userData}/persistence-v2/${namespace}/meetings/${meeting}`
    if (value === root) return 'registry-root'
    if (value === `${root}/.journal-writer.lock`) return 'writer-lock'
  }
  if (
    value === process.execPath.replaceAll('\\', '/') ||
    value === `${userData}/persistence-v2/fixture-cleanup/meetings/fixture-close-retained/.close-probe`
  )
    return 'probe'
  return 'other'
}

function sendDiagnosticMessage(message: Record<string, unknown>): void {
  if (typeof process.send !== 'function') return
  try {
    process.send(message, (error) => {
      if (error) {
        diagnosticInvalid = true
        diagnosticOverflow = true
      }
    })
  } catch {
    diagnosticInvalid = true
    diagnosticOverflow = true
  }
}

function emitDiagnostic(
  stage: DiagnosticStage,
  options: {
    role?: DiagnosticRole
    state?: DiagnosticState
    error?: unknown
    handleOrdinal?: number
    ownClose?: boolean | null
    hookInvoked?: boolean | null
    teardown?: boolean
    command?: DiagnosticCommand
  } = {}
): void {
  try {
    if (diagnosticInvalid) diagnosticOverflow = true
    if (diagnosticSequence >= 64) {
      markDiagnosticOverflow()
      return
    }
    const observation = {
      schema: 'metis-qa-owner-diagnostic/v1',
      sequence: diagnosticSequence++,
      command: options.command ?? diagnosticCommand,
      stage,
      role: options.role ?? 'none',
      handleOrdinal: options.handleOrdinal ?? 0,
      state: options.state ?? 'not-started',
      error: diagnosticError(options.error),
      ownClose: options.ownClose ?? null,
      hookInvoked: options.hookInvoked ?? null,
      teardown: options.teardown ?? false
    }
    if (diagnosticInvalid) diagnosticOverflow = true
    sendDiagnosticMessage({
      type: 'owner-diagnostic',
      observation,
      overflow: diagnosticOverflow,
      samePromise: stage === 'settle-start' ? diagnosticSamePromise : null
    })
  } catch {
    diagnosticInvalid = true
    diagnosticOverflow = true
  }
}

function markDiagnosticOverflow(): void {
  if (diagnosticOverflow) return
  diagnosticOverflow = true
  sendDiagnosticMessage({ type: 'owner-diagnostic-overflow' })
}

function emitClassifiedFailure(
  stage: DiagnosticStage,
  error: unknown,
  options: Omit<NonNullable<Parameters<typeof emitDiagnostic>[1]>, 'error'> = {}
): void {
  emitDiagnostic(stage, { ...options, error })
  try {
    if (!(error instanceof AggregateError)) return
    const members: unknown = error.errors
    if (!Array.isArray(members)) {
      emitDiagnostic('aggregate-overflow', { ...options, state: 'rejected', error: 'other', ownClose: null })
      return
    }
    for (let index = 0; index < Math.min(members.length, 4); index += 1)
      emitDiagnostic('aggregate-member', { ...options, state: 'rejected', error: members[index], ownClose: null })
    if (members.length > 4)
      emitDiagnostic('aggregate-overflow', { ...options, state: 'rejected', error: 'other', ownClose: null })
  } catch {
    emitDiagnostic('aggregate-overflow', { ...options, state: 'rejected', error: 'other', ownClose: null })
  }
}

function observeFileHandle(
  handle: { close: (...args: unknown[]) => Promise<void> },
  path: unknown,
  operationCommand: DiagnosticCommand
): void {
  if (diagnosticHandleOrdinal >= 8) {
    markDiagnosticOverflow()
    return
  }
  const ordinal = ++diagnosticHandleOrdinal
  const role = diagnosticRole(path)
  observedHandles.set(handle, { role, ordinal })
  const originalClose = handle.close
  const ownClose = Object.prototype.hasOwnProperty.call(handle, 'close')
  emitDiagnostic('file-open', { role, state: 'fulfilled', handleOrdinal: ordinal, ownClose, command: operationCommand })
  handle.close = function (this: typeof handle, ...args: unknown[]) {
    const operationCommand = diagnosticCommand
    emitDiagnostic('file-close-start', {
      role,
      state: 'pending',
      handleOrdinal: ordinal,
      ownClose,
      command: operationCommand
    })
    let result: Promise<void>
    try {
      result = originalClose.apply(this, args)
    } catch (error) {
      emitClassifiedFailure('file-close-done', error, {
        role,
        state: 'rejected',
        handleOrdinal: ordinal,
        ownClose,
        command: operationCommand
      })
      throw error
    }
    void result.then(
      () =>
        emitDiagnostic('file-close-done', {
          role,
          state: 'fulfilled',
          handleOrdinal: ordinal,
          ownClose,
          command: operationCommand
        }),
      (error: unknown) =>
        emitClassifiedFailure('file-close-done', error, {
          role,
          state: 'rejected',
          handleOrdinal: ordinal,
          ownClose,
          command: operationCommand
        })
    )
    return result
  }
}

function installDiagnosticObservers(userDataPath: string): void {
  diagnosticUserDataPath = userDataPath
  type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }
  const mutableFs = fs as Mutable<typeof fs>
  const mutableFsp = fsp as Mutable<typeof fsp>
  const originalOpen = fsp.open
  mutableFsp.open = function (this: typeof fsp, path: unknown, ...args: unknown[]) {
    const operationCommand = diagnosticCommand
    const pending = originalOpen.apply(this, [path as never, ...(args as [never])])
    void pending.then(
      (handle) => {
        try {
          observeFileHandle(handle as never, path, operationCommand)
        } catch {
          diagnosticInvalid = true
        }
      },
      () => undefined
    )
    return pending
  } as typeof fsp.open
  const observeIo = (method: 'read' | 'write') => {
    const original = fs[method] as (...args: unknown[]) => unknown
    ;(mutableFs as unknown as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
      const callbackIndex = args.findIndex((value, index) => index >= 1 && typeof value === 'function')
      const callback = callbackIndex >= 0 ? (args[callbackIndex] as (...values: unknown[]) => void) : undefined
      const fd = args[0]
      const role: DiagnosticRole = fd === 3 ? 'reader3' : fd === 4 ? 'writer4' : 'other'
      if (callback && (fd === 3 || fd === 4)) {
        const operationCommand = diagnosticCommand
        const stage = method === 'read' ? 'read-start' : 'write-start'
        const done = method === 'read' ? 'read-done' : 'write-done'
        emitDiagnostic(stage, { role, state: 'pending', command: operationCommand })
        args[callbackIndex] = function (this: unknown, ...values: unknown[]) {
          if (values[0]) emitClassifiedFailure(done, values[0], { role, state: 'rejected', command: operationCommand })
          else emitDiagnostic(done, { role, state: 'fulfilled', command: operationCommand })
          callback.apply(this, values)
        }
      }
      return original.apply(this, args)
    }
  }
  observeIo('read')
  observeIo('write')
  const originalClose = fs.close
  ;(mutableFs as unknown as Record<string, unknown>).close = function (this: typeof fs, ...args: unknown[]) {
    const fd = args[0] as number
    const callbackIndex = args.length - 1
    const callback = args[callbackIndex] as (this: unknown, error?: NodeJS.ErrnoException | null) => void
    const role: DiagnosticRole = fd === 3 ? 'reader3' : fd === 4 ? 'writer4' : 'other'
    const operationCommand = diagnosticCommand
    emitDiagnostic('native-close-start', { role, state: 'pending', command: operationCommand })
    args[callbackIndex] = function (this: unknown, error?: NodeJS.ErrnoException | null) {
      if (error)
        emitClassifiedFailure('native-close-done', error, { role, state: 'rejected', command: operationCommand })
      else emitDiagnostic('native-close-done', { role, state: 'fulfilled', command: operationCommand })
      callback.call(this, error)
    }
    return originalClose.apply(this, args as Parameters<typeof fs.close>)
  }
  const instrumentStream = <T extends fs.ReadStream | fs.WriteStream>(stream: T, role: 'reader3' | 'writer4'): T => {
    const operationCommand = diagnosticCommand
    emitDiagnostic('transport-open', { role, state: 'fulfilled', command: operationCommand })
    const streamControl = stream as unknown as { destroy: (...args: unknown[]) => unknown }
    const originalDestroy = streamControl.destroy
    streamControl.destroy = function (this: unknown, ...args: unknown[]) {
      emitDiagnostic('destroy-request', { role, state: 'pending', command: diagnosticCommand })
      return originalDestroy.apply(this, args)
    }
    const events = stream as unknown as NodeJS.EventEmitter
    events.once('end', () => emitDiagnostic('stream-end', { role, state: 'fulfilled', command: operationCommand }))
    events.once('close', () => emitDiagnostic('stream-close', { role, state: 'fulfilled', command: operationCommand }))
    events.on('error', (error: unknown) =>
      emitClassifiedFailure('stream-error', error, { role, state: 'rejected', command: operationCommand })
    )
    return stream
  }
  const createReadStream = fs.createReadStream
  mutableFs.createReadStream = function (this: typeof fs, ...args: Parameters<typeof fs.createReadStream>) {
    const stream = createReadStream.apply(this, args)
    const options = args[1]
    if (options && typeof options === 'object' && 'fd' in options && options.fd === 3) {
      try {
        return instrumentStream(stream, 'reader3') as fs.ReadStream
      } catch {
        diagnosticInvalid = true
      }
    }
    return stream
  } as typeof fs.createReadStream
  const createWriteStream = fs.createWriteStream
  mutableFs.createWriteStream = function (this: typeof fs, ...args: Parameters<typeof fs.createWriteStream>) {
    const stream = createWriteStream.apply(this, args)
    const options = args[1]
    if (options && typeof options === 'object' && 'fd' in options && options.fd === 4) {
      try {
        return instrumentStream(stream, 'writer4') as fs.WriteStream
      } catch {
        diagnosticInvalid = true
      }
    }
    return stream
  } as typeof fs.createWriteStream
  syncBuiltinESMExports()
}

function report(value: Readonly<Record<string, unknown>>): void {
  if (typeof process.send === 'function') process.send(value)
}

async function main(): Promise<void> {
  const userDataPath = process.argv[2]
  if (!userDataPath) throw new Error('QA source fixture profile path is required')
  installDiagnosticObservers(userDataPath)
  setQaFixtureUserDataPath(userDataPath)
  applyLegacyPersistenceNativeKeyDefault()
  const mode = process.argv[3] ?? 'shown'
  const window = new QaFixtureBrowserWindow()
  if (mode !== 'no-window') {
    bindQaPersistenceMainWindow(window as never)
    if (mode !== 'unshown') window.show()
    if (mode !== 'uncommitted') window.commitInitialMainDocument()
    if (mode === 'hidden') window.hide()
  }

  let run: QaPersistenceRunPermit
  let previousRun: QaPersistenceRunPermit | undefined
  let releaseHeldGateway: (() => void) | undefined
  let releaseProfilePreparationStat: (() => void) | undefined
  let releaseHeldProfilePhysicalCheck: (() => void) | undefined
  let failedProfileHandle: { close: () => Promise<void> } | undefined
  let profilePreparationHookActive = false
  let heldPreparationRole: DiagnosticRole = 'none'
  let heldPreparationOrdinal = 0
  let heldPhysicalRole: DiagnosticRole = 'none'
  let heldPhysicalOrdinal = 0
  process.on('message', (message: ChildCommand) => {
    const command = message?.command ?? 'none'
    diagnosticCommand = command
    if (message?.command === 'hold-profile-preparation') {
      void (async () => {
        const probe = await open(process.execPath, 'r')
        const prototype = Object.getPrototypeOf(probe) as {
          stat: (...args: unknown[]) => Promise<unknown>
          close: (...args: unknown[]) => Promise<void>
        }
        const originalStat = prototype.stat
        const originalClose = prototype.close
        await probe.close()
        let held = false
        let settledDescriptorCount = 0
        profilePreparationHookActive = true
        prototype.stat = async function (this: unknown, ...args: unknown[]) {
          const result = await originalStat.apply(this, args)
          if (!held) {
            held = true
            const identity = this && typeof this === 'object' ? observedHandles.get(this) : undefined
            heldPreparationRole = identity?.role ?? 'other'
            heldPreparationOrdinal = identity?.ordinal ?? 0
            emitDiagnostic('gate-held', {
              role: heldPreparationRole,
              handleOrdinal: heldPreparationOrdinal,
              state: 'pending',
              command
            })
            report({ type: 'profile-preparation-stat-held' })
            await new Promise<void>((resolve) => {
              releaseProfilePreparationStat = resolve
            })
          }
          return result
        }
        prototype.close = async function (this: unknown, ...args: unknown[]) {
          const identity = this && typeof this === 'object' ? observedHandles.get(this) : undefined
          emitDiagnostic('prototype-hook-armed', {
            role: identity?.role ?? 'other',
            handleOrdinal: identity?.ordinal ?? 0,
            state: 'fulfilled',
            hookInvoked: true,
            command: diagnosticCommand
          })
          await originalClose.apply(this, args)
          settledDescriptorCount += 1
          if (settledDescriptorCount >= 2) {
            profilePreparationHookActive = false
            prototype.stat = originalStat
            prototype.close = originalClose
            report({ type: 'profile-preparation-descriptors-settled', settledDescriptorCount })
          }
        }
        emitDiagnostic('prototype-hook-armed', { role: 'profile', state: 'pending', hookInvoked: false, command })
        report({ type: 'profile-preparation-hold-ready' })
      })().catch((error) => {
        emitClassifiedFailure('fixture-refusal', error, { role: 'profile', state: 'rejected', command })
        report({ type: 'fixture-error' })
      })
      return
    }
    if (message?.command === 'duplicate-prepare' && profilePreparationHookActive) {
      void prepareQaPersistenceRun().then(
        () => report({ type: 'duplicate-prepare', refusal: '' }),
        (error) =>
          report({ type: 'duplicate-prepare', refusal: (error as { code?: string }).code ?? 'run-already-owned' })
      )
      return
    }
    if (message?.command === 'release-profile-preparation') {
      if (releaseProfilePreparationStat)
        emitDiagnostic('gate-released', {
          role: heldPreparationRole,
          handleOrdinal: heldPreparationOrdinal,
          state: 'fulfilled',
          command
        })
      releaseProfilePreparationStat?.()
      releaseProfilePreparationStat = undefined
      return
    }
    if (message?.command !== 'retire-during-preparation') return
    if (message.event === 'navigate') {
      window.navigateMainDocument()
      window.finishMainNavigation()
    } else if (message.event === 'replace') {
      const replacement = new QaFixtureBrowserWindow()
      bindQaPersistenceMainWindow(replacement as never)
      replacement.show()
      replacement.commitInitialMainDocument()
    } else if (message.event === 'close') {
      window.destroy()
    } else if (message.event === 'render-process-loss') {
      window.loseRendererProcess()
    }
    report({ type: 'preparation-window-retired', event: message.event })
  })
  report({ type: 'preparing' })
  try {
    run = await prepareQaPersistenceRun()
  } catch (error) {
    emitClassifiedFailure('fixture-refusal', error, { role: 'profile', state: 'rejected', command: 'prepare' })
    report({ type: 'refused', code: (error as { code?: string }).code ?? 'run-retired' })
    return
  }
  report({ type: 'active', current: captureCurrentQaPersistenceRun() === run })
  diagnosticCommand = 'none'

  process.on('message', (message: ChildCommand) => {
    const command = message?.command ?? 'none'
    void (async () => {
      if (message?.command === 'check') {
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        report({ type: 'current', current: captureCurrentQaPersistenceRun() === run })
        return
      }
      if (message?.command === 'hide-check') {
        window.hide()
        report({ type: 'hidden', current: captureCurrentQaPersistenceRun() === run })
        return
      }
      if (message?.command === 'navigate-aba') {
        window.navigateMainDocument()
        window.finishMainNavigation()
        report({ type: 'navigation-aba', current: captureCurrentQaPersistenceRun() === run })
        return
      }
      if (message?.command === 'duplicate-prepare') {
        let refusal = ''
        try {
          await prepareQaPersistenceRun()
        } catch (error) {
          refusal = (error as { code?: string }).code ?? 'unknown'
          emitClassifiedFailure('fixture-refusal', error, { role: 'profile', state: 'rejected', command })
        }
        report({ type: 'duplicate-prepare', refusal })
        return
      }
      if (message?.command === 'successor') {
        try {
          run = await prepareQaPersistenceRun()
          report({ type: 'successor-active', current: captureCurrentQaPersistenceRun() === run })
        } catch (error) {
          emitClassifiedFailure('fixture-refusal', error, { role: 'profile', state: 'rejected', command })
          report({ type: 'successor-refused', code: (error as { code?: string }).code ?? 'run-retired' })
        }
        return
      }
      if (message?.command === 'stale-owner') {
        let callbacks = 0
        const roots = new RootRegistry({
          qaProfileOwner: previousRun,
          resolveScope: () => {
            callbacks += 1
            return undefined
          },
          bindGatewayRoot: async () => undefined
        })
        let refused = false
        try {
          await roots.openExisting(Object.freeze({}), 'fixture-stale-cross-run')
        } catch (error) {
          emitClassifiedFailure('fixture-refusal', error, { role: 'registry-root', state: 'rejected', command })
          refused = true
        }
        report({ type: 'stale-owner', refused, callbacks })
        return
      }
      if (message?.command === 'create-root-held') {
        const scopes = new WeakMap<object, RootScopeBinding>()
        const scope = Object.freeze({})
        scopes.set(
          scope,
          Object.freeze({
            profileNamespace: 'fixture-main',
            principalAssociation: 'fixture-principal',
            generation: 'fixture-generation',
            nativeKeyAccess: 'allowed',
            legacyFileKeyAccess: 'denied',
            maxHeldRoots: 1,
            isCurrent: () => true
          })
        )
        let gatewayPublished = false
        const roots = new RootRegistry({
          qaProfileOwner: run,
          resolveScope: (candidate) => scopes.get(candidate as object),
          bindGatewayRoot: async (root) => {
            root.assertCurrent()
            emitDiagnostic('gate-held', { role: 'registry-root', state: 'pending', command })
            report({ type: 'gateway-held' })
            await new Promise<void>((resolve) => {
              releaseHeldGateway = resolve
            })
            root.assertCurrent()
            gatewayPublished = true
          }
        })
        try {
          await roots.create(scope, 'fixture-held-meeting')
          report({ type: 'root-held', created: true, gatewayPublished })
        } catch (error) {
          emitClassifiedFailure('fixture-refusal', error, { role: 'registry-root', state: 'rejected', command })
          report({ type: 'root-held', created: false, gatewayPublished })
        }
        return
      }
      if (message?.command === 'create-root-physical-held') {
        const probe = await open(process.execPath, 'r')
        const prototype = Object.getPrototypeOf(probe) as { stat: (...args: unknown[]) => Promise<unknown> }
        const originalStat = prototype.stat
        await probe.close()
        let held = false
        let gatewayCalls = 0
        prototype.stat = async function (this: unknown, ...args: unknown[]) {
          const result = await originalStat.apply(this, args)
          if (!held) {
            held = true
            const identity = this && typeof this === 'object' ? observedHandles.get(this) : undefined
            heldPhysicalRole = identity?.role ?? 'other'
            heldPhysicalOrdinal = identity?.ordinal ?? 0
            emitDiagnostic('gate-held', {
              role: heldPhysicalRole,
              handleOrdinal: heldPhysicalOrdinal,
              state: 'pending',
              command
            })
            report({ type: 'registry-profile-physical-held' })
            await new Promise<void>((resolve) => {
              releaseHeldProfilePhysicalCheck = resolve
            })
          }
          return result
        }
        const scopes = new WeakMap<object, RootScopeBinding>()
        const scope = Object.freeze({})
        scopes.set(
          scope,
          Object.freeze({
            profileNamespace: 'fixture-physical-held',
            principalAssociation: 'fixture-physical-principal',
            generation: 'fixture-physical-generation',
            nativeKeyAccess: 'allowed',
            legacyFileKeyAccess: 'denied',
            maxHeldRoots: 1,
            isCurrent: () => true
          })
        )
        const roots = new RootRegistry({
          qaProfileOwner: run,
          resolveScope: (candidate) => scopes.get(candidate as object),
          bindGatewayRoot: async () => {
            gatewayCalls += 1
            throw new Error('gateway must not be reached after profile retirement')
          }
        })
        try {
          await roots.create(scope, 'fixture-physical-held-meeting')
          report({ type: 'registry-profile-physical-result', created: true, gatewayCalls })
        } catch (error) {
          emitClassifiedFailure('fixture-refusal', error, { role: 'registry-root', state: 'rejected', command })
          let registryPathUntouched = false
          try {
            await lstat(join(userDataPath, 'persistence-v2'))
          } catch (error) {
            registryPathUntouched = (error as NodeJS.ErrnoException).code === 'ENOENT'
          }
          report({ type: 'registry-profile-physical-result', created: false, gatewayCalls, registryPathUntouched })
        } finally {
          prototype.stat = originalStat
        }
        return
      }
      if (message?.command === 'retire-window-resume') {
        window.navigateMainDocument()
        window.finishMainNavigation()
        if (releaseHeldGateway) emitDiagnostic('gate-released', { role: 'registry-root', state: 'fulfilled', command })
        releaseHeldGateway?.()
        releaseHeldGateway = undefined
        return
      }
      if (message?.command === 'release-profile-physical-check') {
        if (releaseHeldProfilePhysicalCheck)
          emitDiagnostic('gate-released', {
            role: heldPhysicalRole,
            handleOrdinal: heldPhysicalOrdinal,
            state: 'fulfilled',
            command
          })
        releaseHeldProfilePhysicalCheck?.()
        releaseHeldProfilePhysicalCheck = undefined
        return
      }
      if (message?.command === 'fail-profile-close') {
        const probe = await open(process.execPath, 'r')
        const prototype = Object.getPrototypeOf(probe) as { close: (...args: unknown[]) => Promise<void> }
        const originalClose = prototype.close
        await probe.close()
        let failed = false
        prototype.close = function (this: { close: () => Promise<void> }, ...args: unknown[]) {
          if (!failed) {
            failed = true
            const identity = observedHandles.get(this)
            emitDiagnostic('prototype-hook-armed', {
              role: identity?.role ?? 'other',
              handleOrdinal: identity?.ordinal ?? 0,
              state: 'fulfilled',
              hookInvoked: true,
              command: diagnosticCommand
            })
            failedProfileHandle = this
            prototype.close = originalClose
            return Promise.reject(new Error('injected run profile descriptor close failure'))
          }
          return originalClose.apply(this, args)
        }
        emitDiagnostic('prototype-hook-armed', { role: 'profile', state: 'pending', hookInvoked: false, command })
        report({ type: 'profile-close-failure-armed' })
        return
      }
      if (message?.command === 'release-failed-close') {
        await failedProfileHandle?.close().catch(() => undefined)
        failedProfileHandle = undefined
        return
      }
      if (message?.command === 'change-userdata-resume') {
        setQaFixtureUserDataPath(`${userDataPath}-changed`)
        if (releaseHeldGateway) emitDiagnostic('gate-released', { role: 'registry-root', state: 'fulfilled', command })
        if (releaseHeldProfilePhysicalCheck)
          emitDiagnostic('gate-released', {
            role: heldPhysicalRole,
            handleOrdinal: heldPhysicalOrdinal,
            state: 'fulfilled',
            command
          })
        releaseHeldGateway?.()
        releaseHeldGateway = undefined
        releaseHeldProfilePhysicalCheck?.()
        releaseHeldProfilePhysicalCheck = undefined
        return
      }
      if (message?.command === 'create-root') {
        const scopes = new WeakMap<object, RootScopeBinding>()
        const scope = Object.freeze({})
        const binding: RootScopeBinding = Object.freeze({
          profileNamespace: 'fixture-main',
          principalAssociation: 'fixture-principal',
          generation: 'fixture-generation',
          nativeKeyAccess: 'allowed',
          legacyFileKeyAccess: 'denied',
          maxHeldRoots: 1,
          isCurrent: () => true
        })
        scopes.set(scope, binding)
        const gateways = new WeakMap<object, ReturnType<typeof createStorageGateway>>()
        const roots = new RootRegistry({
          qaProfileOwner: run,
          resolveScope: (candidate) => scopes.get(candidate as object),
          bindGatewayRoot: async (root) => {
            root.assertCurrent()
            gateways.set(root, createStorageGateway({ root: () => join(root.meetingPath, 'journal') }))
          }
        })
        try {
          const root = await roots.create(scope, 'fixture-meeting')
          await root.assertPhysicalCurrent()
          await roots.closeRoot(scope, root)
          report({ type: 'root', created: true })
        } catch (error) {
          emitClassifiedFailure('fixture-refusal', error, { role: 'registry-root', state: 'rejected', command })
          report({ type: 'root', created: false })
        }
        return
      }
      if (message?.command === 'registry-negative') {
        let scopeCallbacks = 0
        let baseCallbacks = 0
        const scopes = new WeakMap<object, RootScopeBinding>()
        const scope = Object.freeze({})
        const binding: RootScopeBinding = Object.freeze({
          profileNamespace: 'fixture-main',
          principalAssociation: 'fixture-principal',
          generation: 'fixture-generation',
          nativeKeyAccess: 'allowed',
          legacyFileKeyAccess: 'denied',
          maxHeldRoots: 1,
          isCurrent: () => true
        })
        scopes.set(scope, binding)
        const common = {
          resolveScope: (candidate: object) => {
            scopeCallbacks += 1
            return scopes.get(candidate)
          },
          bindGatewayRoot: async () => undefined
        }
        const base = () => {
          baseCallbacks += 1
          return userDataPath
        }
        const rejectedBeforeIo = async (roots: RootRegistry): Promise<boolean> => {
          try {
            await roots.openExisting(scope, 'fixture-missing')
            return false
          } catch (error) {
            emitClassifiedFailure('fixture-refusal', error, { role: 'registry-root', state: 'rejected', command })
            return true
          }
        }
        const missing = new RootRegistry({ ...common, userDataRoot: base })
        const missingRefused = await rejectedBeforeIo(missing)
        const forged = new RootRegistry({
          ...common,
          userDataRoot: base,
          qaProfileOwner: Object.freeze({}) as QaPersistenceRunPermit
        })
        const forgedRefused = await rejectedBeforeIo(forged)
        const beforeOverrideScopeCalls = scopeCallbacks
        const override = new RootRegistry({ ...common, userDataRoot: base, qaProfileOwner: run })
        const overrideRefused = await rejectedBeforeIo(override)
        const ownerlessRejectedCallbacks = scopeCallbacks
        const guardedMissing = new RootRegistry({ ...common, qaProfileOwner: run })
        try {
          await guardedMissing.openExisting(scope, 'fixture-open-existing-missing')
        } catch (error) {
          emitClassifiedFailure('fixture-refusal', error, { role: 'registry-root', state: 'rejected', command })
          // Missing is the expected result; the following lstat proves no tree was created.
        }
        let missingTreeUntouched = false
        try {
          await lstat(join(userDataPath, 'persistence-v2'))
        } catch (error) {
          missingTreeUntouched = (error as NodeJS.ErrnoException).code === 'ENOENT'
        }
        report({
          type: 'registry-negative',
          missingRefused,
          forgedRefused,
          overrideRefused,
          missingTreeUntouched,
          missingAndForgedCallbacks: beforeOverrideScopeCalls,
          totalScopeCallbacks: ownerlessRejectedCallbacks,
          baseCallbacks
        })
        return
      }
      if (message?.command === 'registry-cleanup') {
        const scopes = new WeakMap<object, RootScopeBinding>()
        const scope = Object.freeze({})
        scopes.set(
          scope,
          Object.freeze({
            profileNamespace: 'fixture-cleanup',
            principalAssociation: 'fixture-cleanup-principal',
            generation: 'fixture-cleanup-generation',
            nativeKeyAccess: 'allowed',
            legacyFileKeyAccess: 'denied',
            maxHeldRoots: 1,
            isCurrent: () => true
          })
        )
        const roots = new RootRegistry({
          qaProfileOwner: run,
          resolveScope: (candidate) => scopes.get(candidate as object),
          bindGatewayRoot: async () => undefined
        })
        let foreignReplacementPreserved = false
        let foreignPath = ''
        let backupPath = ''
        let closeCapacityRetained = false
        let leakedDirectory: { close: () => Promise<void> } | undefined
        let originalClose: ((...args: unknown[]) => Promise<void>) | undefined
        try {
          const root = await roots.create(scope, 'fixture-cleanup-meeting')
          const writer = await roots.acquireWriter(scope, root)
          foreignPath = writer.lockPath
          backupPath = `${foreignPath}.held-original`
          await rename(foreignPath, backupPath)
          await writeFile(foreignPath, 'foreign replacement', { flag: 'wx', mode: 0o600 })
          await writer.release()
          foreignReplacementPreserved = (await readFile(foreignPath, 'utf8')) === 'foreign replacement'
          await rm(foreignPath, { force: true })
          await rename(backupPath, foreignPath)
          await rm(foreignPath, { force: true })
          await roots.closeRoot(scope, root)

          const retained = await roots.create(scope, 'fixture-close-retained')
          const probe = await open(join(retained.meetingPath, '.close-probe'), 'w+')
          const closePrototype = Object.getPrototypeOf(probe) as { close: (...args: unknown[]) => Promise<void> }
          await probe.close()
          originalClose = closePrototype.close
          closePrototype.close = function (this: { close: () => Promise<void> }, ...args: unknown[]) {
            closePrototype!.close = originalClose!
            const identity = observedHandles.get(this)
            emitDiagnostic('prototype-hook-armed', {
              role: identity?.role ?? 'other',
              handleOrdinal: identity?.ordinal ?? 0,
              state: 'fulfilled',
              hookInvoked: true,
              command
            })
            leakedDirectory = this
            return Promise.reject(new Error('injected root descriptor close failure'))
          }
          emitDiagnostic('prototype-hook-armed', {
            role: 'registry-root',
            state: 'pending',
            hookInvoked: false,
            command
          })
          try {
            await roots.closeRoot(scope, retained)
          } catch (error) {
            emitClassifiedFailure('fixture-refusal', error, { role: 'registry-root', state: 'rejected', command })
            try {
              await roots.create(scope, 'fixture-capacity-must-remain-held')
            } catch (error) {
              emitClassifiedFailure('fixture-refusal', error, { role: 'registry-root', state: 'rejected', command })
              closeCapacityRetained = true
            }
          } finally {
            closePrototype.close = originalClose!
            await leakedDirectory?.close()
          }
        } catch (error) {
          emitClassifiedFailure('fixture-refusal', error, { role: 'registry-root', state: 'rejected', command })
          if (foreignPath) await rm(foreignPath, { force: true }).catch(() => undefined)
          if (backupPath) await rm(backupPath, { force: true }).catch(() => undefined)
        }
        report({ type: 'registry-cleanup', foreignReplacementPreserved, closeCapacityRetained })
        return
      }
      if (message?.command === 'settle') {
        let settlement: Promise<void> | undefined
        let repeated: Promise<void> | undefined
        try {
          settlement = settleQaPersistenceRun(run)
          repeated = settleQaPersistenceRun(run)
          diagnosticSamePromise = settlement === repeated
          emitDiagnostic('settle-start', { role: 'profile', state: 'pending', command })
          void settlement.then(
            () => emitDiagnostic('settle-fulfilled', { role: 'profile', state: 'fulfilled', command }),
            (error: unknown) =>
              emitClassifiedFailure('settle-rejected', error, { role: 'profile', state: 'rejected', command })
          )
          await settlement
          previousRun = run
          report({
            type: 'settled',
            available: captureCurrentQaPersistenceRun() === null,
            samePromise: settlement === repeated
          })
        } catch (error) {
          report({
            type: 'settlement-failed',
            available: captureCurrentQaPersistenceRun() === null,
            samePromise: settlement === repeated
          })
        }
      }
    })().catch((error) => {
      emitClassifiedFailure('fixture-refusal', error, { role: 'none', state: 'rejected', command })
      report({ type: 'fixture-error' })
    })
  })
}

void main().catch((error) => {
  emitClassifiedFailure('fixture-refusal', error, { role: 'none', state: 'rejected' })
  report({ type: 'fixture-error' })
})
