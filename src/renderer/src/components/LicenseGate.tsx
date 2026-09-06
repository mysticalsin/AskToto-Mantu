import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Check, RefreshCw } from 'lucide-react'
import { InlineOrb } from './AgentStatus'
import { MantuLogo } from './MantuLogo'
import type { PublicSettings } from '@shared/ipc'

// Styling duplicated from Settings.tsx's LicenseSection on purpose, not imported: Settings is a
// lazy-loaded chunk (see App.tsx), and this gate has to render before that chunk would even be
// fetched. The classNames themselves are tiny and copying them keeps this file's one screen fully
// self-contained rather than reaching into an unrelated lazy module for three lines of styling.
const ctl =
  'no-drag font-body cl-input cl-focus px-3 py-2.5 text-[13px] text-[color:var(--cl-foreground)]'
const primaryBtnStyle =
  'no-drag cl-focus flex items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50'
const secondaryBtnStyle =
  'no-drag cl-focus flex items-center gap-1.5 rounded-[8px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-50'

/** Plain-language copy for every code the license server (or this client) can return. Duplicated from
 *  Settings.tsx's licenseErrorMessage on purpose (same reasoning as the styling above) — this map is
 *  a handful of lines and the two screens are allowed to word things slightly differently over time
 *  without one refactor coupling them together. */
function licenseErrorMessage(code: string | undefined): string {
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
    default:
      return code || 'Could not activate this license.'
  }
}

/**
 * Full-surface blocking screen rendered instead of the app when main's license:gate verdict says this
 * device isn't allowed to run. In App.tsx this renders ahead of the SSO and onboarding gates — license
 * outranks both, so a revoked or unlicensed device learns that before it ever burns an SSO round trip.
 *
 * Never a dead end: Activate and Retry are always both available, regardless of `reason`. A successful
 * activation, or a Retry that finds the device newly allowed (e.g. a background heartbeat caught up),
 * calls `onRecheck` — the parent re-fetches the verdict and this screen disappears on its own once
 * `allowed` flips to true.
 */
export function LicenseGate({
  settings,
  reason,
  onRecheck
}: {
  settings: PublicSettings
  reason?: 'not_activated' | 'expired_grace' | 'trial_expired'
  onRecheck: () => Promise<void>
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState(settings.licenseServerUrl || '')
  const [licenseKey, setLicenseKey] = useState('')
  const [activating, setActivating] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const serverId = useId()
  const keyId = useId()
  // Guards state writes after unmount — both activate and retry are real network round trips (retry's
  // own heartbeat happens in main, but onRecheck still awaits an IPC round trip either way).
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

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
      setLicenseKey('')
      // A successful activation always leaves this device allowed — let the parent re-check and drop
      // this screen rather than assuming so locally (the parent owns the single source of truth).
      await onRecheck()
    } else {
      setError(licenseErrorMessage(r.error))
    }
  }

  const retry = async (): Promise<void> => {
    setRetrying(true)
    setError(null)
    await onRecheck()
    if (mountedRef.current) setRetrying(false)
  }

  return (
    <div className="fade-up flex min-h-[300px] w-full flex-col items-center justify-center gap-6 px-4 py-8 text-center">
      <MantuLogo size={140} />

      <div className="flex flex-col gap-2">
        <div className="font-ui text-[20px] font-semibold tracking-tight text-[color:var(--color-ink)]">
          This copy of Métis needs an active license
        </div>
        {reason === 'expired_grace' ? (
          <p className="mx-auto max-w-[420px] text-[13px] leading-relaxed text-[color:var(--color-ink-2)]">
            This device has been offline too long for its license check. Reconnect to the internet and
            retry.
          </p>
        ) : reason === 'trial_expired' ? (
          <p className="mx-auto max-w-[420px] text-[13px] leading-relaxed text-[color:var(--color-ink-2)]">
            Your trial has ended. Enter your license server and key to keep going — no key yet? Ask
            whoever set up Métis for one.
          </p>
        ) : (
          <p className="mx-auto max-w-[420px] text-[13px] leading-relaxed text-[color:var(--color-ink-2)]">
            Enter your license server and key to activate this device.
          </p>
        )}
      </div>

      <div className="flex w-full max-w-[360px] flex-col gap-2 text-left">
        <label htmlFor={serverId} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
            License server URL
          </span>
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
          <span className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
            License key
          </span>
          <input
            id={keyId}
            type="password"
            value={licenseKey}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste the license key you were given"
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

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void activate()}
          disabled={!serverUrl.trim() || !licenseKey.trim() || activating}
          className={primaryBtnStyle}
        >
          {activating ? <InlineOrb kind="connecting" /> : <Check size={12} />}
          Activate
        </button>
        <button type="button" onClick={() => void retry()} disabled={retrying} className={secondaryBtnStyle}>
          {retrying ? <InlineOrb kind="loading" /> : <RefreshCw size={12} />}
          Retry
        </button>
      </div>
    </div>
  )
}
