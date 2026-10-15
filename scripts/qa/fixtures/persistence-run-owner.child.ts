import { join } from 'node:path'
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

function report(value: Readonly<Record<string, unknown>>): void {
  if (typeof process.send === 'function') process.send(value)
}

async function main(): Promise<void> {
  const userDataPath = process.argv[2]
  if (!userDataPath) throw new Error('QA source fixture profile path is required')
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
  process.on('message', (message: ChildCommand) => {
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
            report({ type: 'profile-preparation-stat-held' })
            await new Promise<void>((resolve) => {
              releaseProfilePreparationStat = resolve
            })
          }
          return result
        }
        prototype.close = async function (this: unknown, ...args: unknown[]) {
          await originalClose.apply(this, args)
          settledDescriptorCount += 1
          if (settledDescriptorCount >= 2) {
            profilePreparationHookActive = false
            prototype.stat = originalStat
            prototype.close = originalClose
            report({ type: 'profile-preparation-descriptors-settled', settledDescriptorCount })
          }
        }
        report({ type: 'profile-preparation-hold-ready' })
      })().catch(() => report({ type: 'fixture-error' }))
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
    report({ type: 'refused', code: (error as { code?: string }).code ?? 'run-retired' })
    return
  }
  report({ type: 'active', current: captureCurrentQaPersistenceRun() === run })

  process.on('message', (message: ChildCommand) => {
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
        }
        report({ type: 'duplicate-prepare', refusal })
        return
      }
      if (message?.command === 'successor') {
        try {
          run = await prepareQaPersistenceRun()
          report({ type: 'successor-active', current: captureCurrentQaPersistenceRun() === run })
        } catch (error) {
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
        } catch {
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
        } catch {
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
        } catch {
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
        releaseHeldGateway?.()
        releaseHeldGateway = undefined
        return
      }
      if (message?.command === 'release-profile-physical-check') {
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
            failedProfileHandle = this
            prototype.close = originalClose
            return Promise.reject(new Error('injected run profile descriptor close failure'))
          }
          return originalClose.apply(this, args)
        }
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
        } catch {
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
          } catch {
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
        } catch {
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
            leakedDirectory = this
            return Promise.reject(new Error('injected root descriptor close failure'))
          }
          try {
            await roots.closeRoot(scope, retained)
          } catch {
            try {
              await roots.create(scope, 'fixture-capacity-must-remain-held')
            } catch {
              closeCapacityRetained = true
            }
          } finally {
            closePrototype.close = originalClose!
            await leakedDirectory?.close()
          }
        } catch {
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
          await settlement
          previousRun = run
          report({
            type: 'settled',
            available: captureCurrentQaPersistenceRun() === null,
            samePromise: settlement === repeated
          })
        } catch {
          report({
            type: 'settlement-failed',
            available: captureCurrentQaPersistenceRun() === null,
            samePromise: settlement === repeated
          })
        }
      }
    })().catch(() => report({ type: 'fixture-error' }))
  })
}

void main().catch(() => report({ type: 'fixture-error' }))
