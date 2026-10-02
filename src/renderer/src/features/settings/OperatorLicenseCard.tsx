import { useEffect, useState } from 'react'
import { Check, AlertCircle, CircleCheck, X } from 'lucide-react'
import { IdentitySection } from '../../components/IdentitySection'
import { InlineOrb } from '../../components/AgentStatus'
import { ctl } from '../../ui/ctl'
import { activePillStyle, OPERATOR_ENTITLEMENT_LABELS, primaryBtnStyle } from './ProductConnections'

/**
 * Operator seat license (METIS-OP-1) activation, PLAN.md P2.2b #1. Paste-once: the field clears after a
 * successful activate — the desktop keeps the token, but there's nothing more to type or re-paste.
 * Polls IPC.operatorStatus (local settings + in-memory state only, no network) rather than reading off
 * `settings` directly, since tier/entitlements/integrations live outside the normal settings push here.
 */
export function OperatorLicenseCard({ refreshSettings, showIdentity = false }: {
  refreshSettings: () => Promise<void>
  showIdentity?: boolean
}): JSX.Element {
  const [status, setStatus] = useState<{
    configured: boolean
    fundedProviders?: string[]
    tier: 'metis' | 'metis-light' | null
    entitlements: Record<string, boolean> | null
    licenseLast4: string
    licenseExpiresAt: number | null
  } | null>(null)
  const [input, setInput] = useState('')
  const [state, setState] = useState<{ phase: 'idle' | 'saving' | 'error'; error: string | null }>({
    phase: 'idle',
    error: null
  })

  const refresh = (): void => {
    void window.toto.operatorStatus().then(setStatus).catch(() => {
      setState({ phase: 'error', error: 'Could not read your licence status. Try again.' })
    })
  }
  useEffect(() => {
    refresh()
    // Activation confirms immediately. Poll to pick up later renewals or administrator changes.
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [])

  const activate = async (clear = false): Promise<void> => {
    setState({ phase: 'saving', error: null })
    try {
      const r = await window.toto.operatorLicenseActivate({ licenseKey: clear ? '' : input.trim() })
      if (r.ok) {
        setInput('')
        await refreshSettings()
        setState({ phase: 'idle', error: null })
        refresh()
      } else {
        setState({ phase: 'error', error: r.error || 'Could not activate this license.' })
      }
    } catch {
      setState({ phase: 'error', error: 'Could not check your licence. Please try again.' })
    }
  }

  const hasLicense = !!status?.licenseLast4
  const waitingForOperator = hasLicense && !status?.tier

  return (
    <>
    {showIdentity && <IdentitySection managedTier={status?.tier ?? null} />}
    <div className="mt-2 flex flex-col gap-2 rounded-[10px] border border-[var(--cl-border)] bg-white/[0.02] p-3">
      <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Métis licence</span>
      <p className="text-[12px] text-[color:var(--cl-muted-foreground)]">
        Activate the licence your administrator provided. Métis verifies this device and connects managed AI automatically; no personal API key is needed.
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          aria-label="Métis licence key"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setState({ phase: 'idle', error: null })
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder="METIS-OP-1...."
          className={`${ctl} w-full`}
        />
        <button
          type="button"
          onClick={() => void activate()}
          disabled={!input.trim() || state.phase === 'saving'}
          className={primaryBtnStyle}
        >
          {state.phase === 'saving' ? <InlineOrb kind="loading" /> : <Check size={12} />}
          {state.phase === 'saving' ? 'Verifying…' : 'Activate'}
        </button>
      </div>
      {state.phase === 'error' && state.error && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span>{state.error}</span>
        </div>
      )}
      {hasLicense && (
        <div className="flex flex-col gap-1.5 border-t border-[var(--cl-border)] pt-2">
          <div className="flex items-center gap-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
            <span>
              Ending {status?.licenseLast4}
              {status?.licenseExpiresAt ? `, expires ${new Date(status.licenseExpiresAt).toLocaleDateString()}` : ''}
            </span>
            <button
              type="button"
              onClick={() => void activate(true)}
              disabled={state.phase === 'saving'}
              className="no-drag cl-focus text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-destructive)]"
            >
              Clear
            </button>
          </div>
          {waitingForOperator ? (
            <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-muted-foreground)]">
              <InlineOrb kind="connecting" /> Waiting for Operator to confirm this seat…
            </div>
          ) : (
            <>
              <span className={`w-fit ${activePillStyle}`}>
                <CircleCheck size={12} /> {status?.tier === 'metis-light' ? 'Métis Light' : 'Métis'}
              </span>
              <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                {status?.fundedProviders?.length
                  ? 'Licence active. Managed AI is ready.'
                  : 'Licence active. Your administrator needs to enable a managed AI provider, or you can connect your own provider in AI settings.'}
              </span>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {Object.entries(OPERATOR_ENTITLEMENT_LABELS).map(([key, label]) => {
                  const on = status?.entitlements?.[key] === true
                  return (
                    <span
                      key={key}
                      className={`flex items-center gap-1 text-[11px] ${on ? 'text-[color:var(--cl-foreground)]' : 'text-[color:var(--cl-muted-foreground)]'}`}
                    >
                      {on ? <CircleCheck size={12} className="text-[color:var(--cl-success)]" /> : <X size={12} />}
                      {label}
                    </span>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
    </>
  )
}
