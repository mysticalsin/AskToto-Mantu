import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, CircleCheck, KeyRound } from 'lucide-react'
import type { PublicSettings } from '@shared/ipc'
import { InlineOrb } from './AgentStatus'

/** Plain-language copy for every code the license server (or this client) can return. */
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

/** License activation stays optional and never blocks onboarding completion. */
export function ActLicense({
  settings,
  onContinue
}: {
  settings?: PublicSettings
  onContinue: () => void
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState(settings?.licenseServerUrl || '')
  const [licenseKey, setLicenseKey] = useState('')
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activated, setActivated] = useState(false)
  const serverId = useId()
  const keyId = useId()
  const mountedRef = useRef(true)
  useEffect(
    () => () => {
      mountedRef.current = false
    },
    []
  )

  const activate = async (): Promise<void> => {
    const url = serverUrl.trim()
    const key = licenseKey.trim()
    if (!url || !key) return
    setActivating(true)
    setError(null)
    const result = await window.toto.licenseActivate({ serverUrl: url, licenseKey: key })
    if (!mountedRef.current) return
    setActivating(false)
    if (result.ok) {
      setLicenseKey('')
      setActivated(true)
    } else {
      setError(licenseErrorMessage(result.error))
    }
  }

  return (
    <div key="license" className="scene-enter flex flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-1.5">
        <p className="m-0 text-[11px] font-medium uppercase tracking-[0.14em] text-[color:var(--color-ink-3)]">
          One more thing
        </p>
        <h2 className="m-0 text-[22px] font-semibold text-[color:var(--color-ink)]">Activate your license</h2>
        <p className="m-0 max-w-[380px] text-[12.5px] leading-snug text-[color:var(--color-ink-2)]">
          Your organization runs its own license server. Paste the key you were given. No key yet? You can still
          continue on a trial and activate later from Settings.
        </p>
      </div>
      <div className="flex w-full max-w-[360px] flex-col gap-2 text-left">
        <label htmlFor={serverId} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[color:var(--color-ink-3)]">License server URL</span>
          <input
            id={serverId}
            value={serverUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://license.your-company.com"
            onChange={(event) => {
              setServerUrl(event.target.value)
              setError(null)
              setActivated(false)
            }}
            className="no-drag focus-ring rounded-[10px] border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[13px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
          />
        </label>
        <label htmlFor={keyId} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[color:var(--color-ink-3)]">License key</span>
          <input
            id={keyId}
            type="password"
            value={licenseKey}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste the key you were given"
            onChange={(event) => {
              setLicenseKey(event.target.value)
              setError(null)
              setActivated(false)
            }}
            className="no-drag focus-ring rounded-[10px] border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[13px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
          />
        </label>
      </div>
      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--color-destructive,#ff8080)]">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {!error && activated && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--color-accent-2)]">
          <CircleCheck size={13} className="mt-px shrink-0" />
          <span>Activated. You're all set.</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void activate()}
          disabled={!serverUrl.trim() || !licenseKey.trim() || activating}
          className="no-drag focus-ring flex items-center gap-1.5 rounded-full bg-[var(--color-accent)]/15 px-4 py-2 text-[12px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25 disabled:opacity-50"
        >
          {activating ? <InlineOrb kind="connecting" /> : <KeyRound size={13} />}
          Activate
        </button>
        <button type="button" onClick={onContinue} className="onboard-cta no-drag focus-ring">
          Continue
        </button>
      </div>
    </div>
  )
}
