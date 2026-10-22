import { app } from 'electron'
import { ownerRecordStore, reconcileSignedInOwner } from '../credential-account-switch'
import { runCredentialCleanup } from '../credential-cleanup'
import { productionClearers } from '../credential-clearers'
import { authSessionGeneration } from '../auth'
import { createCredentialLifecycle, type CredentialCleanupContext } from '../credential-lifecycle'
import { currentOwnerSession } from './owner-session-wiring'

export { disconnectProvider } from '../credential-clearers'

/**
 * The credential lifecycle main uses (Métis 2.12 G20): sign-out cleanup on every session end, the account-switch
 * check at sign-in, and reset cleanup before the profile is archived. Dependencies resolve on each call, so the
 * owner-session authority (built later, in registerIpc) and the profile folder are read when they are needed.
 */
const cleanup = async (
  trigger: Parameters<typeof runCredentialCleanup>[0],
  context?: CredentialCleanupContext
): Promise<{ failed: number }> => {
  const authGeneration = context && { atTrigger: context.generation, current: authSessionGeneration }
  const receipt = await runCredentialCleanup(trigger, productionClearers({ authGeneration }))
  return { failed: receipt.failed }
}

export const credentialLifecycle = createCredentialLifecycle({
  generation: authSessionGeneration,
  cleanup,
  reconcile: () => {
    const record = ownerRecordStore(app.getPath('userData'))
    return reconcileSignedInOwner({
      currentOwnerKey: () => currentOwnerSession()?.currentOwnerKey() ?? null,
      readRememberedOwner: () => record.read(),
      rememberOwner: (ownerKey) => record.write(ownerKey),
      cleanup: () => cleanup('accountSwitch')
    })
  }
})
