import { useEffect, useId, useRef, useState } from 'react'
import { Check, AlertCircle, CircleCheck, Timer } from 'lucide-react'
import type { LicenseStatusResult, PublicSettings } from '@shared/ipc'
import { InlineOrb } from '../../components/AgentStatus'
import { ToggleRow } from '../../ui/Toggle'
import { ctl } from '../../ui/ctl'
import { primaryBtnStyle } from './ProductConnections'

// ---------------------------------------------------------------------------
// License — phone-home activation against a self-hosted license server (Settings → Profile).
// Nothing here enforces the result: checkLicenseGrace() (main/license.ts) exists but no startup gate
// calls it yet, so leaving licenseGateEnabled off is completely safe with no server deployed at all.
// ---------------------------------------------------------------------------

/** Plain-language copy for every code the license server (or this client) can return. Falls back to the
 *  raw string for anything unexpected — a validation message, "sign in first" — so nothing is silently
 *  swallowed. */
export function licenseErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'invalid':
      return 'That license key was not recognized.'
    case 'revoked':
      return 'This license has been revoked.'
    case 'expired':
      return 'This license has expired.'
    case 'seat_limit_reached':
      return 'All seats on this license are in use.'
    case 'network':
      return 'Could not reach the license server. Check the server URL and your connection.'
    case 'insecure_url':
      return 'Use an HTTPS license server address. Only localhost can use HTTP for testing.'
    case 'device_identity_unavailable':
      return 'Métis cannot save its device setup. Close other Métis copies, check that its data folder is writable, and try again. If it persists, contact support to repair the data folder.'
    default:
      return code || 'Could not activate this license.'
  }
}

export function LicenseSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState(settings.licenseServerUrl || '')
  // Never pre-filled from the saved key, same as every other credential input in this file — the field
  // starts blank even though a key is already active.
  const [licenseKey, setLicenseKey] = useState('')
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const serverId = useId()
  const keyId = useId()
  // Act 5 (MQA-281/282): lease/trial status, fetched via license:status (live-verified — never a raw
  // settings echo, see licenseDisplayStatus in main/license.ts). null while the first read is pending.
  const [status, setStatus] = useState<LicenseStatusResult | null>(null)
  // Guards state writes after unmount — activation is a real network round trip and the user can switch
  // Settings tabs before it resolves.
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let live = true
    void window.toto.licenseStatus().then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
    // Re-read whenever the persisted license/lease fields this section can change actually change —
    // an activation flips licenseValid/licenseLease, so this section's status line stays live without
    // a poll loop.
  }, [settings.licenseValid, settings.licenseLease, settings.licenseGateEnabled])

  const activate = async (): Promise<void> => {
    const url = serverUrl.trim()
    const key = licenseKey.trim()
    if (!url || !key) return
    setActivating(true)
    setError(null)
    const r = await window.toto.licenseActivate({ serverUrl: url, licenseKey: key })
    if (!mountedRef.current) return
    setActivating(false)
    if (r.ok) {
      // The main process already persisted the license state via activateLicense() - and the
      // settingsSet handler deliberately strips renderer-supplied license-state fields (they're
      // server-authoritative). Patching just the URL round-trips the handler's returned settings,
      // which carry the freshly-persisted state, so the UI updates without a full refetch.
      await patch({ licenseServerUrl: url })
      setLicenseKey('')
      const s = await window.toto.licenseStatus()
      if (mountedRef.current) setStatus(s)
    } else {
      setError(licenseErrorMessage(r.error))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <label htmlFor={serverId} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">License server URL</span>
          <input
            id={serverId}
            value={serverUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://license.your-company.com"
            onChange={(e) => {
              setServerUrl(e.target.value)
              setError(null)
            }}
            className={`${ctl} w-full`}
          />
        </label>
        <label htmlFor={keyId} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">License key</span>
          <input
            id={keyId}
            type="password"
            value={licenseKey}
            spellCheck={false}
            autoComplete="off"
            placeholder={settings.licenseValid ? '••••••••••••' : 'Paste the license key you were given'}
            onChange={(e) => {
              setLicenseKey(e.target.value)
              setError(null)
            }}
            className={`${ctl} w-full`}
          />
        </label>
      </div>

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {!error && settings.licenseValid && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-success)]">
          <CircleCheck size={13} className="mt-px shrink-0" />
          <span>
            Active{settings.licenseCompanyName ? ` · ${settings.licenseCompanyName}` : ''}
            {settings.licenseSeatCap > 0
              ? ` · up to ${settings.licenseSeatCap} seat${settings.licenseSeatCap === 1 ? '' : 's'}`
              : ''}
          </span>
        </div>
      )}
      {/* Act 5 (MQA-281/282): the offline-lease / trial line. Deliberately independent of
          settings.licenseValid above — a device can be covered by a signed lease (checked in even
          without a live server round trip) or the local trial fallback while never having a
          server-verified `licenseValid: true` at all, so this reads license:status's own
          live-verified fields rather than reusing that flag. Silent (no line at all) whenever neither
          applies, e.g. licensing is off and this device never started a trial. */}
      {!error && status?.leaseExpiresAt != null && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-success)]">
          <CircleCheck size={13} className="mt-px shrink-0" />
          <span>Continue on your offline lease (expires {new Date(status.leaseExpiresAt).toLocaleDateString()}).</span>
        </div>
      )}
      {!error && status?.leaseExpiresAt == null && status?.trialActive && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-muted-foreground)]">
          <Timer size={13} className="mt-px shrink-0" />
          <span>
            Trial · {status.trialDaysRemaining} day{status.trialDaysRemaining === 1 ? '' : 's'} left. Paste a
            license key above anytime to activate.
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={() => void activate()}
        disabled={!serverUrl.trim() || !licenseKey.trim() || activating}
        className={primaryBtnStyle}
      >
        {activating ? <InlineOrb kind="connecting" /> : <Check size={12} />}
        Activate
      </button>

      <ToggleRow
        label="Require a license to run"
        desc="When on, Métis requires an active license to run. Leave off until you've deployed a license server and confirmed activation works: turning this on with no valid activation will lock this device out at next launch."
        on={settings.licenseGateEnabled}
        onChange={(v) => patch({ licenseGateEnabled: v })}
      />
    </div>
  )
}


