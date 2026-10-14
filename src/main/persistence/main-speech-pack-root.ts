import { createHash } from 'node:crypto'
import { app } from 'electron'
import { resolve } from 'node:path'
import { userDataSpeechPackRoot } from '../asr-bundled-ensure'
import { captureMainPersistenceSessionBoundary } from '../auth'
import { isSettingsAuthorityCurrent, captureSettingsAuthority } from '../settings-authority-history'
import {
  assertRuntimePackNamespaceCurrent,
  captureRuntimePackNamespace,
  describeRuntimePackNamespace,
  disposeRuntimePackNamespace,
  type RuntimePackNamespace
} from '../infra/storage/runtime-pack-namespace'
import {
  assertRuntimeSpeechPackPurposeRootCurrent,
  describeRuntimeSpeechPackPurposeRoot,
  disposeRuntimeSpeechPackPurposeRoot,
  openRuntimeSpeechPackPurposeRoot,
  type RuntimeSpeechPackPurposeRoot
} from '../infra/storage/runtime-purpose-root'
import {
  captureRuntimeProfileParentPin,
  disposeRuntimeProfileParentPin,
  type RuntimeProfileBinding,
  type RuntimeProfileParentPin
} from '../infra/storage/runtime-purpose-root'
import { PERSISTENCE_NATIVE_KEY_INTENT } from './bootstrap'

export type MainSpeechPackRootMode = 'open-existing' | 'create'

export interface MainSpeechPackRootLease {
  readonly scope: Readonly<{
    profileNamespace: string
    principalAssociation: string
    profileGeneration: string
    nativeKeyAccess: 'allowed' | 'explicitly-disabled'
    intent: 'explicit-pack-maintenance'
    assertCurrent(): void
    assertPhysicalCurrent(): Promise<void>
  }>
  readonly namespace: RuntimePackNamespace
  readonly keyPurposeRoot: RuntimeSpeechPackPurposeRoot
  readonly keyRegistryRoot: Readonly<{
    bindingId: string
    assertCurrent(): void
    assertPhysicalCurrent(): Promise<void>
  }>
  readonly profileNamespace: string
  readonly principalAssociation: string
  readonly profileGeneration: string
  readonly intent: 'explicit-pack-maintenance'
  readonly bindingId: string
  readonly rootPath: string
  readonly keyRootBindingId: string
  readonly keyRootPath: string
  readonly keyRootFresh: boolean
  readonly fresh: boolean
  readonly nativeKeyAccess: 'allowed' | 'explicitly-disabled'
  assertCurrentSync(): void
  assertPhysicalCurrent(): Promise<void>
  dispose(): Promise<void>
}

const leases = new WeakMap<
  object,
  {
    readonly namespace: RuntimePackNamespace
    readonly keyPurposeRoot: RuntimeSpeechPackPurposeRoot
    readonly parent: RuntimeProfileParentPin
    readonly current: () => boolean
    retired: boolean
    disposed: boolean
    settling?: Promise<void>
  }
>()

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Main-only producer. The caller selects a fixed operation mode; no renderer path or identity is accepted. */
export async function captureMainSpeechPackRoot(
  mode: MainSpeechPackRootMode,
  options: { readonly afterFirstShow: () => boolean }
): Promise<MainSpeechPackRootLease> {
  const auth = captureMainPersistenceSessionBoundary()
  const settings = captureSettingsAuthority('import')
  if (!settings || !auth.isCurrent() || !app.hasSingleInstanceLock() || !options.afterFirstShow()) {
    throw new Error('Speech-pack ownership requires a live main action after first show')
  }
  if (mode === 'create' && PERSISTENCE_NATIVE_KEY_INTENT !== 'allowed') {
    throw new Error('Speech-pack key access is disabled by the original native-key isolation setting')
  }

  const profilePath = resolve(app.getPath('userData'))
  const principal = auth.principalAssociation ?? digest(`local-profile/v1\n${profilePath}`)
  const profileBinding = digest(`metis-profile/v1\n${profilePath}\n${principal}`)
  const binding: RuntimeProfileBinding = Object.freeze({
    profileBinding,
    principalBinding: principal,
    persistentProfileGeneration: profileBinding
  })
  let retired = false
  let disposed = false
  let lastWallNow = Date.now()
  let lastMonotonicNow = performance.now()
  const current = (): boolean => {
    const wallNow = Date.now()
    const monotonicNow = performance.now()
    if (
      retired ||
      disposed ||
      !Number.isFinite(wallNow) ||
      !Number.isFinite(monotonicNow) ||
      wallNow < lastWallNow ||
      monotonicNow < lastMonotonicNow ||
      resolve(app.getPath('userData')) !== profilePath ||
      !app.hasSingleInstanceLock() ||
      !options.afterFirstShow() ||
      !auth.isCurrent() ||
      !isSettingsAuthorityCurrent(settings)
    ) {
      retired = true
      return false
    }
    lastWallNow = wallNow
    lastMonotonicNow = monotonicNow
    return true
  }
  const assertCurrentSync = (): void => {
    if (!current()) throw new Error('Speech-pack profile authority has retired')
  }

  assertCurrentSync()
  const runtimeMode = mode === 'create' ? 'create-explicit' : 'open-existing'
  const parent = await captureRuntimeProfileParentPin({
    profilePath,
    binding,
    assertCurrentSync,
    assertProfilePhysicalCurrent: async () => assertCurrentSync(),
    assertSingleInstanceCurrentSync: assertCurrentSync
  })
  try {
    assertCurrentSync()
    const keyPurposeRoot = await openRuntimeSpeechPackPurposeRoot({ parent, mode: runtimeMode })
    try {
      assertCurrentSync()
      const keyRootDescription = describeRuntimeSpeechPackPurposeRoot(keyPurposeRoot)
      const namespace = await captureRuntimePackNamespace({
        profile: parent,
        mainPackRootPath: resolve(userDataSpeechPackRoot()),
        mode: runtimeMode
      })
      try {
        assertCurrentSync()
        const description = describeRuntimePackNamespace(namespace)
        if (
          description.profile.profileBinding !== profileBinding ||
          description.profile.principalBinding !== principal
        ) {
          throw new Error('Speech-pack namespace does not match the captured account/profile authority')
        }
        const handle = Object.freeze({}) as MainSpeechPackRootLease
        const state = {
          namespace,
          keyPurposeRoot,
          parent,
          current,
          retired: false,
          disposed: false
        }
        leases.set(handle as object, state)
        const assertLeaseCurrentSync = (): void => {
          const lease = leases.get(handle as object)
          if (!lease || lease.retired || lease.disposed || !lease.current()) {
            if (lease) lease.retired = true
            throw new Error('Speech-pack root lease has retired')
          }
          describeRuntimePackNamespace(lease.namespace)
          describeRuntimeSpeechPackPurposeRoot(lease.keyPurposeRoot)
        }
        const assertLeasePhysicalCurrent = async (): Promise<void> => {
          assertLeaseCurrentSync()
          const lease = leases.get(handle as object)!
          await assertRuntimePackNamespaceCurrent(lease.namespace)
          await assertRuntimeSpeechPackPurposeRootCurrent(lease.keyPurposeRoot)
          assertLeaseCurrentSync()
        }
        const scope = Object.freeze({
          profileNamespace: profileBinding,
          principalAssociation: principal,
          profileGeneration: profileBinding,
          nativeKeyAccess: PERSISTENCE_NATIVE_KEY_INTENT,
          intent: 'explicit-pack-maintenance' as const,
          assertCurrent: assertLeaseCurrentSync,
          assertPhysicalCurrent: assertLeasePhysicalCurrent
        })
        return Object.freeze({
          scope,
          namespace,
          keyPurposeRoot,
          keyRegistryRoot: Object.freeze({
            bindingId: keyRootDescription.bindingId,
            assertCurrent: assertLeaseCurrentSync,
            assertPhysicalCurrent: async () => {
              assertLeaseCurrentSync()
              await assertRuntimeSpeechPackPurposeRootCurrent(keyPurposeRoot)
              assertLeaseCurrentSync()
            }
          }),
          profileNamespace: profileBinding,
          principalAssociation: principal,
          profileGeneration: profileBinding,
          intent: 'explicit-pack-maintenance' as const,
          bindingId: description.bindingId,
          rootPath: description.rootPath,
          keyRootBindingId: keyRootDescription.bindingId,
          keyRootPath: keyRootDescription.rootPath,
          keyRootFresh: keyRootDescription.fresh,
          fresh: description.fresh,
          nativeKeyAccess: PERSISTENCE_NATIVE_KEY_INTENT,
          assertCurrent: assertLeaseCurrentSync,
          assertCurrentSync: assertLeaseCurrentSync,
          assertPhysicalCurrent: assertLeasePhysicalCurrent,
          async dispose(): Promise<void> {
            const lease = leases.get(handle as object)
            if (!lease || lease.disposed) return
            lease.retired = true
            lease.disposed = true
            if (lease.settling) return lease.settling
            lease.settling = (async () => {
              await disposeRuntimePackNamespace(lease.namespace)
              await disposeRuntimeSpeechPackPurposeRoot(lease.keyPurposeRoot)
              await disposeRuntimeProfileParentPin(lease.parent)
            })()
            return lease.settling
          }
        })
      } catch (error) {
        await disposeRuntimePackNamespace(namespace).catch(() => undefined)
        throw error
      }
    } catch (error) {
      await disposeRuntimeSpeechPackPurposeRoot(keyPurposeRoot).catch(() => undefined)
      throw error
    }
  } catch (error) {
    await disposeRuntimeProfileParentPin(parent).catch(() => undefined)
    throw error
  }
}
