import type { AuthStatus } from '@shared/ipc'
import { isAuthEnvironmentSnapshotCurrent } from './auth-config'
import { isSettingsAuthorityCurrent, type SettingsAuthorityReceipt } from './settings-authority-history'
import type { MainPersistenceSessionBoundary, SpeechAuthConfig, SpeechAuthLeaseController } from './auth-speech-lease'

export function retireAuthStatusPersistenceObservation(
  controller: SpeechAuthLeaseController,
  config: SpeechAuthConfig | null,
  enforced: boolean,
  sticky: boolean
): void {
  controller.retireMainPersistenceIfStatusDisagrees(config, enforced, sticky)
}

export function isPersistenceSettingsReceiptCurrent(receipt: object): boolean {
  return isSettingsAuthorityCurrent(receipt as SettingsAuthorityReceipt)
}

export { isAuthEnvironmentSnapshotCurrent }

export function captureExplicitMainPersistenceSessionBoundary(
  controller: SpeechAuthLeaseController,
  status: AuthStatus,
  config: SpeechAuthConfig | null,
  sticky: boolean
): MainPersistenceSessionBoundary {
  return controller.captureMainPersistenceSessionBoundary({
    config,
    enforced: status.enforced === true,
    sticky
  })
}

export function capturePublishedMainPersistenceSessionBoundary(
  controller: SpeechAuthLeaseController
): MainPersistenceSessionBoundary | null {
  return controller.capturePublishedMainPersistenceSessionBoundary()
}
