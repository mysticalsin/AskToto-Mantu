import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import type { Settings } from '@shared/ipc'
import { DEFAULT_OVERLAY_LAYOUT, parseOverlayLayout, type OverlayLayout } from '@shared/overlay-chrome'
import { parseOverlayPlacement, type OverlayPlacement } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'
import { auditLog, mainLog } from './logger'
import { KeychainKeyRecoveryError, isMacKeychainUnlockAuthorized } from './secrets'

interface BootWorkGate {
  releaseAfterFirstShow(window: BrowserWindow | null): void
}

export interface MacProfileBootCoordinator {
  isUnlockRequired(): boolean
  isUnlockError(error: unknown): boolean
  defer(name: string, run: () => void): void
  deferUnlockError(name: string, error: unknown, run: () => void): boolean
  deferIfLocked(name: string, run: () => void, beforeDefer: () => void): boolean
  resumeDeferred(): void
  requestBootWorkRelease(window: BrowserWindow | null): void
  completeInitialization(): void
  unlockSucceeded(): void
}

export function withProfileReadFallback<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export function safeOverlayLayout(readSettings: () => Settings): OverlayLayout {
  return withProfileReadFallback(
    () =>
      resolveOverlayPresentation({
        placement: safeOverlayPlacement(readSettings),
        layout: parseOverlayLayout(readSettings().overlayLayout)
      }).layout,
    DEFAULT_OVERLAY_LAYOUT
  )
}

export function safeOverlayPlacement(readSettings: () => Settings): OverlayPlacement {
  return withProfileReadFallback(() => parseOverlayPlacement(readSettings().overlayPlacement), 'top-center')
}

export function applyOperatorBootstrapSettings(
  getSettings: () => { operatorUrl?: string | null; operatorIngestSecret?: string | null },
  setSettings: (patch: { operatorUrl?: string; operatorIngestSecret?: string }) => unknown,
  env: { METIS_OPERATOR_URL?: string; METIS_OPERATOR_INGEST_SECRET?: string }
): void {
  const settings = getSettings()
  if (!settings.operatorUrl && env.METIS_OPERATOR_URL && /^https:\/\//i.test(env.METIS_OPERATOR_URL)) {
    setSettings({ operatorUrl: env.METIS_OPERATOR_URL.trim() })
  }
  if (!settings.operatorIngestSecret && env.METIS_OPERATOR_INGEST_SECRET) {
    setSettings({ operatorIngestSecret: env.METIS_OPERATOR_INGEST_SECRET })
  }
}

export function createMacProfileBootCoordinator(getBootWork: () => BootWorkGate | null): MacProfileBootCoordinator {
  const deferred = new Map<string, () => void>()
  let initializationComplete = false
  let releaseRequested = false
  let released = false
  let releaseWindow: BrowserWindow | null = null

  const isUnlockRequired = (): boolean => app.isPackaged && process.platform === 'darwin' && !isMacKeychainUnlockAuthorized()
  const releaseIfReady = (): void => {
    if (!releaseRequested || released || isUnlockRequired()) return
    released = true
    getBootWork()?.releaseAfterFirstShow(releaseWindow)
  }
  const resumeDeferred = (): void => {
    if (!initializationComplete || isUnlockRequired()) return
    const steps = [...deferred.entries()]
    deferred.clear()
    for (const [name, run] of steps) {
      try {
        run()
      } catch (error) {
        mainLog.error(`[boot] deferred ${name} failed:`, error)
        auditLog('app.error.boot_step', { step: name, message: error, recoveryStatus: 'continued' })
      }
    }
  }

  return {
    isUnlockRequired,
    isUnlockError: (error) => isUnlockRequired() && error instanceof KeychainKeyRecoveryError,
    defer(name, run) {
      deferred.set(name, run)
      mainLog.info(`[boot] ${name} deferred until the encrypted profile is unlocked`)
    },
    deferUnlockError(name, error, run) {
      if (!(isUnlockRequired() && error instanceof KeychainKeyRecoveryError)) return false
      deferred.set(name, run)
      mainLog.info(`[boot] ${name} deferred until the encrypted profile is unlocked`)
      auditLog('app.error.boot_step', { step: name, message: error, recoveryStatus: 'retry_pending' })
      return true
    },
    deferIfLocked(name, run, beforeDefer) {
      if (!isUnlockRequired()) return false
      beforeDefer()
      deferred.set(name, run)
      mainLog.info(`[boot] ${name} deferred until the encrypted profile is unlocked`)
      return true
    },
    resumeDeferred,
    requestBootWorkRelease(window) {
      releaseWindow = window
      releaseRequested = true
      releaseIfReady()
    },
    completeInitialization() {
      initializationComplete = true
      releaseIfReady()
      resumeDeferred()
    },
    unlockSucceeded() {
      releaseIfReady()
      resumeDeferred()
    }
  }
}
