import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import appPackage from '../../../../../package.json'
import type { NavigationGuardService } from '../../lib/navigation-guard'
import { TapControlCard } from '../../components/TapCalibration'
import { Check, ExternalLink, Mic, Volume2, Headphones, ChevronDown, ChevronUp, Sparkles, FolderOpen, FolderCog, AlertCircle, Trash2, Cpu, Wand2, ShieldCheck, Info, IdCard, X, Search, RefreshCw, Link2, CircleCheck, FileText, Upload, RotateCcw, Trash, Network, Calendar, Bell, User, MoreHorizontal, Plus, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, MessageSquare, MessageSquareQuote, Lightbulb, AlignLeft, FileSearch, Camera, Eye, Settings2, Lock, Timer, ListTree, Route, type LucideIcon } from 'lucide-react'
import { timeSavedFromTotals } from '@shared/time-saved'
import { TimeSavedView } from '../../components/TimeSavedView'
import { autoHideOverlayForLayout } from '@shared/overlay-chrome'
import { overlayShowsBarRestPicker } from '@shared/overlay-orb'
import type { OverlayPlacement } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'
import { OverlayChromePicker } from '../../components/OverlayChromePicker'
import { OverlayPlacementPicker } from '../../components/OverlayPlacementPicker'
import { OverlayOrbPicker } from '../../components/OverlayOrbPicker'
import { persistOverlayPlacement } from '../../lib/overlay-placement-save'
import { formatResetPhrase } from '@shared/reset-time'
import { DEFAULT_SHORTCUTS, HOTKEY_ACTIONS, BUILTIN_MODE_LABELS, MODE_GROUPS, modeLabel, type PublicSettings, type AsrAssetsStatus, type Profile, type TestKeyResponse, type ProfileRecoveryResult, type DustAgent, DUST_BASE_AGENT_ID, type ConversationMode, type BuiltinMode, type CustomMode, type AuthStatus, type GraphStatus, type HotkeyAction, type EvalMetrics, type MeetingSummary, type ShortcutFailure, type LocalModelSummary, type PlatformPermissions, type UpdateCheckResult, type McpConnectionKind, type LicenseStatusResult, type ScreenCaptureCheckResult, type PreservedBrainIndexCopy } from '@shared/ipc'
import { nextScreenCheckPass } from '@shared/screen-capture-check'
import { bundleFailureUserMessage, isRepairRequiredBundleMessage, isRetryableBundleMessage } from '@shared/bundle-response'
import { PROVIDERS, PROVIDER_IDS, requiresUserBaseUrl, detectProvider, parseDustUrl, resolveModelTier, applyInteractiveGuardrail, isDustReady, dustStoredAgentMissing, type ProviderId } from '@shared/providers'
import { DEFAULT_MODE_PROMPTS } from '@shared/prompts'
import { modeSkillLock } from '@shared/mode-skills'
import { DEFAULT_OPERATOR_URL, operatorUrlConfigured } from '@shared/operator'
import { LANGUAGE_OPTIONS } from '@shared/lang-id'
import { isCloudOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { effectiveCloudSttProvider, type CloudSttProviderId } from '@shared/cloud-stt-provider'
import { MantuLogo } from '../../components/MantuLogo'
import { MantuMark } from '../../components/MantuMark'
import { ClickUpMark } from '../../components/brand/ClickUpMark'
import { PlaneMark } from '../../components/brand/PlaneMark'
import { MetisMark } from '../../components/MetisMark'
import { IdentitySection } from '../../components/IdentitySection'
import { FieldHint, TextButton } from '../../components/ui'
import { shouldUseBundledAsr } from '../../lib/asr-offline'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { AgendaView } from '../../components/AgendaView'
import { usePermissions } from '../../state'
import { displayAccelerator, isWindows } from '../../lib/keys'
import { decideDustLiveCheck } from '../../lib/dust-live-check'
import { haltAllOnboardingAudio, unlockOnboardingAudio } from '../../lib/onboarding-music'
import { canShowConnected, cliSetupChip, nextCliSetupStep } from '@shared/cli-setup-status'
import { DUST_EMPTY_AGENTS_ERROR, DUST_WORKSPACE_MISSING_SETUP_ERROR, decideDustInstantValidate, formatDustConnectedMessage, proveDustConnection, type DustInstantValidateResult } from '@shared/dust-validate'
import { SETTINGS_CONTENT_SCROLL_CLASS, Section, TabIconContext, ToggleRow, ctl, managedChipCls, settingsScrollClipsOverflowX } from '../../ui/settings'
import { CLI_PROVIDERS, DUST_CREDENTIAL_STORE, PROFILE_CREDENTIAL_STORE, LICENSE_UI_ENABLED, LazyInput, LazyTextarea, VocabCorrectionsTextarea, ManagedChip, ProviderTile, ExpandableSection, VocabSuggestions, detectHint, isProfileUnlockError, SonioxKeySeat, pickReadyProvider, recommendedProvider, prettyModel, type SettingsWithAsrWebgpuFallback } from './SettingsSupport'
import { primaryBtnStyle } from './Integrations'
export const RETENTION_OPTIONS: { days: number; label: string }[] = [
  { days: 0, label: 'Keep forever (default)' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' }
]

function formatPreservedIndexSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}

/** GDPR/CCPA-facing controls: auto-retention window + a real "delete everything" action. Meeting
 *  recordings capture OTHER people's speech, not just the operator's — this is the one place in
 *  Settings that lets that be bounded or fully erased on demand, not just left to manual per-file cleanup. */
export function DangerZoneSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; deleted: number; error?: string } | null>(null)
  const [preservedBusy, setPreservedBusy] = useState<string | null>(null)
  const [preservedMsg, setPreservedMsg] = useState<string | null>(null)
  const [preservedCopies, setPreservedCopies] = useState<PreservedBrainIndexCopy[]>([])

  const refreshPreservedCopies = useCallback(async (): Promise<void> => {
    const r = await window.toto.preservedBrainIndexesList()
    setPreservedCopies(r.copies)
  }, [])

  useEffect(() => {
    void refreshPreservedCopies()
  }, [refreshPreservedCopies])

  const deleteAll = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    const r = await window.toto.recallDeleteAll()
    setResult(r)
    setBusy(false)
  }

  const restorePreserved = async (id: string): Promise<void> => {
    setPreservedBusy(id)
    setPreservedMsg(null)
    const r = await window.toto.preservedBrainIndexRestore(id)
    setPreservedMsg(r.ok ? 'Restored the preserved brain index.' : r.error === 'cancelled' ? 'Cancelled. Nothing was changed.' : r.error || 'Could not restore that preserved copy.')
    await refreshPreservedCopies()
    setPreservedBusy(null)
  }

  const deletePreserved = async (id: string): Promise<void> => {
    setPreservedBusy(id)
    setPreservedMsg(null)
    const r = await window.toto.preservedBrainIndexDelete(id)
    setPreservedMsg(r.ok ? 'Deleted the preserved brain index copy.' : r.error === 'cancelled' ? 'Cancelled. Nothing was deleted.' : r.error || 'Could not delete that preserved copy.')
    await refreshPreservedCopies()
    setPreservedBusy(null)
  }

  return (
    <Section
      title="Danger zone"
      desc="Meeting recordings capture other people's speech too, not just yours, so these controls bound or fully erase what's stored on this device."
      icon={AlertCircle}
    >
      <label className="mb-1 block text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
        Auto-delete meetings older than
      </label>
      <select
        value={settings.transcriptRetentionDays}
        onChange={(e) => patch({ transcriptRetentionDays: Number(e.target.value) })}
        disabled={settings.managedKeys.includes('transcriptRetentionDays')}
        aria-label="Auto-delete meetings older than"
        className={'w-full ' + ctl}
      >
        {RETENTION_OPTIONS.map((o) => (
          <option key={o.days} value={o.days}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/5 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Delete all my data</div>
          <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Permanently removes every saved meeting, note, and the knowledge graph from this device. Cannot be undone.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void deleteAll()}
          disabled={busy}
          className="no-drag cl-focus flex shrink-0 items-center gap-1.5 rounded-[10px] border border-[var(--cl-destructive)]/40 bg-[var(--cl-destructive)]/15 px-3 py-2 text-[12px] font-medium text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/25 disabled:opacity-50"
        >
          <Trash2 size={13} /> {busy ? 'Deleting…' : 'Delete everything'}
        </button>
      </div>
      {preservedCopies.length > 0 && (
        <div className="mt-4 space-y-2">
          <div>
            <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Preserved brain indexes</div>
            <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              Copies kept after rebuilds or restores. Settings shows only date, size, and whether this install can unlock them.
            </div>
          </div>
          {preservedCopies.map((copy) => (
            <div
              key={copy.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--cl-input)] bg-white/[0.03] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium text-[color:var(--cl-foreground)]">
                  {new Date(copy.createdAt).toLocaleString()}
                </div>
                <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                  {formatPreservedIndexSize(copy.size)} · {copy.restorable ? 'Can restore on this install' : 'Locked on this install'}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {copy.restorable && (
                  <button
                    type="button"
                    onClick={() => void restorePreserved(copy.id)}
                    disabled={preservedBusy !== null}
                    className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-50"
                  >
                    <RotateCcw size={13} /> Restore
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void deletePreserved(copy.id)}
                  disabled={preservedBusy !== null}
                  className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-destructive)]/40 bg-[var(--cl-destructive)]/10 px-3 py-2 text-[12px] text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/20 disabled:opacity-50"
                >
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </div>
          ))}
          {preservedMsg && <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">{preservedMsg}</div>}
        </div>
      )}
      {result && (
        <div
          className={[
            'mt-2 text-[11px]',
            result.ok || result.error === 'cancelled'
              ? 'text-[color:var(--cl-muted-foreground)]'
              : 'text-[color:var(--cl-destructive)]'
          ].join(' ')}
        >
          {result.error === 'cancelled'
            ? 'Cancelled. Nothing was deleted.'
            : result.ok
              ? `Deleted ${result.deleted} meeting${result.deleted === 1 ? '' : 's'}.`
              : result.error
                ? result.error
                : `Deleted ${result.deleted}, but some files could not be removed.`}
        </div>
      )}
    </Section>
  )
}


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

export function PermissionDot({ status }: { status: string }): JSX.Element {
  const color =
    status === 'granted'
      ? 'bg-[var(--cl-success)]'
      : status === 'denied'
        ? 'bg-[var(--cl-destructive)]'
        : 'bg-white/30'
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden="true" />
}

/**
 * True exactly on the rising edge: screen recording just flipped to 'granted' after this component had
 * already observed it as something else. `prev === null` means "first observation since mount" and must
 * never count. On this exact edge, macOS's TCC grant exists but this already-running process's
 * ScreenCaptureKit session never saw it: it needs a relaunch, not another trip to System Settings.
 */
export function screenRecordingJustGranted(
  prev: PlatformPermissions['screenRecording'] | null,
  current: PlatformPermissions['screenRecording'],
  isWin: boolean
): boolean {
  return !isWin && prev !== null && prev !== 'granted' && current === 'granted'
}

export function PermissionsSection(): JSX.Element {
  const { permissions } = usePermissions()
  const isWin = window.navigator.platform.toLowerCase().includes('win')
  // A grant that flips to 'granted' WHILE this panel is open (not one already granted when it first
  // mounted) means this running process's ScreenCaptureKit session never saw it: macOS only applies a
  // fresh Screen Recording grant to the next launch. usePermissions already live-polls (state.ts,
  // PERMISSIONS_POLL_MS) so this only has to watch for the rising edge and offer the one-click fix
  // instead of the old dead end (a status dot that just quietly turns green with no capture that works).
  const prevScreenStatus = useRef<PlatformPermissions['screenRecording'] | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [lastCheckPass, setLastCheckPass] = useState<ScreenCaptureCheckResult['pass'] | null>(null)
  const [checkBusy, setCheckBusy] = useState(false)
  const [checkResult, setCheckResult] = useState<ScreenCaptureCheckResult | null>(null)

  useEffect(() => {
    if (!permissions) return
    if (screenRecordingJustGranted(prevScreenStatus.current, permissions.screenRecording, isWin)) {
      setNeedsRestart(true)
    }
    prevScreenStatus.current = permissions.screenRecording
  }, [permissions, isWin])

  const restart = (): void => {
    setRestarting(true)
    void window.toto.relaunch().catch(() => setRestarting(false))
  }

  const runScreenCheck = (): void => {
    if (checkBusy) return
    const pass = nextScreenCheckPass(lastCheckPass)
    setCheckBusy(true)
    void window.toto
      .screenCaptureCheck(pass)
      .then((result) => {
        setLastCheckPass(result.pass)
        setCheckResult(result)
      })
      .catch((err) => {
        setLastCheckPass(pass)
        setCheckResult({
          ok: false,
          pass,
          message: err instanceof Error ? err.message : 'Screen capture check failed.'
        })
      })
      .finally(() => setCheckBusy(false))
  }

  if (!permissions) {
    return <div className="text-[13px] text-[color:var(--cl-muted-foreground)]">Checking permissions…</div>
  }

  const rows: { label: string; status: string; note: string; kind: 'microphone' | 'screenRecording'; fixLabel?: string }[] = [
    {
      label: 'Microphone',
      status: permissions.microphone,
      kind: 'microphone',
      note: isWin
        ? 'Windows asks the first time you start Listen.'
        : 'Needed to hear your calls. Grant in System Settings → Privacy & Security → Microphone.',
      fixLabel: isWin ? 'Check Windows Settings' : undefined
    },
    {
      label: 'Screen / system audio',
      status: permissions.screenRecording,
      kind: 'screenRecording',
      note: isWin
        ? 'Windows may ask once before capturing system audio.'
        : "Needed so Métis can answer questions about your screen and capture system audio. Grant in System Settings → Privacy & Security → Screen Recording.",
      fixLabel: isWin ? 'Check Windows Settings' : undefined
    }
  ]

  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => {
        // Mirrors Onboarding's CheckRow: an explicit Deny (macOS) always gets a fix link; on Windows,
        // which never reports a true Deny, fixLabel unlocks the link instead so there's still a way back
        // to Settings for a not-yet-granted mic or a screen-capture prompt the user dismissed.
        const denied = r.status === 'denied'
        // macOS 'not-determined'/'unknown' used to render NO control at all — a user who skipped
        // onboarding had no in-app path to trigger the mic prompt or register Métis with TCC (Screen
        // Recording's pane doesn't even list an app until it has probed once). Requesting is safe:
        // askForMediaAccess never re-prompts after an explicit Deny, and the screen probe is a 1×1
        // registration capture.
        const notYetAsked = !isWin && (r.status === 'not-determined' || r.status === 'unknown')
        const showFix = denied || notYetAsked || (isWin && r.fixLabel)
        const showRestart = r.kind === 'screenRecording' && needsRestart
        return (
          <div key={r.label} className="cl-card flex items-start gap-2 px-2.5 py-2">
            <PermissionDot status={r.status} />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">{r.label}</span>
                <span className="text-[11px] capitalize text-[color:var(--cl-muted-foreground)]">
                  {r.status.replace(/-/g, ' ')}
                </span>
              </div>
              <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{r.note}</div>
              {showRestart ? (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[11px] leading-snug text-[color:var(--cl-primary)]">
                    Granted. Restart Métis to finish enabling it.
                  </span>
                  <button
                    type="button"
                    onClick={restart}
                    disabled={restarting}
                    className="no-drag cl-focus rounded-full bg-[var(--cl-primary)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--cl-primary)] hover:bg-[var(--cl-primary)]/25 disabled:opacity-60"
                  >
                    {restarting ? 'Restarting…' : 'Restart Métis'}
                  </button>
                </div>
              ) : (
                showFix && (
                  <button
                    type="button"
                    onClick={() =>
                      void (notYetAsked
                        ? window.toto.requestPermissionsUpfront().catch(() => null)
                        : window.toto.openPermissionSettings(r.kind))
                    }
                    className="no-drag cl-focus mt-0.5 text-[11px] font-medium text-[color:var(--cl-primary)] hover:underline"
                  >
                    {notYetAsked
                      ? 'Request permission'
                      : (r.fixLabel ?? (isWindows ? 'Open Windows Settings' : 'Open System Settings'))}
                  </button>
                )
              )}
            </div>
          </div>
        )
      })}
      <div className="cl-card flex flex-col gap-1.5 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Screen capture check</span>
          <button
            type="button"
            onClick={runScreenCheck}
            disabled={checkBusy}
            className="no-drag cl-focus rounded-full bg-[var(--cl-primary)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--cl-primary)] hover:bg-[var(--cl-primary)]/25 disabled:opacity-60"
          >
            {checkBusy
              ? lastCheckPass == null
                ? 'Checking…'
                : 'Asking the model…'
              : lastCheckPass == null
                ? 'Check screen capture'
                : 'Check again with AI'}
          </button>
        </div>
        <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          First check is the OS permission probe. Check again to send a frame to Local AI if it is ready,
          otherwise the active API (including Dust when that is the provider). The result stays here. It
          is never sent to a teammate.
        </div>
        {checkResult && (
          <div
            className={[
              'flex items-start gap-1.5 text-[12px]',
              checkResult.ok
                ? 'text-[color:var(--cl-success)]'
                : 'text-[color:var(--cl-destructive)]'
            ].join(' ')}
          >
            {checkResult.ok ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
            <span>
              {checkResult.message}
              {checkResult.ok && checkResult.preview ? ` ${checkResult.preview}` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
