import { useEffect, useRef, useState } from 'react'
import { Bell, Calendar, CircleCheck, ExternalLink, ShieldCheck } from 'lucide-react'
import type { AuthStatus, PublicSettings } from '@shared/ipc'
import { AgendaView } from '../../components/AgendaView'
import { InlineOrb } from '../../components/AgentStatus'
import { ManagedChip } from '../../ui/ManagedChip'
import { Section } from '../../ui/Section'
import { ToggleRow } from '../../ui/Toggle'
import { ctl } from '../../ui/ctl'

// ---------------------------------------------------------------------------
// Calendar tab
// ---------------------------------------------------------------------------

// Last Outlook auth status fetched this session — reused on remount so revisiting the Calendar tab
// shows the prior connection state instantly instead of flashing a loading spinner again.
let lastOutlookAuthStatus: AuthStatus | null = null

/**
 * Calendar tab: Microsoft / Outlook (Entra SSO) calendar connection plus the meeting notification toggle.
 */
export function CalendarTab({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(lastOutlookAuthStatus)
  const [outlookBusy, setOutlookBusy] = useState(false)
  const [outlookErr, setOutlookErr] = useState<string | null>(null)
  const [showOutlookSetup, setShowOutlookSetup] = useState(false)
  const [savingOutlook, setSavingOutlook] = useState(false)
  const [clientId, setClientId] = useState(settings.azureClientId || '')
  const [tenantId, setTenantId] = useState(settings.azureTenantId || '')
  const [domain, setDomain] = useState(settings.azureAllowedDomain || '')
  // Guards state writes after unmount — signInOutlook awaits an unbounded OS-level OAuth flow, and the
  // user can switch to another Settings tab (unmounting this tab) before it resolves.
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refreshOutlook = (): void => {
    void window.toto.authStatus()
      .then((v) => {
        if (!mountedRef.current) return
        setAuthStatus(v)
        lastOutlookAuthStatus = v
      })
      .catch(() => {
        if (mountedRef.current) setAuthStatus(null)
      })
  }
  useEffect(refreshOutlook, [])

  // Locked when an org admin manages any of the three Entra IDs — mirrors the disabled+ManagedChip
  // pattern used elsewhere (e.g. temperature/overlayOpacity) so this flow can't falsely claim success
  // while setSettings silently drops the locked keys.
  //
  // `managedKeys` only reflects the flat top-level managed-config `locked` array (see main/store.ts
  // getLockedKeys) — it does NOT cover main/auth.ts's separate nested `{ azure: {...} }` managed-config
  // block, which readConfig() there resolves with HIGHER precedence than these in-app Settings fields.
  // When SSO is configured that way, "Change IDs" below would stay editable and saveOutlookIds would
  // close the form claiming success while readConfig() silently keeps using the managed values. There is
  // no renderer-visible signal that distinguishes "configured via the nested azure block" from
  // "configured via this same form" (authStatus only exposes configured/signedIn/enforced), so — once any
  // SSO config has resolved at all (authStatus.configured) — this form locks rather than risk the
  // false-success case. Trade-off: a genuinely self-serve (non-managed) org also loses the ability to
  // edit its own IDs after the first save; a clearly-locked, honest form beats one that sometimes
  // silently no-ops. The unconfigured first-time setup path is unaffected (configured is false until a
  // config resolves), so self-serve first setup still works exactly as before.
  const azureLocked =
    settings.managedKeys.includes('azureClientId') ||
    settings.managedKeys.includes('azureTenantId') ||
    settings.managedKeys.includes('azureAllowedDomain') ||
    !!authStatus?.configured

  const saveOutlookIds = async (): Promise<void> => {
    if (azureLocked) {
      setOutlookErr('Microsoft sign-in IDs are managed by your organization and cannot be changed here.')
      return
    }
    const ci = clientId.trim()
    const ti = tenantId.trim()
    const dom = domain.trim().replace(/^@/, '')
    if (!ci || !ti || !dom) { setOutlookErr('All three fields are required.'); return }
    setSavingOutlook(true)
    setOutlookErr(null)
    await patch({ azureClientId: ci, azureTenantId: ti, azureAllowedDomain: dom })
    refreshOutlook()
    setSavingOutlook(false)
    setShowOutlookSetup(false)
  }

  const signInOutlook = async (): Promise<void> => {
    setOutlookBusy(true)
    setOutlookErr(null)
    const r = await window.toto.signIn()
    if (!mountedRef.current) return
    setOutlookBusy(false)
    if (!r.ok) setOutlookErr(r.error || 'Sign-in failed.')
    refreshOutlook()
  }

  const signOutOutlook = async (): Promise<void> => {
    await window.toto.signOut()
    if (!mountedRef.current) return
    refreshOutlook()
  }

  const connectedPill = (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--cl-primary)]">
      <CircleCheck size={12} /> Connected
    </span>
  )

  const idField = (
    label: string,
    val: string,
    set: (v: string) => void,
    placeholder: string,
    managedKey: string
  ): JSX.Element => {
    // OR in azureLocked (not just this field's own managedKeys entry) so a config resolved via the
    // nested managed `azure` block — invisible to managedKeys — still disables the input, not just the
    // Save button below.
    const fieldLocked = settings.managedKeys.includes(managedKey) || azureLocked
    return (
      <label className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
          {label}
          <ManagedChip keys={settings.managedKeys} k={managedKey} />
        </span>
        <input
          value={val}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          disabled={fieldLocked}
          onChange={(e) => set(e.target.value)}
          className={`${ctl} w-full ${fieldLocked ? 'opacity-60' : ''}`}
        />
      </label>
    )
  }

  const isOutlookConnected = !!authStatus?.signedIn

  return (
    <div className="flex flex-col gap-6">

      {/* Notifications — merged from former Notifications tab */}
      <Section title="Notifications" icon={Bell}>
        <ToggleRow
          label="Meeting alerts"
          desc="Notify 1 minute before a scheduled meeting starts."
          on={settings.meetingNotifications ?? false}
          onChange={(v) => patch({ meetingNotifications: v })}
          icon={Bell}
        />
      </Section>

      {/* Microsoft / Outlook */}
      <Section title="Microsoft / Outlook" desc="Connect your work Microsoft account to see Outlook calendar events." icon={Calendar}>
        <div className="flex flex-col gap-2">
          {authStatus === null && (
            <InlineOrb kind="connecting" />
          )}

          {isOutlookConnected && (
            <div className="cl-card flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="flex items-center gap-2">
                {connectedPill}
                <span className="text-[12px] text-[color:var(--cl-foreground)]">{authStatus?.email}</span>
              </div>
              <button
                type="button"
                onClick={() => void signOutOutlook()}
                className="no-drag cl-focus rounded-[8px] border border-[var(--cl-input)] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.06]"
              >
                Sign out
              </button>
            </div>
          )}

          {!isOutlookConnected && authStatus?.configured && !showOutlookSetup && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                disabled={outlookBusy}
                onClick={() => void signInOutlook()}
                className="no-drag cl-focus flex items-center justify-center gap-2 rounded-[8px] bg-[var(--cl-primary)] px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {outlookBusy ? <InlineOrb kind="connecting" /> : null}
                Connect Microsoft account
              </button>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                  Restricted to @{authStatus.domain}.
                </span>
                <button
                  type="button"
                  onClick={() => setShowOutlookSetup(true)}
                  className="no-drag cl-focus text-[11px] text-[color:var(--cl-muted-foreground)] underline underline-offset-2 hover:text-[color:var(--cl-foreground)]"
                >
                  Change IDs
                </button>
              </div>
            </div>
          )}

          {/* Paste-in setup — shown when not configured, or when user clicks "Change IDs" */}
          {authStatus !== null && (!authStatus.configured || showOutlookSetup) && (
            <div className="flex flex-col gap-2.5 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.02] p-3">
              <div className="flex items-start gap-2">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[color:var(--cl-primary)]" />
                <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                  Register an app in{' '}
                  <a
                    href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[color:var(--cl-primary)] underline underline-offset-2"
                  >
                    Microsoft Entra <ExternalLink size={10} />
                  </a>{' '}
                  (platform: Mobile &amp; desktop, redirect: <code className="rounded bg-white/[0.06] px-1">http://localhost</code>).
                  These are public IDs. No secret needed.
                </p>
              </div>
              {azureLocked && (
                <p className="flex items-center gap-1.5 text-[11px] leading-snug text-[color:var(--color-accent-text)]">
                  <ShieldCheck size={11} className="shrink-0" />
                  Microsoft sign-in is already configured for this app. These IDs are locked here. Contact your admin to change them.
                </p>
              )}
              {idField('Application (client) ID', clientId, setClientId, '00000000-0000-0000-0000-000000000000', 'azureClientId')}
              {idField('Directory (tenant) ID', tenantId, setTenantId, '00000000-0000-0000-0000-000000000000', 'azureTenantId')}
              {idField('Allowed email domain', domain, setDomain, 'mantu.com', 'azureAllowedDomain')}
              {outlookErr && (
                <span className="text-[11px] text-[color:var(--cl-destructive)]">{outlookErr}</span>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void saveOutlookIds()}
                  disabled={savingOutlook || azureLocked}
                  className="no-drag cl-focus flex items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {savingOutlook ? <InlineOrb kind="loading" /> : null}
                  Save IDs
                </button>
                {showOutlookSetup && (
                  <button
                    type="button"
                    onClick={() => { setShowOutlookSetup(false); setOutlookErr(null) }}
                    className="no-drag cl-focus rounded-[8px] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Sign-in error — only when the setup form is closed (form shows its own error inline) */}
          {outlookErr && authStatus?.configured && !showOutlookSetup && (
            <span className="text-[11px] text-[color:var(--cl-destructive)]">{outlookErr}</span>
          )}
        </div>
      </Section>

      {/* Agenda preview — shown once the Outlook calendar is connected */}
      {isOutlookConnected && (
        <Section title="Today's agenda" desc="Preview from your Outlook calendar." icon={Calendar}>
          <AgendaView />
        </Section>
      )}
    </div>
  )
}
