import { useCallback, useEffect, useState } from 'react'
import type { LicenseGateVerdict } from '@shared/ipc'
import { useAuth, useSettings } from '../../state'
import { isOnboardingBoot } from '../../lib/onboarding-boot'

type UseAppBootOptions = {
  demo: string | null
  savedPath: string | null
}

export function useAppBoot({ demo, savedPath }: UseAppBootOptions): {
  settings: ReturnType<typeof useSettings>['settings']
  settingsBootError: string | null
  patch: ReturnType<typeof useSettings>['patch']
  saveKey: ReturnType<typeof useSettings>['saveKey']
  recoverEncryptedProfile: ReturnType<typeof useSettings>['recoverEncryptedProfile']
  clearKey: ReturnType<typeof useSettings>['clearKey']
  testKey: ReturnType<typeof useSettings>['testKey']
  refresh: ReturnType<typeof useSettings>['refresh']
  auth: ReturnType<typeof useAuth>
  bootError: string | null
  bootSlow: boolean
  licenseEnforced: boolean
  licenseGate: LicenseGateVerdict | null
  licenseGatePending: boolean
  recheckLicenseGate: () => Promise<void>
  entityNames: string[]
} {
  const { settings, bootError: settingsBootError, patch, saveKey, recoverEncryptedProfile, clearKey, testKey, refresh } = useSettings()
  const auth = useAuth()
  const bootError = settingsBootError ?? auth.bootError
  const [bootSlow, setBootSlow] = useState(false)

  // ── License enforcement master switch ──────────────────────────────────────────────────────────
  // OFF for now: every copy is treated as valid and the activation gate never renders, regardless of
  // the stored `licenseGateEnabled` setting — including a machine-wide managed-config that sets (and
  // locks) licenseGateEnabled:true, which is completely inert while this is off. All the licensing code
  // (main/license.ts, the LicenseGate component, the settings toggle, the heartbeat) is intact.
  // Flipping this constant ALONE ships a brick: Settings.tsx's LICENSE_UI_ENABLED gates the only
  // activation form in the app, and main's 12h heartbeat is gated on `licenseValid`, which nothing but a
  // successful activation can set. Both switches move together, in one change, or not at all.
  const LICENSE_ENFORCEMENT = false
  const licenseEnforced = LICENSE_ENFORCEMENT && settings?.licenseGateEnabled === true
  const [licenseGate, setLicenseGate] = useState<LicenseGateVerdict | null>(null)

  useEffect(() => {
    if (!licenseEnforced) {
      setLicenseGate(null)
      return
    }
    let cancelled = false
    const failOpen: LicenseGateVerdict = { gateEnabled: true, allowed: true }
    const timer = window.setTimeout(() => {
      if (!cancelled) setLicenseGate(failOpen)
    }, 5000)
    void window.toto.licenseGate().then(
      (v) => {
        if (!cancelled) setLicenseGate(v)
      },
      () => {
        if (!cancelled) setLicenseGate(failOpen)
      }
    ).finally(() => {
      window.clearTimeout(timer)
    })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [licenseEnforced])

  const recheckLicenseGate = useCallback(async () => {
    const [verdict] = await Promise.all([window.toto.licenseGate(), refresh()])
    setLicenseGate(verdict)
  }, [refresh])

  useEffect(() => {
    const pendingLicense = licenseEnforced && licenseGate == null
    const onStrip = demo == null && !isOnboardingBoot(settings) && (auth.status == null || pendingLicense) && !bootError
    if (!onStrip) {
      setBootSlow(false)
      return
    }
    const t = window.setTimeout(() => setBootSlow(true), 5000)
    return () => window.clearTimeout(t)
  }, [settings, auth.status, licenseEnforced, licenseGate, bootError, demo])

  const [entityNames, setEntityNames] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void window.toto
      .brainEntityNames()
      .then((r) => {
        if (alive) setEntityNames(r.names)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [savedPath])

  return {
    settings,
    settingsBootError,
    patch,
    saveKey,
    recoverEncryptedProfile,
    clearKey,
    testKey,
    refresh,
    auth,
    bootError,
    bootSlow,
    licenseEnforced,
    licenseGate,
    licenseGatePending: licenseEnforced && licenseGate == null,
    recheckLicenseGate,
    entityNames
  }
}
