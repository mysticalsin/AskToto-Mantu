import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode
} from 'react'
import appPackage from '../../../../package.json'
import type { NavigationGuardService } from '../lib/navigation-guard'
import { TapControlCard } from './TapCalibration'
import {
  Check,
  ExternalLink,
  Mic,
  Volume2,
  Headphones,
  ChevronDown,
  ChevronUp,
  Sparkles,
  FolderOpen,
  FolderCog,
  AlertCircle,
  Trash2,
  Cpu,
  Wand2,
  ShieldCheck,
  Info,
  IdCard,
  X,
  Search,
  RefreshCw,
  Link2,
  CircleCheck,
  FileText,
  Upload,
  RotateCcw,
  Trash,
  Network,
  Calendar,
  User,
  MoreHorizontal,
  Plus,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  MessageSquare,
  MessageSquareQuote,
  Lightbulb,
  AlignLeft,
  FileSearch,
  Camera,
  Eye,
  Settings2,
  Lock,
  Timer,
  ListTree,
  Route,
  type LucideIcon
} from 'lucide-react'
import { timeSavedFromTotals } from '@shared/time-saved'
import { TimeSavedView } from './TimeSavedView'
import { autoHideOverlayForLayout, overlayLayoutCopy } from '@shared/overlay-chrome'
import { overlayShowsBarRestPicker } from '@shared/overlay-orb'
import type { OverlayPlacement } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'
import { OverlayChromePicker } from './OverlayChromePicker'
import { OverlayPlacementPicker } from './OverlayPlacementPicker'
import { OverlayOrbPicker } from './OverlayOrbPicker'
import { persistOverlayPlacement } from '../lib/overlay-placement-save'
import { formatResetPhrase } from '@shared/reset-time'
import {
  DEFAULT_SHORTCUTS,
  HOTKEY_ACTIONS,
  BUILTIN_MODE_LABELS,
  MODE_GROUPS,
  modeLabel,
  type PublicSettings,
  type AsrAssetsStatus,
  type Profile,
  type TestKeyResponse,
  type ProfileRecoveryResult,
  type ConversationMode,
  type BuiltinMode,
  type CustomMode,
  type GraphStatus,
  type HotkeyAction,
  type MeetingSummary,
  type ShortcutFailure,
  type LocalModelSummary,
  type AppleEngineStatus,
  type UpdateCheckResult,
  type McpConnectionKind,
  type LicenseStatusResult
} from '@shared/ipc'
import { bundleFailureUserMessage, isRepairRequiredBundleMessage, isRetryableBundleMessage } from '@shared/bundle-response'
import {
  PROVIDERS,
  PROVIDER_IDS,
  requiresUserBaseUrl,
  detectProvider,
  resolveModelTier,
  applyInteractiveGuardrail,
  isDustReady,
  type ProviderId
} from '@shared/providers'
import { DEFAULT_MODE_PROMPTS } from '@shared/prompts'
import { modeSkillLock } from '@shared/mode-skills'
import { DEFAULT_OPERATOR_URL, operatorUrlConfigured } from '@shared/operator'
import { LANGUAGE_OPTIONS } from '@shared/lang-id'
import { isCloudOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { effectiveCloudSttProvider, type CloudSttProviderId } from '@shared/cloud-stt-provider'
import { MantuLogo } from './MantuLogo'
import { MantuMark } from './MantuMark'
import { ClickUpMark } from './brand/ClickUpMark'
import { PlaneMark } from './brand/PlaneMark'
import { MetisMark } from './MetisMark'
import { IdentitySection } from './IdentitySection'
import { FieldHint, TextButton } from './ui'
import { LazyInput, LazyTextarea } from '../ui/LazyText'
import { ctl } from '../ui/ctl'
import { ManagedChip, managedChipCls } from '../ui/ManagedChip'
import { ExpandableSection, Section, TabIconContext } from '../ui/Section'
import { ToggleRow } from '../ui/Toggle'
import { DustSetup } from '../features/settings/DustSetup'
import { CalendarTab } from '../features/settings/CalendarTab'
import { DangerZoneSection } from '../features/settings/DangerZoneSection'
import { DiagnosticsSection } from '../features/settings/DiagnosticsSection'
import { PermissionsSection, screenRecordingJustGranted } from '../features/settings/PermissionsSection'
import {
  AiSection,
  AsrModelRow,
  CoreAsrAssetsRow,
  WhisperQualityRow,
  AppleEngineNotice,
  LocalAiSection,
  asrImportModelDescription,
  coreAsrAssetsView,
  detectHint,
  readCoreAsrAssetsStatus,
  retryCoreAsrAssets
} from '../features/settings/AiSection'
import { PROFILE_CREDENTIAL_STORE, isProfileUnlockError } from '../features/settings/credential-store'
import { pickReadyProvider } from '../features/settings/provider-readiness'
import { shouldUseBundledAsr } from '../lib/asr-offline'
import { AgentStatus, InlineOrb } from './AgentStatus'
import { displayAccelerator, isWindows } from '../lib/keys'
import { haltAllOnboardingAudio, unlockOnboardingAudio } from '../lib/onboarding-music'
import { canShowConnected, cliSetupChip, nextCliSetupStep } from '@shared/cli-setup-status'

// Kept importable from here: its focused tests and callers predate the move to features/settings.
export { pickReadyProvider }
export { screenRecordingJustGranted }
export {
  AppleEngineNotice,
  CoreAsrAssetsRow,
  LocalAiSection,
  asrImportModelDescription,
  coreAsrAssetsView,
  detectHint,
  readCoreAsrAssetsStatus,
  retryCoreAsrAssets,
  WhisperQualityRow
}

declare const __METIS_FEEDBACK_EMAIL__: string

export const METIS_FEEDBACK_EMAIL =
  typeof __METIS_FEEDBACK_EMAIL__ === 'string' ? __METIS_FEEDBACK_EMAIL__.trim() : ''

/**
 * Settings tabpanel scroll classes. Vertical scroll only — overflow-x must stay hidden/clip.
 * overflow-y-auto alone computes overflow-x: auto (CSS overflow pairing), which is the Win
 * Settings sideways-pan bug on Audio / AI.
 */
export const SETTINGS_CONTENT_SCROLL_CLASS =
  'cl-content scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden'

const OVERFLOW_X_CLIP = new Set(['overflow-x-hidden', 'overflow-x-clip'])
const OVERFLOW_X_ALLOW = new Set(['overflow-x-auto', 'overflow-x-scroll', 'overflow-x-visible'])
const OVERFLOW_Y_SCROLL = new Set(['overflow-y-auto', 'overflow-y-scroll'])

/** True when a Settings scroll-root class allows Y scroll and clips X (no sideways bar/pan). */
export function settingsScrollClipsOverflowX(className: string): boolean {
  const tokens = className.trim().split(/\s+/)
  const allowsY = tokens.some((t) => OVERFLOW_Y_SCROLL.has(t))
  const clipsX = tokens.some((t) => OVERFLOW_X_CLIP.has(t))
  const allowsX = tokens.some((t) => OVERFLOW_X_ALLOW.has(t))
  return allowsY && clipsX && !allowsX
}


// Phase 1: license activation is OFF. The LicenseSection component + main-process license code stay in
// source (nothing enforces a license today — licenseGateEnabled defaults off), so this only hides the
// Profile section until we ship licensing. Flip to true to bring the UI back with zero other changes.
const LICENSE_UI_ENABLED: boolean = false

// asrWebgpuFallbackAt (WebGPU→WASM ASR downgrade marker) is a sibling addition to the settings schema
// not yet reflected in the shared PublicSettings type this file imports. Read/write it through this
// local extension — scoped to Settings.tsx only — so today's type still checks and the note below picks
// up the real field once @shared/ipc catches up, with no edit needed here.
type SettingsWithAsrWebgpuFallback = PublicSettings & { asrWebgpuFallbackAt?: number | null }




type AsrCorrection = PublicSettings['asrCorrections'][number]

/** One `heard => correct` line per correction, in order. Pure (and lossy by design — a blank line or a
 *  line with no "=>" or an empty "from" simply isn't a correction yet). Exported for a focused test. */
export function serializeAsrCorrections(items: AsrCorrection[]): string {
  return items.map((c) => `${c.from} => ${c.to}`).join('\n')
}

/** Inverse of serializeAsrCorrections. Pure. Exported for a focused test. */
export function parseAsrCorrections(raw: string): AsrCorrection[] {
  return raw
    .split('\n')
    .map((line) => {
      const i = line.indexOf('=>')
      if (i < 0) return null
      const from = line.slice(0, i).trim()
      const to = line.slice(i + 2).trim()
      return from ? { from, to } : null
    })
    .filter((c): c is AsrCorrection => c != null)
    .slice(0, 100)
}

/** Value-equality for two correction arrays (order-sensitive — that's how they render as lines). Pure.
 *  Exported for a focused test. */
export function sameAsrCorrections(a: AsrCorrection[], b: AsrCorrection[]): boolean {
  return a.length === b.length && a.every((c, i) => c.from === b[i].from && c.to === b[i].to)
}

/**
 * The vocabulary-corrections textarea is a controlled input over a DERIVED, LOSSY value: the array is
 * serialized to `heard => correct` lines and re-parsed on every change, and the parse silently drops a
 * blank line (e.g. one just started with Enter, before "=>" exists yet). A plain LazyTextarea isn't
 * enough here: once the debounced commit round-trips through patch() → new `corrections` prop, that new
 * prop is the RE-SERIALIZED (blank-line-stripped) array, which — compared naively — looks like a fresh
 * external edit and would resync `local`, wiping the very newline the user just typed.
 *
 * Fix: compare the incoming prop against the last array WE ourselves committed (by value, not by the
 * serialized string). Only an external change (profile switch, undo, another window) — one that doesn't
 * match what we just committed — is allowed to overwrite in-progress typing.
 */
function VocabCorrectionsTextarea({
  corrections,
  onCommit,
  disabled,
  placeholder,
  className
}: {
  corrections: AsrCorrection[]
  onCommit: (next: AsrCorrection[]) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}): JSX.Element {
  const [local, setLocal] = useState(() => serializeAsrCorrections(corrections))
  const lastCommitted = useRef(corrections)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!sameAsrCorrections(corrections, lastCommitted.current)) {
      lastCommitted.current = corrections
      setLocal(serializeAsrCorrections(corrections))
    }
  }, [corrections])

  const commit = (raw: string): void => {
    const parsed = parseAsrCorrections(raw)
    lastCommitted.current = parsed
    onCommit(parsed)
  }
  const onChange = (v: string): void => {
    setLocal(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => commit(v), 350)
  }
  const onBlur = (): void => {
    if (timer.current) clearTimeout(timer.current)
    commit(local)
  }

  return (
    <textarea
      value={local}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      rows={3}
      className={className}
    />
  )
}


/**
 * "Suggest names from your meetings" — one-click seeding of the vocabulary-corrections list from the
 * brain's known people/account names (brain:entityNames). Fetches lazily on first click (not on every
 * Settings open), then shows names not already covered by an existing correction (same `from`, folded to
 * lowercase) or already present byte-identical as a correction's `to`. Clicking a chip appends
 * `<lowercased name> => <Canonical Name>`, respecting the same 100-entry cap the textarea itself enforces.
 */
function VocabSuggestions({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [names, setNames] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const locked = settings.managedKeys.includes('asrCorrections')

  const load = useCallback((): void => {
    setLoading(true)
    void window.toto
      .brainEntityNames()
      .then((r) => setNames(r.names))
      .catch(() => setNames([]))
      .finally(() => setLoading(false))
  }, [])

  if (names === null) {
    return (
      <div className="mt-0.5">
        <TextButton onClick={load} disabled={loading || locked}>
          {loading ? 'Looking…' : 'Suggest names from your meetings'}
        </TextButton>
      </div>
    )
  }

  const covered = new Set(
    settings.asrCorrections.flatMap((c) => [c.from.trim().toLowerCase(), c.to.trim()])
  )
  const suggestions = names.filter((n) => !covered.has(n.toLowerCase()) && !covered.has(n))
  const atCap = settings.asrCorrections.length >= 100

  if (suggestions.length === 0) {
    return (
      <div className="mt-0.5 text-[11px] text-[color:var(--cl-muted-foreground)]">
        No new names to suggest from your meetings.
      </div>
    )
  }

  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {suggestions.slice(0, 20).map((name) => (
        <button
          key={name}
          type="button"
          disabled={locked || atCap}
          title={`Add "${name.toLowerCase()} => ${name}"`}
          onClick={() =>
            patch({ asrCorrections: [...settings.asrCorrections, { from: name.toLowerCase(), to: name }].slice(0, 100) })
          }
          className="no-drag focus-ring rounded-full border border-[var(--cl-border)] bg-white/[0.04] px-2 py-0.5 text-[11px] text-[color:var(--cl-foreground)] hover:bg-white/[0.09] disabled:opacity-40"
        >
          + {name}
        </button>
      ))}
    </div>
  )
}




/** Seat Soniox API key for cloud STT (optional; Nova is the default transcript source). */
function SonioxKeySeat({
  hasKey,
  envLocked,
  onSaved
}: {
  hasKey: boolean
  envLocked: boolean
  onSaved: () => void
}): JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    const trimmed = key.trim()
    if (!trimmed) {
      setMsg('Paste a Soniox API key first.')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await window.toto.cloudSttSetSonioxKey(trimmed)
      setKey('')
      setMsg('Soniox key saved on this device.')
      onSaved()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save Soniox key.')
    } finally {
      setBusy(false)
    }
  }
  const clear = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await window.toto.cloudSttClearSonioxKey()
      setMsg('Soniox key removed.')
      onSaved()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not remove Soniox key.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.02] p-2.5">
      <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
        Soniox runs only when selected here and a key is seated (or SONIOX_API_KEY is set). Nova stays
        the default transcript source.
        {envLocked ? ' SONIOX_API_KEY env is active for this seat.' : hasKey ? ' A Soniox key is seated.' : ' No Soniox key seated yet.'}
      </p>
      <input
        type="password"
        value={key}
        disabled={envLocked || busy}
        onChange={(e) => setKey(e.target.value)}
        placeholder={hasKey && !envLocked ? '•••••• saved (paste to replace)' : 'Soniox API key'}
        aria-label="Soniox API key"
        className={'w-full ' + ctl}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={envLocked || busy}
          onClick={() => void save()}
          className="no-drag cl-focus rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Save Soniox key
        </button>
        {hasKey && !envLocked && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void clear()}
            className="no-drag cl-focus rounded-[8px] border border-[var(--cl-input)] px-3 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.06] disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
      {msg && <p className="text-[11px] text-[color:var(--cl-muted-foreground)]">{msg}</p>}
    </div>
  )
}


// ---------------------------------------------------------------------------
// MCP push connections — Polo Pre-Sales CRM + Plane "Book next steps"
// (Settings → Mantu Intelligence). Generalized from the single BidStack-only
// card: `kind` doubles as the connection id (v1 constraint — one connection
// per kind, see McpConnectionSchema in shared/ipc.ts).
// ---------------------------------------------------------------------------

function McpConnectionCard({
  settings,
  patch,
  kind,
  defaultLabel,
  title,
  desc,
  endpointPlaceholder,
  apiKeyHint,
  extraFields
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  kind: McpConnectionKind
  defaultLabel: string
  title: string
  desc: string
  endpointPlaceholder: string
  apiKeyHint: string
  /** Extra transport-header inputs beyond the bearer key (e.g. Plane's X-Workspace-slug). Empty for a
   *  connection whose endpoint needs nothing beyond `Authorization: Bearer <key>` (BidStack). */
  extraFields?: { key: string; label: string; placeholder: string }[]
}): JSX.Element {
  const connectionId = kind
  const conn = settings.mcpConnections.find((c) => c.id === connectionId)
  const [open, setOpen] = useState(false)
  const [endpointUrl, setEndpointUrl] = useState(conn?.endpointUrl || '')
  const [apiKey, setApiKey] = useState('')
  const [extraValues, setExtraValues] = useState<Record<string, string>>(
    Object.fromEntries((extraFields ?? []).map((f) => [f.key, conn?.extraHeaders?.[f.key] || '']))
  )
  const [testState, setTestState] = useState<{
    phase: 'idle' | 'testing' | 'tested' | 'saving' | 'error'
    error: string | null
    tools: string[] | null
  }>({ phase: 'idle', error: null, tools: null })

  const connected = conn?.connected ?? false
  const endpointId = useId()
  const keyId = useId()

  const extraHeaders = (): Record<string, string> =>
    Object.fromEntries(Object.entries(extraValues).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]))

  const testConnection = async (): Promise<void> => {
    setTestState({ phase: 'testing', error: null, tools: null })
    const r = await window.toto.mcpTestConnection({
      connectionId,
      endpointUrl: endpointUrl.trim(),
      apiKey: apiKey.trim(),
      extraHeaders: extraHeaders()
    })
    if (r.ok) {
      setTestState({ phase: 'tested', error: null, tools: r.tools ?? [] })
    } else {
      setTestState({ phase: 'error', error: r.error || 'Could not connect.', tools: null })
    }
  }

  const saveConnection = async (): Promise<void> => {
    setTestState((s) => ({ ...s, phase: 'saving' }))
    const r = await window.toto.mcpSaveConnection({
      connectionId,
      endpointUrl: endpointUrl.trim(),
      apiKey: apiKey.trim(),
      extraHeaders: extraHeaders(),
      label: conn?.label || defaultLabel
    })
    if (r.ok) {
      await patch({
        mcpConnections: [
          ...settings.mcpConnections.filter((c) => c.id !== connectionId),
          {
            id: connectionId,
            kind,
            label: conn?.label || defaultLabel,
            endpointUrl: endpointUrl.trim(),
            connected: true,
            tools: r.tools ?? [],
            extraHeaders: extraHeaders()
          }
        ]
      })
      setApiKey('')
      setTestState({ phase: 'idle', error: null, tools: null })
      setOpen(false)
    } else {
      setTestState({ phase: 'error', error: r.error || 'Could not save the connection.', tools: null })
    }
  }

  const disconnect = async (): Promise<void> => {
    // MQA-091: main returns ok:false + an explanation when the on-disk key file survived the delete (a
    // locked/read-only key file). Discarding it told the user their credential was removed when it was not.
    const r = await window.toto.mcpDisconnect({ connectionId })
    await patch({
      mcpConnections: settings.mcpConnections.map((c) => (c.id === connectionId ? { ...c, connected: false, tools: [] } : c))
    })
    setEndpointUrl('')
    setApiKey('')
    if (!r.ok) {
      // Keep the panel open so the error strip below is on screen — the connection is off either way,
      // but the surviving key file needs a manual cleanup the user can only do if they're told.
      setTestState({ phase: 'error', error: r.error || 'Disconnected, but the stored key could not be removed.', tools: null })
      setOpen(true)
      return
    }
    setTestState({ phase: 'idle', error: null, tools: null })
    setOpen(false)
  }

  return (
    <div
      className={[
        'flex flex-col gap-2 rounded-[10px] border p-3',
        connected ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]/40' : 'border-[var(--cl-border)] bg-white/[0.02]'
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">{title}</span>
          <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{desc}</span>
        </div>
        {connected ? (
          <span className={activePillStyle}>
            <CircleCheck size={12} /> Connected
          </span>
        ) : null}
      </div>

      {connected && !open ? (
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--cl-muted-foreground)]" title={conn?.endpointUrl}>
            {conn?.endpointUrl}
          </span>
          <button
            type="button"
            onClick={() => {
              setEndpointUrl(conn?.endpointUrl || '')
              setExtraValues(Object.fromEntries((extraFields ?? []).map((f) => [f.key, conn?.extraHeaders?.[f.key] || ''])))
              setOpen(true)
            }}
            className="no-drag cl-focus shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
          >
            Reconnect
          </button>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="no-drag cl-focus shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-destructive)]"
          >
            Disconnect
          </button>
        </div>
      ) : !open ? (
        <button type="button" onClick={() => setOpen(true)} className={secondaryBtnStyle}>
          <Link2 size={12} />
          Set up
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={endpointId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              MCP endpoint URL
            </label>
            <input
              id={endpointId}
              value={endpointUrl}
              onChange={(e) => {
                setEndpointUrl(e.target.value)
                setTestState({ phase: 'idle', error: null, tools: null })
              }}
              placeholder={endpointPlaceholder}
              className={'w-full ' + ctl}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={keyId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              API key
            </label>
            <input
              id={keyId}
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setTestState({ phase: 'idle', error: null, tools: null })
              }}
              placeholder={apiKeyHint}
              className={'w-full ' + ctl}
            />
          </div>

          {(extraFields ?? []).map((f) => {
            const fieldId = `${keyId}-${f.key}`
            return (
              <div key={f.key} className="flex flex-col gap-1">
                <label htmlFor={fieldId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                  {f.label}
                </label>
                <input
                  id={fieldId}
                  value={extraValues[f.key] || ''}
                  onChange={(e) => {
                    setExtraValues((s) => ({ ...s, [f.key]: e.target.value }))
                    setTestState({ phase: 'idle', error: null, tools: null })
                  }}
                  placeholder={f.placeholder}
                  className={'w-full ' + ctl}
                />
              </div>
            )
          })}

          {testState.phase === 'error' && testState.error && (
            <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{testState.error}</span>
            </div>
          )}
          {testState.phase === 'tested' && testState.tools && (
            <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-success)]">
              <CircleCheck size={13} className="mt-px shrink-0" />
              <span>
                Connected.{' '}
                {testState.tools.length > 0
                  ? `Found ${testState.tools.length} tool${testState.tools.length === 1 ? '' : 's'}: ${testState.tools.join(', ')}`
                  : `${defaultLabel} reported no tools for this key’s scope.`}
              </span>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={!endpointUrl.trim() || !apiKey.trim() || testState.phase === 'testing' || testState.phase === 'saving'}
              className={secondaryBtnStyle}
            >
              {testState.phase === 'testing' ? <InlineOrb kind="connecting" /> : <RefreshCw size={12} />}
              Test connection
            </button>
            <button
              type="button"
              onClick={() => void saveConnection()}
              disabled={testState.phase !== 'tested'}
              title={testState.phase !== 'tested' ? 'Test the connection successfully first' : undefined}
              className={primaryBtnStyle}
            >
              {testState.phase === 'saving' ? <InlineOrb kind="loading" /> : <Check size={12} />}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setApiKey('')
                setTestState({ phase: 'idle', error: null, tools: null })
              }}
              className={secondaryBtnStyle}
            >
              Cancel
            </button>
          </div>
          <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Request only the <code className="rounded bg-white/[0.08] px-1">mcp + write</code> scope. This is a
            push-only integration. The endpoint depends on where your {defaultLabel} backend runs; there's no
            default beyond the placeholder shown above.
          </span>
        </div>
      )}
    </div>
  )
}

// Shared button styles for McpConnectionCard (module scope — CliIntegration's own primaryBtn/secondaryBtn
// are local to that component and not exported, so this is a small deliberate duplicate, not a shared import).
const primaryBtnStyle =
  'no-drag cl-focus flex items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50'
const secondaryBtnStyle =
  'no-drag cl-focus flex items-center gap-1.5 rounded-[8px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-50'
const activePillStyle =
  'flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-primary)]'

/**
 * Product-connect card (ClickUp, Plane) — docs/design/BRAIN-CONNECTORS.md.
 * Default: official logo, name, one line, Connect. No URL / key / slug / Test / Save.
 * Advanced (closed on every mount): paste a key. Main pins the MCP URL.
 * Connect / Test / Save / Disconnect fire only from an explicit click — never a useEffect.
 */
function ProductConnectCard({
  settings,
  patch,
  kind,
  title,
  desc,
  waitingLabel,
  mark,
  connect,
  pinnedEndpoint,
  apiKeyHint,
  extraFields,
  operatorManaged
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  kind: 'clickup' | 'plane'
  title: string
  desc: string
  waitingLabel: string
  mark: JSX.Element
  connect: () => Promise<{ ok: boolean; error?: string; tools?: string[]; clickupListId?: string; clickupListName?: string }>
  pinnedEndpoint: string
  apiKeyHint: string
  extraFields?: { key: string; label: string; placeholder: string }[]
  /** PLAN.md P2.2b #3: set when this seat has no local key for this connection but Operator supplies
   *  one (CRM push then uses it automatically). last4 of the Operator-delivered credential, never the
   *  credential itself. */
  operatorManaged?: { last4: string }
}): JSX.Element {
  const conn = settings.mcpConnections.find((c) => c.id === kind)
  const connected = conn?.connected ?? false
  const [state, setState] = useState<{
    phase: 'idle' | 'connecting' | 'testing' | 'tested' | 'saving' | 'error'
    error: string | null
    tools: string[] | null
  }>({ phase: 'idle', error: null, tools: null })
  const [advanced, setAdvanced] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [extraValues, setExtraValues] = useState<Record<string, string>>(
    Object.fromEntries((extraFields ?? []).map((f) => [f.key, conn?.extraHeaders?.[f.key] || '']))
  )
  const keyId = useId()

  const extraHeaders = (): Record<string, string> =>
    Object.fromEntries(Object.entries(extraValues).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]))

  const runConnect = async (): Promise<void> => {
    setState({ phase: 'connecting', error: null, tools: null })
    const r = await connect()
    if (r.ok) {
      await patch({
        mcpConnections: [
          ...settings.mcpConnections.filter((c) => c.id !== kind),
          {
            id: kind,
            kind,
            label: title,
            endpointUrl: pinnedEndpoint,
            connected: true,
            tools: r.tools ?? [],
            extraHeaders: extraHeaders(),
            ...(kind === 'clickup' && (r.clickupListId || r.clickupListName)
              ? { clickupListId: r.clickupListId, clickupListName: r.clickupListName }
              : {})
          }
        ]
      })
      setState({ phase: 'idle', error: null, tools: null })
    } else {
      setState({ phase: 'error', error: r.error || `Could not connect ${title}.`, tools: null })
    }
  }

  const testKey = async (): Promise<void> => {
    setState({ phase: 'testing', error: null, tools: null })
    const r = await window.toto.mcpTestConnection({
      connectionId: kind,
      endpointUrl: pinnedEndpoint,
      apiKey: apiKey.trim(),
      extraHeaders: extraHeaders()
    })
    if (r.ok) {
      setState({ phase: 'tested', error: null, tools: r.tools ?? [] })
    } else {
      setState({ phase: 'error', error: r.error || 'Could not connect.', tools: null })
    }
  }

  const saveKey = async (): Promise<void> => {
    setState((s) => ({ ...s, phase: 'saving' }))
    const r = await window.toto.mcpSaveConnection({
      connectionId: kind,
      endpointUrl: pinnedEndpoint,
      apiKey: apiKey.trim(),
      extraHeaders: extraHeaders(),
      label: title
    })
    if (r.ok) {
      await patch({
        mcpConnections: [
          ...settings.mcpConnections.filter((c) => c.id !== kind),
          {
            id: kind,
            kind,
            label: title,
            endpointUrl: pinnedEndpoint,
            connected: true,
            tools: r.tools ?? [],
            extraHeaders: extraHeaders(),
            ...(kind === 'clickup' && (r.clickupListId || r.clickupListName)
              ? { clickupListId: r.clickupListId, clickupListName: r.clickupListName }
              : {})
          }
        ]
      })
      setApiKey('')
      setAdvanced(false)
      setState({ phase: 'idle', error: null, tools: null })
    } else {
      setState({ phase: 'error', error: r.error || 'Could not save the connection.', tools: null })
    }
  }

  const disconnect = async (): Promise<void> => {
    const r = await window.toto.mcpDisconnect({ connectionId: kind })
    await patch({
      mcpConnections: settings.mcpConnections.map((c) => (c.id === kind ? { ...c, connected: false, tools: [] } : c))
    })
    setApiKey('')
    if (!r.ok) {
      setState({ phase: 'error', error: r.error || 'Disconnected, but cleanup failed.', tools: null })
      return
    }
    setState({ phase: 'idle', error: null, tools: null })
  }

  const connecting = state.phase === 'connecting'

  return (
    <div
      data-connector={kind}
      className={[
        'flex flex-col gap-2 rounded-[10px] border p-3',
        connected ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]/40' : 'border-[var(--cl-border)] bg-white/[0.02]'
      ].join(' ')}
    >
      <div className="flex items-center gap-3">
        {connected ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-white/[0.06]">
            {mark}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void runConnect()}
            disabled={connecting}
            aria-label={`Connect ${title}`}
            className="no-drag cl-focus flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-50"
          >
            {mark}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-[color:var(--cl-foreground)]">{title}</div>
          <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{desc}</div>
        </div>
        {connected ? (
          <span className={activePillStyle}>
            <CircleCheck size={12} /> Connected
          </span>
        ) : operatorManaged ? (
          <span className={activePillStyle} title="Métis Operator supplies this connection's credential; no local key is set.">
            <CircleCheck size={12} /> Managed by Operator ({operatorManaged.last4})
          </span>
        ) : (
          <button type="button" onClick={() => void runConnect()} disabled={connecting} className={primaryBtnStyle}>
            {connecting ? <InlineOrb kind="connecting" /> : null}
            {connecting ? waitingLabel : 'Connect'}
          </button>
        )}
      </div>

      {connected ? (
        <div className="flex items-center gap-3 pl-10">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--cl-muted-foreground)]">
            {conn && conn.tools.length > 0
              ? kind === 'clickup' && conn.clickupListName
                ? `Tasks go to ${conn.clickupListName}`
                : `${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'} available`
              : 'Connected. No tools reported for this account.'}
          </span>
          <button
            type="button"
            onClick={() => void runConnect()}
            disabled={connecting}
            className="no-drag cl-focus shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
          >
            {connecting ? <InlineOrb kind="connecting" /> : 'Reconnect'}
          </button>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="no-drag cl-focus shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-destructive)]"
          >
            Disconnect
          </button>
        </div>
      ) : null}

      {state.phase === 'error' && state.error && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span>{state.error}</span>
        </div>
      )}
      {state.phase === 'tested' && state.tools && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-success)]">
          <CircleCheck size={13} className="mt-px shrink-0" />
          <span>
            Connected.{' '}
            {state.tools.length > 0
              ? `Found ${state.tools.length} tool${state.tools.length === 1 ? '' : 's'}: ${state.tools.join(', ')}`
              : `${title} reported no tools for this key’s scope.`}
          </span>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setAdvanced((o) => !o)}
          aria-expanded={advanced}
          className="no-drag cl-focus flex items-center gap-1 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
        >
          <ChevronDown size={12} className={advanced ? 'rotate-180' : ''} />
          Advanced
        </button>
        {advanced ? (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-[11px] text-[color:var(--cl-muted-foreground)]">Paste a key if you already have one.</p>
            <div className="flex flex-col gap-1">
              <label htmlFor={keyId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                API key
              </label>
              <input
                id={keyId}
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setState((s) => ({ ...s, phase: s.phase === 'tested' ? 'idle' : s.phase, error: null, tools: null }))
                }}
                placeholder={apiKeyHint}
                className={'w-full ' + ctl}
              />
            </div>
            {(extraFields ?? []).map((f) => {
              const fieldId = `${keyId}-${f.key}`
              return (
                <div key={f.key} className="flex flex-col gap-1">
                  <label htmlFor={fieldId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                    {f.label}
                  </label>
                  <input
                    id={fieldId}
                    value={extraValues[f.key] || ''}
                    onChange={(e) => {
                      setExtraValues((s) => ({ ...s, [f.key]: e.target.value }))
                      setState((s) => ({ ...s, phase: s.phase === 'tested' ? 'idle' : s.phase, error: null, tools: null }))
                    }}
                    placeholder={f.placeholder}
                    className={'w-full ' + ctl}
                  />
                </div>
              )
            })}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void testKey()}
                disabled={!apiKey.trim() || state.phase === 'testing' || state.phase === 'saving' || connecting}
                className={secondaryBtnStyle}
              >
                {state.phase === 'testing' ? <InlineOrb kind="connecting" /> : <RefreshCw size={12} />}
                Test connection
              </button>
              <button
                type="button"
                onClick={() => void saveKey()}
                disabled={state.phase !== 'tested'}
                title={state.phase !== 'tested' ? 'Test the connection successfully first' : undefined}
                className={primaryBtnStyle}
              >
                {state.phase === 'saving' ? <InlineOrb kind="loading" /> : <Check size={12} />}
                Save
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ClickupCard({ settings, patch }: { settings: PublicSettings; patch: (p: Partial<PublicSettings>) => void }): JSX.Element {
  return (
    <ProductConnectCard
      settings={settings}
      patch={patch}
      kind="clickup"
      title="ClickUp"
      desc="Tasks from a recap. Nothing sends itself."
      waitingLabel="Waiting for ClickUp…"
      mark={<ClickUpMark size={28} />}
      connect={() => window.toto.mcpClickupConnect()}
      pinnedEndpoint="https://mcp.clickup.com/mcp"
      apiKeyHint="ClickUp API token (power option, Connect is the usual path)"
    />
  )
}

function PlaneCard({ settings, patch }: { settings: PublicSettings; patch: (p: Partial<PublicSettings>) => void }): JSX.Element {
  // PLAN.md P2.2b #3: Plane is the one local CRM kind an Operator-supplied credential can stand in for
  // (see operatorCrmCredentialFor's doc comment on the desktop side for why clickup/bidstack are not).
  const [operatorPlane, setOperatorPlane] = useState<{ last4: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.toto.operatorStatus().then((status) => {
      if (cancelled) return
      const plane = status.integrations.find((i) => i.kind === 'plane' && i.hasCredential)
      setOperatorPlane(plane ? { last4: plane.last4 } : null)
    })
    return () => {
      cancelled = true
    }
  }, [settings.operatorIntegrationsVersion])

  return (
    <ProductConnectCard
      settings={settings}
      patch={patch}
      kind="plane"
      title="Plane"
      desc="Work items from a recap. Nothing sends itself."
      waitingLabel="Waiting for Plane…"
      mark={<PlaneMark size={28} />}
      connect={() => window.toto.mcpPlaneConnect()}
      pinnedEndpoint="https://mcp.plane.so/http/api-key/mcp"
      apiKeyHint="Personal or workspace access token"
      extraFields={[{ key: 'X-Workspace-slug', label: 'Workspace slug', placeholder: 'acme' }]}
      operatorManaged={operatorPlane ?? undefined}
    />
  )
}

const OPERATOR_ENTITLEMENT_LABELS: Record<string, string> = {
  ask: 'Ask',
  listen: 'Listen',
  recap: 'Recap',
  crm_push: 'CRM push',
  operator_keys: 'Operator-funded providers',
  intelligence: 'Intelligence indexing',
  integrations: 'Integrations'
}

/**
 * Operator seat license (METIS-OP-1) activation, PLAN.md P2.2b #1. Paste-once: the field clears after a
 * successful activate — the desktop keeps the token, but there's nothing more to type or re-paste.
 * Polls IPC.operatorStatus (local settings + in-memory state only, no network) rather than reading off
 * `settings` directly, since tier/entitlements/integrations live outside the normal settings push here.
 */
function OperatorLicenseCard({ refreshSettings, showIdentity = false }: {
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

function getAudioChoices(): {
  id: PublicSettings['audioSource']
  label: string
  desc: string
  perm: string
  icon: typeof Mic
}[] {
  const isWin = window.navigator.platform.toLowerCase().includes('win')
  return [
    {
      id: 'both',
      label: 'Both',
      desc: 'You + them',
      perm: isWin ? 'Needs Mic; captures your speaker output automatically (no prompt)' : 'Needs Mic + Screen Recording',
      icon: Headphones
    },
    {
      id: 'system',
      label: 'Them',
      desc: 'The other person',
      perm: isWin ? 'Captures your speaker output automatically (no prompt)' : 'Needs Screen Recording',
      icon: Volume2
    },
    { id: 'mic', label: 'You', desc: 'Your mic only', perm: 'Needs Mic', icon: Mic }
  ]
}

function AudioChoices({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-3 gap-2">
      {getAudioChoices().map((c) => {
        const active = c.id === settings.audioSource
        const locked = settings.managedKeys.includes('audioSource')
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={active}
            disabled={locked}
            onClick={() => patch({ audioSource: c.id })}
            className={[
              'no-drag cl-focus flex min-w-0 w-full flex-col items-center gap-1 rounded-[var(--cl-radius)] border px-2 py-3 text-center transition-colors',
              active
                ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]'
                : 'border-[var(--cl-border)] bg-white/[0.02] hover:bg-white/[0.05]',
              locked ? 'opacity-60 cursor-not-allowed' : ''
            ].join(' ')}
          >
            <c.icon size={16} className={active ? 'text-[color:var(--cl-primary)]' : 'text-[color:var(--cl-muted-foreground)]'} />
            <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">{c.label}</span>
            <span className="min-w-0 break-words text-[11px] text-[color:var(--cl-muted-foreground)]">{c.desc}</span>
            <span className="min-w-0 break-words text-[10px] text-[color:var(--cl-muted-foreground)]">{c.perm}</span>
          </button>
        )
      })}
    </div>
  )
}

// Full-scale RMS for the level meter below. Well above the VAD's own "is speaking" threshold
// (lib/vad.ts ON = 0.012) so normal close-mic speech visibly moves the bar without pegging it on
// every breath; this is a "do I have signal" indicator, not a calibrated VU meter.
const MIC_METER_FULL_SCALE = 0.2

/** Live input-level meter for MicPicker: opens its own getUserMedia + AnalyserNode against whichever
 *  device is selected (or the system default) so a user can confirm a mic — especially a newly paired
 *  Bluetooth/iPhone mic — is actually delivering signal before a meeting, without starting a real
 *  capture. Entirely separate from the app's real capture pipeline (lib/listen.ts); it never touches
 *  settings or recording state, only visualizes.
 *
 *  RMS math mirrors lib/vad.ts / whisper-worklet-src.ts (sum of squares over the buffer, then sqrt) so
 *  the bar reflects the same "how loud is this" signal the transcription pipeline itself computes.
 *
 *  Cleanup is the load-bearing part: a leaked getUserMedia stream keeps the mic hot and the OS
 *  recording indicator lit. teardown() stops every track, closes the AudioContext, and cancels the
 *  rAF loop; the effect calls it on every unmount AND every deviceId change (effect cleanup runs
 *  before the next effect body), so switching devices or leaving the Audio tab (this component
 *  unmounts with it — see the `tab === 'audio'` guard around MicPicker) always fully releases the mic. */
function MicLevelMeter({
  deviceId,
  permissionNonce
}: {
  deviceId: string
  /** Bumped by MicPicker's unlockLabels() after a fresh mic-permission grant. deviceId alone doesn't
   *  change when permission is granted in the same panel, so the meter would otherwise stay stuck on
   *  "No signal" until some unrelated device switch re-ran this effect. */
  permissionNonce?: number
}): JSX.Element {
  // null = not blocked. Otherwise the getUserMedia failure kind, so the hint below can name the actual
  // cause instead of always saying "allow microphone access" (wrong for a disconnected/OverconstrainedError device).
  const [blockedReason, setBlockedReason] = useState<'permission' | 'device' | 'other' | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let raf = 0

    const teardown = (): void => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      if (ctx && ctx.state !== 'closed') void ctx.close()
      ctx = null
    }

    void (async (): Promise<void> => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true
        })
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop()) // effect already torn down (unmount/device switch) mid-await
          return
        }
        stream = s
        const audioCtx = new AudioContext()
        ctx = audioCtx
        void audioCtx.resume() // some autoplay policies create it suspended; harmless no-op if already running
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        // A node graph that never reaches the destination is never pulled by the renderer, so the
        // analyser would silently stop updating — route it through a GAIN-0 node into destination to
        // keep it live without ever making the mic audible (no feedback through speakers).
        const mute = audioCtx.createGain()
        mute.gain.value = 0
        audioCtx.createMediaStreamSource(s).connect(analyser).connect(mute).connect(audioCtx.destination)
        const data = new Float32Array(analyser.fftSize)
        setBlockedReason(null)

        const tick = (): void => {
          analyser.getFloatTimeDomainData(data)
          let sumSquares = 0
          for (let i = 0; i < data.length; i++) {
            const v = data[i]
            sumSquares += v * v
          }
          const rms = Math.sqrt(sumSquares / data.length)
          const level = Math.min(1, rms / MIC_METER_FULL_SCALE)
          if (barRef.current) {
            barRef.current.style.width = `${level * 100}%`
            barRef.current.style.opacity = String(0.35 + level * 0.65)
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      } catch (e) {
        // Never throw, just show the hint below instead of the bar — but branch the copy on the actual
        // cause: permission denied vs. a device that vanished (OverconstrainedError from the
        // {deviceId:{exact}} constraint above, or NotFoundError) vs. anything else.
        if (cancelled) return
        const name = e instanceof Error ? e.name : ''
        if (name === 'NotAllowedError') setBlockedReason('permission')
        else if (name === 'OverconstrainedError' || name === 'NotFoundError') setBlockedReason('device')
        else setBlockedReason('other')
      }
    })()

    return () => {
      cancelled = true
      teardown()
    }
  }, [deviceId, permissionNonce])

  if (blockedReason) {
    const hint =
      blockedReason === 'permission'
        ? 'No signal. Allow microphone access to test this device.'
        : blockedReason === 'device'
          ? 'Device unavailable, choose another mic, or reconnect it and retry.'
          : 'No signal from this microphone.'
    return (
      <FieldHint text={hint}>
        <span className="flex h-2 w-16 shrink-0 items-center justify-center text-[color:var(--cl-muted-foreground)]">
          <AlertCircle size={12} />
        </span>
      </FieldHint>
    )
  }

  return (
    <div
      role="meter"
      aria-label="Microphone input level"
      className="h-2 w-16 shrink-0 overflow-hidden rounded-full bg-white/10"
    >
      <div
        ref={barRef}
        className="h-full w-0 rounded-full bg-[var(--cl-primary)] opacity-40 transition-[width,opacity] duration-75 ease-out"
      />
    </div>
  )
}

/** Microphone chooser: system default plus any input device (built-in, AirPods, iPhone, a headset).
 *  Device labels are blank until mic permission is granted once, so we offer a one-click reveal. The
 *  actual capture (lib/listen.ts) falls back to the default if the chosen device has disconnected. */
function MicPicker({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [needsPerm, setNeedsPerm] = useState(false)
  // Bumped whenever unlockLabels() lands a fresh permission grant — passed to MicLevelMeter so it
  // re-acquires the stream instead of staying stuck on "No signal" (deviceId alone doesn't change here).
  const [permNonce, setPermNonce] = useState(0)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
      setNeedsPerm(mics.length > 0 && mics.every((d) => !d.label)) // labels blank until permission granted
      setDevices(mics)
    } catch {
      setDevices([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])

  const unlockLabels = useCallback(async (): Promise<void> => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop()) // just needed the grant so labels populate
      await refresh()
      setPermNonce((n) => n + 1)
    } catch {
      /* denied — leave the generic names in place */
    }
  }, [refresh])

  const locked = settings.managedKeys.includes('micDeviceId')
  return (
    <div className="mt-3 flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[12px] text-[color:var(--cl-muted-foreground)]">Microphone</span>
        <select
          value={settings.micDeviceId}
          disabled={locked}
          onChange={(e) => patch({ micDeviceId: e.target.value })}
          aria-label="Microphone"
          className={'no-drag min-w-0 flex-1 ' + ctl + (locked ? ' opacity-60' : '')}
        >
          <option value="">System default</option>
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Microphone ${i + 1}`}
            </option>
          ))}
        </select>
        <MicLevelMeter deviceId={settings.micDeviceId} permissionNonce={permNonce} />
      </div>
      {needsPerm ? (
        <button
          type="button"
          onClick={() => void unlockLabels()}
          className="no-drag w-fit text-[11px] text-[color:var(--cl-primary)] hover:underline"
        >
          Show device names
        </button>
      ) : (
        <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          Choose a specific mic, or keep the system default. If a chosen device disconnects, Métis falls
          back to the default so a meeting never loses its mic.
        </span>
      )}
    </div>
  )
}


/** Settings → About → Diagnostics. Nothing in this app uploads anywhere (zero telemetry, crash upload
 *  off), so when support needs the log trail the user exports it themselves: main + audit logs, crash
 *  dumps and the boot sentinel into a folder they choose — never meetings, the brain, or settings. */
function SupportBundleSection(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; path?: string; files?: number; error?: string; cancelled?: boolean } | null>(null)
  const exportBundle = async (): Promise<void> => {
    setBusy(true)
    try {
      setResult(await window.toto.diagnosticsExport())
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Diagnostics" desc="Export the app's logs for support. Never includes meetings, notes, or the knowledge graph.">
      <div className="flex flex-col items-center gap-2">
        <TextButton onClick={() => void exportBundle()} disabled={busy}>
          {busy ? 'Exporting…' : 'Export diagnostics bundle'}
        </TextButton>
        {result?.ok && (
          <span className="text-[12px] text-[color:var(--cl-muted-foreground)]">
            Exported {result.files} file{result.files === 1 ? '' : 's'} to {result.path}
          </span>
        )}
        {result && !result.ok && !result.cancelled && (
          <span className="text-[12px] text-[var(--color-danger)]">{result.error}</span>
        )}
      </div>
    </Section>
  )
}

/** Settings → About → Updates. electron-updater's silent flow still auto-installs where the platform
 *  supports it (it then shows the UpdateReadyToast); this row exists so EVERY build — including
 *  unsigned macOS ones that cannot auto-install — can still DISCOVER that a newer version was
 *  published and reach the download page. Auto-checks once when the section mounts (i.e. when the
 *  user opens About), manual re-check any time. */
function UpdatesSection(): JSX.Element {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  // The in-app download lifecycle, driven by the electron-updater events (onUpdateProgress/onUpdateReady):
  // 'idle' → 'downloading' (percent) → 'ready' (Restart & install). 'blocked' means this build can't
  // self-install (portable / Store / policy / dev) — the download-page link is offered instead.
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'ready' | 'blocked'>('idle')
  const [percent, setPercent] = useState(0)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const check = useCallback((): void => {
    setChecking(true)
    void window.toto
      .checkForUpdate()
      .then(setResult)
      .catch((e) => setResult({ ok: false, current: '', error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setChecking(false))
  }, [])
  useEffect(() => {
    check()
  }, [check])

  // Stream download progress + the ready signal from electron-updater the whole time this section is open,
  // so a download already running in the background (auto-update) shows here too, not only when we started it.
  useEffect(() => {
    const offProgress = window.toto.onUpdateProgress((d) => {
      setPercent(Math.max(0, Math.min(100, Math.round(d?.percent ?? 0))))
      setPhase((p) => (p === 'ready' ? p : 'downloading'))
    })
    const offReady = window.toto.onUpdateReady(() => {
      setPercent(100)
      setPhase('ready')
    })
    // A download that was running just died (proxy, sleep, checksum, signature). 'blocked' is the state
    // that renders the download-page link, so the fallback below stops being unreachable mid-download.
    const offError = window.toto.onUpdateError((d) => {
      setPhase('blocked')
      setDownloadError(d?.message ?? 'The update download failed. Open the download page to install manually.')
    })
    return () => {
      offProgress()
      offReady()
      offError()
    }
  }, [])

  const startDownload = useCallback((): void => {
    setDownloadError(null)
    setPercent(0)
    setPhase('downloading')
    void window.toto
      .downloadUpdate()
      .then((r) => {
        if (!r.started) {
          setPhase('blocked')
          if (r.reason) setDownloadError(r.reason)
        }
      })
      .catch((e) => {
        setPhase('blocked')
        setDownloadError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  return (
    <Section title="Updates" desc="Métis installs a QA-approved Latest from Metis-Releases. Draft and prerelease builds are never offered." icon={RefreshCw}>
      <div className="flex flex-col items-center gap-2">
        {result?.current ? (
          <span className="text-[12px] text-[color:var(--cl-muted-foreground)]">Installed version: {result.current}</span>
        ) : null}

        {result?.ok && result.available && phase === 'idle' && (
          <button
            onClick={startDownload}
            className="no-drag focus-ring rounded-full bg-[color:var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--cl-primary-foreground)] transition-colors hover:opacity-90"
          >
            Download &amp; install version {result.latest}
          </button>
        )}

        {phase === 'downloading' && (
          <div className="flex w-full max-w-[220px] flex-col items-center gap-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--cl-border)]">
              <div
                className="h-full rounded-full bg-[color:var(--cl-primary)] transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">Downloading update… {percent}%</span>
          </div>
        )}

        {phase === 'ready' && (
          <button
            onClick={() => void window.toto.installUpdate()}
            className="no-drag focus-ring rounded-full bg-[color:var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--cl-primary-foreground)] transition-colors hover:opacity-90"
          >
            Restart &amp; install now
          </button>
        )}

        {/* Download-page fallback: a build that cannot self-install (portable / Store / managed / unsigned mac),
            or any download-start failure. Always reachable so the user is never stranded. */}
        {result?.ok && result.available && (phase === 'blocked' || phase === 'idle') && (
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-[color:var(--cl-muted-foreground)] underline transition-colors hover:text-[color:var(--cl-foreground)]"
          >
            {phase === 'blocked' ? 'Open the download page instead' : 'Or open the download page'}
          </a>
        )}
        {downloadError && <span className="text-[11px] text-[var(--color-danger)]">{downloadError}</span>}

        {result?.ok && !result.available && phase === 'idle' && (
          <span className="text-[12px] text-[color:var(--cl-muted-foreground)]">You&apos;re on the latest version.</span>
        )}
        {result && !result.ok && <span className="text-[12px] text-[var(--color-danger)]">{result.error}</span>}
        <TextButton onClick={check} disabled={checking}>
          {checking ? <AgentStatus kind="searching" size="inline" caption /> : 'Check for updates'}
        </TextButton>
      </div>
    </Section>
  )
}

/** Editable, pre-filled system prompt for the selected default mode. Plug-and-play with reset. */
function ModePromptEditor({
  settings,
  patch,
  mode,
  modeDisplayLabel
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  mode: ConversationMode
  modeDisplayLabel?: string
}): JSX.Element {
  const isBuiltin = mode in BUILTIN_MODE_LABELS
  const override = settings.modePrompts[mode]
  const defaultPrompt = isBuiltin ? DEFAULT_MODE_PROMPTS[mode as keyof typeof DEFAULT_MODE_PROMPTS] ?? '' : ''
  const value = override && override.trim() !== '' ? override : defaultPrompt
  const isModified = !!override && override.trim() !== '' && override !== defaultPrompt
  const locked = settings.managedKeys.includes('modePrompts')
  const reset = (): void => {
    const m = { ...settings.modePrompts }
    delete m[mode]
    patch({ modePrompts: m })
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-[color:var(--cl-muted-foreground)]">
        {modeDisplayLabel ? `${modeDisplayLabel} prompt` : 'Mode prompt'}
      </label>
      <LazyTextarea
        value={value}
        disabled={locked}
        placeholder={isBuiltin ? 'Customize this mode’s system prompt…' : 'Write a system prompt for this mode…'}
        onCommit={(v) => patch({ modePrompts: { ...settings.modePrompts, [mode]: v } })}
        className={[ctl, 'h-44 w-full resize-none text-[12px] leading-relaxed', locked ? 'opacity-60' : ''].join(' ')}
      />
      <div className="flex items-center gap-3">
        {isBuiltin && (
          isModified ? (
            <button
              type="button"
              onClick={reset}
              disabled={locked}
              className="no-drag cl-focus inline-flex items-center gap-1 text-[12px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
            >
              <RotateCcw size={12} /> Reset to default
            </button>
          ) : (
            <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">Using the built-in default.</span>
          )
        )}
        <ManagedChip keys={settings.managedKeys} k="modePrompts" />
      </div>
      {isBuiltin && (
        <p className="m-0 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          Operator skill v{modeSkillLock().skills[mode]?.version ?? 'unknown'} is locked to this Métis
          build. Your prompt above still applies. The skill runs in the background and cannot be
          edited, deleted, or overridden here. Ask answers also run locked caveman v
          {modeSkillLock().skills.caveman?.version ?? 'unknown'} (default full). Say stop caveman or
          normal mode to drop it. /caveman lite|full|ultra switches intensity. That skill cannot be
          edited here.
        </p>
      )}
    </div>
  )
}

const TEXT_FILE_RE = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|css|tsx?|jsx?|py|rb|go|rs|java|sql|sh)$/i

/** Cluely-style "add files for context" — reads text on-device and folds it into every answer. */
function ContextDocs({
  settings,
  patch,
  mode,
  modeDisplayLabel
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  mode: ConversationMode
  modeDisplayLabel?: string
}): JSX.Element {
  const docs = settings.contextDocs[mode] || []
  const [drag, setDrag] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const inputId = useId()
  const writeDocs = (next: { name: string; text: string }[]): void =>
    patch({ contextDocs: { ...settings.contextDocs, [mode]: next } })

  const ingest = async (files: FileList | File[]): Promise<void> => {
    const added: { name: string; text: string }[] = []
    const skipped: string[] = []
    for (const f of Array.from(files)) {
      const isText = f.type.startsWith('text/') || TEXT_FILE_RE.test(f.name)
      if (!isText) {
        skipped.push(f.name)
        continue
      }
      if (f.size > 2_000_000) {
        skipped.push(`${f.name} (too big)`)
        continue
      }
      try {
        const text = await f.text()
        added.push({ name: f.name, text: text.slice(0, 120000) })
      } catch {
        skipped.push(f.name)
      }
    }
    const room = Math.max(0, 25 - docs.length)
    const kept = added.slice(0, room)
    const droppedForCap = added.length - kept.length
    if (kept.length) writeDocs([...docs, ...kept])
    const bits: string[] = []
    if (kept.length) bits.push(`Added ${kept.length} document${kept.length > 1 ? 's' : ''}.`)
    if (droppedForCap > 0) bits.push(`${droppedForCap} not added (25-document limit reached).`)
    if (skipped.length) bits.push(`Skipped (text files only, ≤2 MB): ${skipped.slice(0, 3).join(', ')}.`)
    if (!bits.length) bits.push('No text files found. Supported: txt, md, csv, json, code…')
    setNote(bits.join(' '))
  }

  const remove = (i: number): void => writeDocs(docs.filter((_, idx) => idx !== i))

  const contextTitle = modeDisplayLabel ? `Context documents · ${modeDisplayLabel}` : 'Context documents'
  return (
    <Section
      title={contextTitle}
      desc="Import what this mode should know: résumé, deck, brief, specs. Kept per-mode, read on-device."
    >
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          if (e.dataTransfer.files.length) void ingest(e.dataTransfer.files)
        }}
        className={[
          'no-drag flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[var(--cl-radius)] border border-dashed px-4 py-6 text-center transition-colors',
          drag
            ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]'
            : 'border-[var(--cl-input)] bg-white/[0.02] hover:bg-white/[0.04]'
        ].join(' ')}
      >
        <Upload size={18} className="text-[color:var(--cl-primary)]" />
        <span className="text-[13px] text-[color:var(--cl-foreground)]">
          Add files for context
        </span>
        <span className="text-[12px] text-[color:var(--cl-muted-foreground)]">
          Drag &amp; drop files here to add them, or{' '}
          <button
            type="button"
            onClick={(e) => {
              // Stop the click from bubbling to the wrapping <label>, which would otherwise forward
              // its own synthetic click to the input and open the picker twice.
              e.preventDefault()
              e.stopPropagation()
              document.getElementById(inputId)?.click()
            }}
            className="no-drag cl-focus rounded text-[color:var(--cl-primary)] underline-offset-2 hover:underline"
          >
            Browse files
          </button>
        </span>
        <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
          Text files (txt, md, csv, json, code) up to 2 MB · 25 max
        </span>
        <input
          id={inputId}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && void ingest(e.target.files)}
        />
      </label>

      {note && <div className="mt-2 text-[11px] text-[color:var(--cl-muted-foreground)]">{note}</div>}

      {docs.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {docs.map((d, i) => (
            <div key={`${d.name}-${i}`} className="cl-card flex items-center gap-2 px-2.5 py-2">
              <FileText size={14} className="shrink-0 text-[color:var(--cl-primary)]" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]" title={d.name}>
                {d.name}
              </span>
              <span className="shrink-0 text-[10px] text-[color:var(--cl-muted-foreground)]">
                {(d.text.length / 1000).toFixed(1)}k chars
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                title="Remove"
                className="no-drag cl-focus shrink-0 text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-destructive)]"
              >
                <Trash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/**
 * Modes pane (two-column, Cluely-style): left = the mode list with the live “Active” marker; right = the
 * selected mode's editable system prompt + per-mode context files + a “Set active” control. Selecting a
 * mode on the left only changes what you're VIEWING/EDITING; “Set active” is the sticky footer action.
 */
function PersonalizeModes({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const active = settings.mode
  const customModes: CustomMode[] = settings.customModes ?? []
  const [selected, setSelected] = useState<string>(active)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [creatingNew, setCreatingNew] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [modeErr, setModeErr] = useState<string | null>(null)
  const locked = settings.managedKeys.includes('mode')
  // Gates custom-mode create/rename/delete — distinct from `locked` above (which only gates "Set active").
  // Without this, the trigger buttons silently no-op (patch() drops locked keys) and deleteCustomMode's
  // combined patch can partially apply (customModes entry dropped while modePrompts/contextDocs land).
  const customModesLocked = settings.managedKeys.includes('customModes')
  const overflowRef = useRef<HTMLDivElement>(null)
  // Two-step inline confirm for the overflow menu's destructive actions (mirrors the CLI-install
  // "confirming" phase idiom elsewhere in this file) — first click asks, second click actually deletes.
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Dismiss the "Mode options" overflow menu on an outside click or Escape (mirrors Bar.tsx's
  // ModePicker outside-click pattern).
  useEffect(() => {
    if (!overflowOpen) return
    const onDown = (e: MouseEvent): void => {
      if (overflowRef.current?.contains(e.target as Node)) return
      setOverflowOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Stop this Escape from reaching any window-level handler while just closing this menu.
      e.stopPropagation()
      setOverflowOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [overflowOpen])

  // Ensure selected still exists (could be deleted)
  const allIds = [
    ...MODE_GROUPS.flatMap((g) => g.modes as string[]),
    ...customModes.map((c) => c.id)
  ]
  const safeSelected = allIds.includes(selected) ? selected : (MODE_GROUPS[0]?.modes[0] ?? 'general')
  const selectedLabel = modeLabel(safeSelected, customModes)
  const isBuiltinSelected = safeSelected in BUILTIN_MODE_LABELS

  // Drop any pending "are you sure?" state when the menu closes or the viewed mode changes, so a stale
  // confirm from a different mode can never be armed by a later click.
  useEffect(() => {
    setConfirmClear(false)
    setConfirmDelete(false)
  }, [overflowOpen, safeSelected])

  const createNewMode = (): void => {
    if (customModesLocked) { setCreatingNew(false); setNewLabel(''); return }
    const label = newLabel.trim()
    // Fires on both Enter and the input's onBlur (clicking away) — an empty/whitespace-only label must
    // cancel instead of silently persisting a junk "New Mode" entry.
    if (!label) {
      setCreatingNew(false)
      setNewLabel('')
      return
    }
    // Schema cap (ipc.ts customModes .max(40)) — past this, setSettings drops the whole customModes key
    // and the mode picker silently falls back to General. Stop before that and say why, instead of
    // letting the create appear to work and then silently reverting.
    if (customModes.length >= 40) {
      setModeErr('40-mode limit reached.')
      setCreatingNew(false)
      setNewLabel('')
      return
    }
    const id = `custom-${Date.now()}`
    patch({ customModes: [...customModes, { id, label }] })
    setSelected(id)
    setCreatingNew(false)
    setNewLabel('')
    setModeErr(null)
  }

  const startRename = (): void => {
    setRenameValue(selectedLabel)
    setRenaming(true)
    setOverflowOpen(false)
  }

  const commitRename = (): void => {
    if (customModesLocked) { setRenaming(false); return }
    const label = renameValue.trim()
    if (label && !isBuiltinSelected) {
      patch({ customModes: customModes.map((c) => c.id === safeSelected ? { ...c, label } : c) })
    }
    setRenaming(false)
  }

  const deleteCustomMode = (): void => {
    if (customModesLocked) { setOverflowOpen(false); setConfirmDelete(false); return }
    setOverflowOpen(false)
    const nextModes = customModes.filter((c) => c.id !== safeSelected)
    const nextPrompts = { ...settings.modePrompts }
    delete nextPrompts[safeSelected]
    const nextDocs = { ...settings.contextDocs }
    delete nextDocs[safeSelected]
    const next: Partial<PublicSettings> = {
      customModes: nextModes,
      modePrompts: nextPrompts,
      contextDocs: nextDocs
    }
    if (active === safeSelected) next.mode = 'general'
    patch(next)
    setSelected('general')
  }

  const resetBuiltinPrompt = (): void => {
    setOverflowOpen(false)
    const m = { ...settings.modePrompts }
    delete m[safeSelected]
    patch({ modePrompts: m })
  }

  const clearBuiltinDocs = (): void => {
    setOverflowOpen(false)
    const d = { ...settings.contextDocs }
    delete d[safeSelected]
    patch({ contextDocs: d })
  }

  const renderModeButton = (m: string, label: string): JSX.Element => {
    const isSel = m === safeSelected
    const isActive = m === active
    return (
      <button
        key={m}
        type="button"
        onClick={() => { setSelected(m); setOverflowOpen(false) }}
        aria-pressed={isSel}
        className={[
          'no-drag cl-focus flex items-center gap-2 rounded-[10px] border px-2.5 py-1.5 text-left transition-colors',
          isSel
            ? 'border-[var(--cl-primary)]/40 bg-[var(--cl-primary-soft)]'
            : 'border-transparent hover:bg-white/[0.04]'
        ].join(' ')}
      >
        <span
          className={[
            'grid size-5 shrink-0 place-items-center rounded-[6px] text-[10px] font-semibold',
            isActive ? 'bg-[var(--cl-primary)] text-white' : 'bg-white/[0.06] text-[color:var(--cl-muted-foreground)]'
          ].join(' ')}
        >
          {label[0]?.toUpperCase() ?? '?'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]">
          {label}
        </span>
        {isActive && <CircleCheck size={13} className="shrink-0 text-[color:var(--cl-primary)]" />}
      </button>
    )
  }

  return (
    <div className="grid grid-cols-[176px_1fr] gap-4">
      {/* Left — mode list grouped by MODE_GROUPS + Custom. No inner scroll cap: the panel already has
          room for every built-in mode, and the tab's own outer scroll (<main> above) handles overflow
          on the rare account with enough custom modes to actually need it. */}
      <div className="flex flex-col gap-0.5">
        {/* + New Mode button */}
        {creatingNew ? (
          <div className="mb-1 flex items-center gap-1">
            <input
              autoFocus
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createNewMode()
                // stopPropagation: App.tsx's global Escape handler blur()s the focused input, which
                // would fire onBlur={createNewMode} and create the mode the user is cancelling.
                if (e.key === 'Escape') { e.stopPropagation(); setCreatingNew(false); setNewLabel('') }
              }}
              onBlur={createNewMode}
              placeholder="Mode name…"
              className={`flex-1 min-w-0 text-[12px] ${ctl} py-1.5`}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setCreatingNew(true); setModeErr(null) }}
            disabled={customModesLocked}
            className="no-drag cl-focus mb-1.5 flex items-center gap-1.5 rounded-[10px] border border-dashed border-[var(--cl-border)] px-2.5 py-1.5 text-[11px] text-[color:var(--cl-muted-foreground)] hover:border-[var(--cl-primary)]/50 hover:text-[color:var(--color-accent-text)] transition-colors disabled:opacity-50 disabled:hover:border-[var(--cl-border)] disabled:hover:text-[color:var(--cl-muted-foreground)]"
          >
            <Plus size={12} /> New Mode
          </button>
        )}

        {modeErr && (
          <div className="mb-1.5 px-1 text-[11px] text-[color:var(--color-danger)]">{modeErr}</div>
        )}

        {/* Built-in groups */}
        {MODE_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="cl-eyebrow mb-0.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--cl-muted-foreground)]">
              {group.label}
            </div>
            {group.modes.map((m) => renderModeButton(m, BUILTIN_MODE_LABELS[m]))}
          </div>
        ))}

        {/* Custom modes group */}
        {customModes.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            <div className="cl-eyebrow mb-0.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--cl-muted-foreground)]">
              Custom
            </div>
            {customModes.map((c) => renderModeButton(c.id, c.label))}
          </div>
        )}
      </div>

      {/* Right — selected mode's prompt + files + sticky footer */}
      <div className="flex min-w-0 flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {renaming && !isBuiltinSelected ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  // stopPropagation: App.tsx's global Escape handler blur()s the focused input, which
                  // would fire onBlur={commitRename} and save the rename the user is cancelling.
                  if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false) }
                }}
                onBlur={commitRename}
                className={`text-[18px] font-semibold bg-transparent border-b border-[var(--cl-primary)] outline-none text-[color:var(--cl-foreground)] w-full max-w-[200px]`}
              />
            ) : (
              <div className="truncate text-[18px] font-semibold text-[color:var(--cl-foreground)]">
                {selectedLabel}
              </div>
            )}
            <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
              {active === safeSelected ? 'This is your active mode.' : 'Previewing. Set active below.'}
            </div>
          </div>

          {/* Overflow menu */}
          <div ref={overflowRef} className="relative flex items-center gap-2">
            {active === safeSelected && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--cl-primary)]">
                <CircleCheck size={12} /> Active
              </span>
            )}
            <button
              type="button"
              onClick={() => setOverflowOpen((o) => !o)}
              aria-label="Mode options"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              className="no-drag cl-focus flex size-7 items-center justify-center rounded-md text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] hover:text-[color:var(--cl-foreground)]"
            >
              <MoreHorizontal size={15} />
            </button>
            {overflowOpen && (
              <div className="absolute right-0 top-8 z-20 min-w-[180px] rounded-[10px] border border-[var(--cl-border)] bg-[var(--cl-bg,#1a1a2e)] shadow-lg">
                {isBuiltinSelected ? (
                  <>
                    <button
                      type="button"
                      onClick={resetBuiltinPrompt}
                      disabled={settings.managedKeys.includes('modePrompts')}
                      className="no-drag w-full px-3 py-2 text-left text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.05] rounded-t-[10px] disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      <RotateCcw size={12} className="mr-2 inline" />
                      Reset prompt to default
                    </button>
                    {confirmClear ? (
                      <div className="flex items-center gap-1 px-3 py-2 rounded-b-[10px]">
                        <button
                          type="button"
                          onClick={clearBuiltinDocs}
                          className="no-drag flex-1 text-left text-[12px] font-medium text-[color:var(--cl-destructive)] hover:underline"
                        >
                          Confirm clear?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmClear(false)}
                          className="no-drag text-[12px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmClear(true)}
                        disabled={settings.managedKeys.includes('contextDocs')}
                        className="no-drag w-full px-3 py-2 text-left text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.05] rounded-b-[10px] disabled:opacity-50 disabled:hover:bg-transparent"
                      >
                        <Trash size={12} className="mr-2 inline" />
                        Clear context files
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={startRename}
                      disabled={customModesLocked}
                      className="no-drag w-full px-3 py-2 text-left text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.05] rounded-t-[10px] disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      Rename
                    </button>
                    {confirmDelete ? (
                      <div className="flex items-center gap-1 px-3 py-2 rounded-b-[10px]">
                        <button
                          type="button"
                          onClick={deleteCustomMode}
                          className="no-drag flex-1 text-left text-[12px] font-medium text-[color:var(--cl-destructive)] hover:underline"
                        >
                          Confirm delete?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(false)}
                          className="no-drag text-[12px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        disabled={customModesLocked}
                        className="no-drag w-full px-3 py-2 text-left text-[12px] text-[color:var(--cl-destructive)] hover:bg-white/[0.05] rounded-b-[10px] disabled:opacity-50 disabled:hover:bg-transparent"
                      >
                        <Trash size={12} className="mr-2 inline" />
                        Delete mode
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Prompt editor + context docs */}
        <ModePromptEditor settings={settings} patch={patch} mode={safeSelected} modeDisplayLabel={selectedLabel} />
        <ContextDocs settings={settings} patch={patch} mode={safeSelected} modeDisplayLabel={selectedLabel} />

        {/* Sticky footer: Set active */}
        {active !== safeSelected && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--cl-border)] pt-3">
            {locked && <ManagedChip keys={settings.managedKeys} k="mode" />}
            <button
              type="button"
              disabled={locked}
              onClick={() => patch({ mode: safeSelected })}
              className="no-drag cl-focus rounded-[10px] bg-[var(--cl-primary)] px-4 py-2 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Set active
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

type TabId =
  | 'ai'
  | 'personalize'
  | 'audio'
  | 'privacy'
  | 'meetings'
  | 'intelligence'
  | 'about'
  | 'calendar'
  | 'profile'

// Icons are Lucide components except Mantu Intelligence, which carries the official Mantu "M" mark —
// both render through the same `<t.icon size={14} />` call, so the type is the shared size-taking shape.
// `desc` is the short section intro shown under the tab bar; `keywords` seed the search field below —
// each list is the REAL card titles living under that tab (see the `<Section title=...>` calls), so a
// search never promises a match that isn't actually there.
//
// INVARIANT: fuzzyIncludes(keyword, query) matches when a KEYWORD contains the typed query as a
// substring — so a Section's exact title is only findable if some keyword in its tab's list is at
// least that long and contains it verbatim. Whenever a `<Section title="...">` is added or renamed
// under a tab, add that exact title text to this tab's `keywords` too (case/diacritic-insensitive —
// no need to match punctuation exactly, but don't rely on a shorter substring standing in for it).
const TABS: {
  id: TabId
  label: string
  icon: LucideIcon | ComponentType<{ size?: number }>
  desc: string
  keywords: string[]
}[] = [
  // Tab id stays 'personalize' (nothing keys off the label) — labeled to cover BOTH children rendered
  // under it: the transparency/appearance slider AND the Modes editor. A plain rename to just "Appearance"
  // would hide Modes (which onboarding explicitly teaches by that name) behind an unrelated-looking tab.
  {
    id: 'personalize',
    label: 'Modes & Display',
    icon: Wand2,
    desc: 'How Métis looks, and what each mode says.',
    keywords: ['appearance', 'transparency', 'opacity', 'glass', 'modes', 'language', 'custom instructions', 'prompt', 'operator skill']
  },
  {
    id: 'ai',
    label: 'AI',
    icon: Cpu,
    desc: 'Provider, API keys, local model, and thinking mode.',
    keywords: [
      'provider', 'api key', 'anthropic', 'openai', 'dust', 'claude code', 'codex', 'local ai',
      'thinking mode', 'model', 'other providers', 'model provider', 'cli integration',
      'fallback', 'indexing fallback', 'offline indexing',
      'backups & limits', 'nvidia', 'nim', 'race a backup provider', 'hedge',
      'cloudflare', 'worker', 'ai gateway', 'workers ai', 'metis_proxy_key', 'oauth', 'connect', 'cloudflare account id', 'cf ai gateway id',
      'routing mode', 'routing', 'local', 'api', 'auto'
    ]
  },
  {
    // Wave 5 Settings IA: user-facing label "Speech" (plan: AI · Speech · Brain · Integrations · Privacy).
    // Tab id stays 'audio' so persisted deep-links / managed-config and every `tab === 'audio'` guard keep working.
    id: 'audio',
    label: 'Speech',
    icon: Mic,
    desc: 'What Métis listens to, and how it hears you.',
    keywords: [
      'audio', 'speech', 'microphone', 'listen to', 'in meetings', 'vocabulary corrections',
      'transcription', 'asr', 'parakeet', 'whisper', 'apple speech', 'speaker identification',
      'transcript source', 'nova', 'soniox', 'cf ai gateway', 'cloudflare account id'
    ]
  },
  {
    id: 'calendar',
    label: 'Calendar',
    icon: Calendar,
    desc: "Connect Outlook and see today's agenda.",
    keywords: ['notifications', 'microsoft', 'outlook', 'microsoft / outlook', "today's agenda", 'calendar', 'sign in']
  },
  {
    id: 'meetings',
    label: 'Meetings',
    icon: FolderOpen,
    desc: 'Where meetings are saved, and how long they stay.',
    keywords: ['meetings & transcripts', 'folder', 'retention', 'danger zone', 'delete', 'ingest']
  },
  {
    // Wave 5: label "Brain" — CRM/MCP push lives here as Integrations content under the same tab
    // (overlay width cannot afford a tenth tab). Keywords keep old "Intelligence" / CRM search hits.
    id: 'intelligence',
    label: 'Brain',
    icon: MantuMark,
    desc: 'Your second brain: meetings, wiki, CRM push, knowledge graph.',
    keywords: [
      'mantu intelligence', 'intelligence', 'brain', 'meetings & follow-up', 'published wiki',
      'polo pre-sales', 'crm', 'integrations', 'knowledge graph', 'plane', 'clickup',
      'task management', 'book next steps', 'action items', 'time saved', 'estimate',
      'consolidation', 'token', 'batch index', 'brain consolidation',
      'batch index (1–2× / day)', 'prefer on-device model for consolidation',
      '06:00', '12:00', '18:00', 'America/Toronto', 'intelligence index'
    ]
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: ShieldCheck,
    desc: 'What Métis can see, record, and send.',
    keywords: [
      'screen capture', 'screen access', 'conversation memory', 'follow-up', 'memory',
      'recording consent', 'sensitive data', 'redact', 'permissions', 'usage',
      'operator', 'Operator', 'operator url', 'skill improvement', 'ingest secret'
    ]
  },
  // Identity + About you + Keybinds: the member pass is the hero; who you are and how you
  // drive Métis stay on the same tab so we do not add a tenth pill. Tab id stays `profile`.
  {
    id: 'profile',
    label: 'Identity',
    icon: IdCard,
    desc: 'Your member pass, who you are, and your keybinds.',
    keywords: [
      'identity',
      'member pass',
      'member number',
      'serial',
      'install date',
      'about you',
      'license',
      'keyboard shortcuts',
      'hotkeys',
      'tap control'
    ]
  },
  {
    id: 'about',
    label: 'About',
    icon: Info,
    desc: 'The story, the thanks, and the version.',
    keywords: ['why métis', 'thanks', 'version', 'credits', 'updates']
  }
]

/** Case/diacritic-insensitive substring test — lets "metis" match "Métis" in search. */
function fuzzyIncludes(haystack: string, needle: string): boolean {
  const norm = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  return norm(haystack).includes(norm(needle))
}

/**
 * Pure search over TABS, extracted out of the component so it is unit-testable without a render
 * harness (Settings.tsx has none — see Settings.contract.test.ts header note). Matches a tab's
 * label plus its keywords (see the INVARIANT comment above TABS): every real Section title in a
 * tab must appear in that tab's keywords, so a search for it here is a real proof, not a hope.
 */
export function searchSettingsTabs(query: string): ((typeof TABS)[number] & { matchedKeyword?: string })[] {
  const q = query.trim()
  if (!q) return []
  return TABS.filter(
    (t) => fuzzyIncludes(t.label, q) || t.keywords.some((k) => fuzzyIncludes(k, q))
  ).map((t) => ({
    ...t,
    matchedKeyword: t.keywords.find((k) => fuzzyIncludes(k, q))
  }))
}

export function Settings({
  settings,
  refreshSettings,
  patch,
  saveKey,
  recoverEncryptedProfile,
  clearKey,
  testKey,
  onClose,
  initialTab,
  notice,
  onQuit,
  onLogout,
  navigationGuard,
  onOpenIntelligence,
  onOpenHistory,
  onOpenMeeting
}: {
  settings: PublicSettings
  refreshSettings: () => Promise<void>
  patch: (p: Partial<PublicSettings>) => Promise<PublicSettings>
  saveKey: (provider: ProviderId, k: string) => Promise<void>
  recoverEncryptedProfile: () => Promise<ProfileRecoveryResult>
  clearKey: (provider: ProviderId) => Promise<void>
  testKey: (provider: ProviderId, k: string) => Promise<TestKeyResponse>
  onClose?: () => void
  initialTab?: TabId
  // Mantu Intelligence tab navigation — routed through the parent because the dashboard (BrainView),
  // meeting History, and a past meeting's Review are top-level views, not children of Settings.
  onOpenIntelligence?: () => void
  onOpenHistory?: () => void
  onOpenMeeting?: (file: string) => void
  navigationGuard: NavigationGuardService
  // Shown as a small banner under the header — e.g. why the user got redirected here (no provider
  // ready). Without this, a silent tab-open reads as broken rather than as a guided fix.
  notice?: string
  // Quit / Log out routed through the parent so any in-flight meeting is flushed to disk first.
  // Fall back to the raw IPC if a parent doesn't supply them (keeps the component standalone).
  onQuit?: () => void
  onLogout?: () => void
}): JSX.Element {
  const [tab, setTab] = useState<TabId>(initialTab ?? 'personalize')
  // Guided search — jumps between sections instead of the old dig-through-nine-tabs pattern. Matches the
  // tab label plus its real card keywords (see TABS above), so a hit always points at something that
  // actually exists on that tab.
  const [query, setQuery] = useState('')
  const [operatorSecretDraft, setOperatorSecretDraft] = useState('')
  const [operatorSecretSaving, setOperatorSecretSaving] = useState(false)
  const [operatorSecretError, setOperatorSecretError] = useState<string | null>(null)
  const [replayState, setReplayState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const [overlayPlacementSave, setOverlayPlacementSave] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null
  })
  const overlayPlacementSaveInFlight = useRef(false)
  const saveOperatorSecret = async (): Promise<void> => {
    setOperatorSecretSaving(true)
    setOperatorSecretError(null)
    try {
      await patch({ operatorIngestSecret: operatorSecretDraft.trim() })
      setOperatorSecretDraft('')
    } catch {
      setOperatorSecretError('Could not save the connection. Try again.')
    } finally {
      setOperatorSecretSaving(false)
    }
  }
  const searchMatches = useMemo(() => searchSettingsTabs(query), [query])
  const jumpTo = (id: TabId): void => {
    setTab(id)
    setQuery('')
  }
  // openMeetingsFolder resolves a non-empty string on failure (e.g. the folder was deleted/unmounted) —
  // surface it instead of silently discarding it (was `void window.toto.openMeetingsFolder()`).
  const [meetingsFolderErr, setMeetingsFolderErr] = useState<string | null>(null)
  const replayOnboarding = async (): Promise<void> => {
    if (replayState.busy) return
    const choice = await navigationGuard.request({
      title: 'Replay onboarding?',
      message: "Start setup again from the beginning. Your settings won't change.",
      saveLabel: 'Replay',
      discardLabel: 'Stay here',
      cancelLabel: 'Cancel'
    })
    if (choice !== 'save') return
    setReplayState({ busy: true, error: null })
    try {
      const saved = await patch({ onboardingDone: false })
      // Auth/managed policy can return a valid snapshot while refusing this mutation. Never replace the
      // current Settings window unless the reply proves the gate is actually re-armed.
      if (saved.onboardingDone !== false) throw new Error('onboarding replay was not saved')
      haltAllOnboardingAudio()
      unlockOnboardingAudio()
      window.toto.onboardingEnter()
    } catch {
      setReplayState({ busy: false, error: "Métis couldn't start setup again. Try again." })
      return
    }
    setReplayState({ busy: false, error: null })
  }
  const saveOverlayPlacement = async (id: OverlayPlacement): Promise<void> => {
    if (overlayPlacementSaveInFlight.current || settings.managedKeys.includes('overlayPlacement')) return
    overlayPlacementSaveInFlight.current = true
    setOverlayPlacementSave({ busy: true, error: null })
    try {
      const saved = await persistOverlayPlacement(id, settings.overlayLayout, patch)
      // Managed policy can return an unchanged snapshot without throwing. Do not pretend a click took
      // effect until the durable main-process reply confirms the requested position.
      if (!saved) throw new Error('overlay placement was not saved')
    } catch {
      setOverlayPlacementSave({ busy: false, error: "Métis couldn't save this position. Try again." })
      return
    } finally {
      overlayPlacementSaveInFlight.current = false
    }
    setOverlayPlacementSave({ busy: false, error: null })
  }
  // App reuses the same Settings instance across opens (no remount), so a later requireProvider redirect
  // that passes a new initialTab (e.g. 'ai') would otherwise leave `tab` stuck on whatever tab was open
  // before — re-sync whenever the caller hands us a fresh target tab.
  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab])
  const managed = settings.managedKeys.length > 0
  // Switching tabs must land at the top of the new tab's content — the scroll container otherwise
  // keeps whatever scroll position the previous tab was left at. useLayoutEffect (not useEffect) so this
  // runs before the browser paints the new tab, avoiding a one-frame flash at the old scroll offset.
  const contentRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [tab])
  // Match the worker's fail-closed source selection. A failed/absent probe cannot expose a development
  // preference that has no effect in a production build.
  const [asrBundled, setAsrBundled] = useState(true)
  useEffect(() => {
    void window.toto.asrBundled().then(setAsrBundled).catch(() => setAsrBundled(true))
  }, [])
  // Parakeet native-addon health. addonError is set when the sherpa-onnx addon itself failed to load
  // (e.g. a wrong-platform build) — a different failure from missing bundled assets, so the Audio
  // tab can say "engine broken in this build" instead of letting the toggle silently do nothing.
  // Refetch (not just fetch-once-on-mount) whenever the Audio tab becomes active — an addon failure
  // discovered mid-session (e.g. a meeting that started on another tab) must show up the moment the
  // user looks, not only after Settings is fully closed and reopened — and whenever asrEngine changes,
  // since flipping the toggle can trigger a fresh addon load attempt in main. Guarded to tab === 'audio'
  // because this row only renders there.
  const [parakeetAddonError, setParakeetAddonError] = useState<string | null>(null)
  useEffect(() => {
    if (tab !== 'audio') return
    let cancelled = false
    void window.toto.parakeetStatus().then((st) => {
      if (!cancelled) setParakeetAddonError(st.addonError)
    })
    return () => {
      cancelled = true
    }
  }, [tab, settings.asrEngine])

  return (
    <div className="cl-root flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl shadow-[var(--shadow-panel)] text-[color:var(--cl-foreground)]">
      {/* Draggable header — sits directly under the always-visible Métis bar */}
      <header className="cl-header drag flex h-11 shrink-0 items-center gap-2 rounded-t-2xl px-3.5">
        <MetisMark size={18} />
        <span className="font-ui text-[14px] font-semibold tracking-tight">Settings</span>
        {managed && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--cl-primary)]">
            Managed by your organization
          </span>
        )}
        <div className="relative ml-auto w-[168px]">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--cl-muted-foreground)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchMatches.length > 0) jumpTo(searchMatches[0].id)
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="no-drag cl-focus h-7 w-full rounded-full border border-[var(--cl-input)] bg-white/[0.04] pl-7 pr-2.5 text-[11px] text-[color:var(--cl-foreground)] placeholder:text-[color:var(--cl-muted-foreground)]"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="no-drag cl-focus flex size-7 shrink-0 items-center justify-center rounded-md text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] hover:text-[color:var(--cl-foreground)]"
        >
          <X size={16} />
        </button>
      </header>

      {/* The redirect nudge (e.g. "Add an API key here") is targeted at a specific tab via
          openSettings(tab, notice), so only show it while the user is ON that tab — once they navigate
          away it no longer points at anything visible. Reappears if they come back to the tab. */}
      {notice && tab === (initialTab ?? 'personalize') && (
        <div className="no-drag shrink-0 border-b border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] px-3.5 py-2 text-[12px] leading-snug text-[color:var(--cl-foreground)]">
          {notice}
        </div>
      )}

      {/* TOP tab bar (the owner: "setting bar at the top") — horizontal, scrolls if narrow */}
      <nav
        role="tablist"
        aria-label="Settings sections"
        className="cl-tabbar no-drag scroll-thin flex shrink-0 items-center justify-between gap-0.5 overflow-x-auto border-b border-[var(--cl-border)] px-2 py-1.5"
      >
        {TABS.map((t, i) => {
          const active = t.id === tab
          const matched = query.trim() !== '' && searchMatches.some((m) => m.id === t.id)
          // Roving tabindex per the APG tabs pattern: only the active tab is Tab-reachable; arrow keys
          // move focus and activation between the rest.
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={active}
              aria-controls="settings-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => jumpTo(t.id)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault()
                const dir = e.key === 'ArrowRight' ? 1 : -1
                const next = TABS[(i + dir + TABS.length) % TABS.length]
                setTab(next.id)
                document.getElementById(`settings-tab-${next.id}`)?.focus()
              }}
              className={[
                'cl-focus flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                active
                  ? 'bg-[var(--cl-primary)] text-white'
                  : matched
                    ? 'text-[color:var(--cl-foreground)] ring-1 ring-inset ring-[var(--cl-primary)]/60'
                    : query.trim() !== ''
                      ? 'text-[color:var(--cl-muted-foreground)] opacity-40'
                      : 'text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] hover:text-[color:var(--cl-foreground)]'
              ].join(' ')}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          )
        })}
      </nav>

      {/* Active tab's short intro — one line, so a dense nine-tab bar still reads as a guided flow rather
          than a wall of pill buttons. Swaps for the search results list while a query is live. */}
      {query.trim() === '' ? (
        <p className="m-0 shrink-0 border-b border-[var(--cl-border)] px-3.5 py-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          {TABS.find((t) => t.id === tab)?.desc}
        </p>
      ) : (
        <div className="flex shrink-0 flex-col gap-0.5 border-b border-[var(--cl-border)] px-2 py-1.5">
          {searchMatches.length === 0 ? (
            <p className="m-0 px-1.5 py-1 text-[11px] text-[color:var(--cl-muted-foreground)]">No matching settings.</p>
          ) : (
            searchMatches.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => jumpTo(m.id)}
                className="no-drag cl-focus flex items-center gap-2 rounded-[8px] px-1.5 py-1 text-left text-[11px] text-[color:var(--cl-foreground)] hover:bg-white/[0.06]"
              >
                <m.icon size={12} className="shrink-0 text-[color:var(--cl-primary)]" />
                <span className="font-medium">{m.label}</span>
                {m.matchedKeyword && (
                  <span className="truncate text-[color:var(--cl-muted-foreground)]">· {m.matchedKeyword}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}

      <main
        ref={contentRef}
        role="tabpanel"
        id="settings-panel"
        aria-labelledby={`settings-tab-${tab}`}
        className={SETTINGS_CONTENT_SCROLL_CLASS}
      >
        <TabIconContext.Provider value={TABS.find((t) => t.id === tab)?.icon}>
        <div className="flex min-w-0 max-w-full flex-col gap-6 px-5 pt-5 pb-16">
            {tab === 'ai' && (
              <AiSection
                settings={settings}
                patch={patch}
                saveKey={saveKey}
                recoverEncryptedProfile={recoverEncryptedProfile}
                clearKey={clearKey}
                testKey={testKey}
              />
            )}

            {tab === 'personalize' && (
              <div className="flex flex-col gap-6">
                <Section title="Modes" desc="Edit each mode's prompt and the files it can see, then set the one you want active." icon={Wand2}>
                  <PersonalizeModes settings={settings} patch={patch} />
                </Section>
                <Section title="Appearance" desc="How see-through the overlay's background is. Default matches what you see today." icon={Sparkles}>
                  <label className="flex items-center justify-between gap-3 px-1 py-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
                    <span className="flex items-center gap-2">
                      {settings.overlayOpacity < 0.9
                        ? 'More transparent'
                        : settings.overlayOpacity > 1.1
                          ? 'Less transparent'
                          : 'Default'}
                      <ManagedChip keys={settings.managedKeys} k="overlayOpacity" />
                    </span>
                    <input
                      type="range"
                      min={0.3}
                      max={1.5}
                      step={0.05}
                      value={settings.overlayOpacity}
                      disabled={settings.managedKeys.includes('overlayOpacity')}
                      onChange={(e) => patch({ overlayOpacity: Number(e.target.value) })}
                      className={['no-drag accent-[var(--cl-primary)]', settings.managedKeys.includes('overlayOpacity') ? 'opacity-60' : ''].join(' ')}
                    />
                  </label>
                  {/* Live preview: --overlay-opacity-scale is set on <html> by App.tsx the instant patch()
                      round-trips, and .glass-strong already reads that var — so this swatch reflects the
                      slider with zero extra plumbing, not a simulated approximation. */}
                  <div className="glass-strong mt-1 flex items-center gap-2 rounded-[12px] px-3 py-2.5">
                    <MetisMark size={16} />
                    <span className="text-[12px] text-[color:var(--color-ink)]">This is how the overlay bar will look.</span>
                  </div>
                  <div className="mt-3 px-1">
                    <p className="mt-3 mb-0 text-[12px] font-medium text-[color:var(--cl-foreground)]">
                      Overlay position <ManagedChip keys={settings.managedKeys} k="overlayPlacement" />
                    </p>
                    <p className="mt-0.5 mb-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                      Keep Métis at the top center, or use a right-edge sidecar and drag it vertically to place it.
                    </p>
                    <OverlayPlacementPicker
                      value={settings.overlayPlacement}
                      locked={settings.managedKeys.includes('overlayPlacement') || overlayPlacementSave.busy}
                      onChange={saveOverlayPlacement}
                    />
                    {overlayPlacementSave.busy ? (
                      <p className="mt-2 mb-0 text-[11px] text-[color:var(--cl-muted-foreground)]" aria-live="polite">
                        Saving position…
                      </p>
                    ) : null}
                    {overlayPlacementSave.error ? (
                      <p role="alert" className="mt-2 mb-0 text-[11px] text-[color:var(--cl-destructive)]">
                        {overlayPlacementSave.error}
                      </p>
                    ) : null}
                    <p className="mt-3 mb-0 text-[12px] font-medium text-[color:var(--cl-foreground)]">Overlay chrome</p>
                    <p className="mt-0.5 mb-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                      How Métis sits on the desktop. Changes apply now, no reinstall.
                    </p>
                    <OverlayChromePicker
                      value={settings.overlayLayout}
                      placement={settings.overlayPlacement}
                      copy={overlayLayoutCopy(settings.overlayPlacement)}
                      locked={settings.managedKeys.includes('overlayLayout')}
                      onChange={(id) =>
                        patch({
                          overlayLayout: id,
                          autoHideOverlay: autoHideOverlayForLayout(id)
                        })
                      }
                    />
                    {overlayShowsBarRestPicker(resolveOverlayPresentation({ layout: settings.overlayLayout, placement: settings.overlayPlacement }).layout) ? (
                      <>
                        <p className="mt-3 mb-0 text-[12px] font-medium text-[color:var(--cl-foreground)]">Bar rest</p>
                        <p className="mt-0.5 mb-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                          Applies when Overlay chrome is Bar.
                        </p>
                        <OverlayOrbPicker
                          value={settings.overlayOrbStyle}
                          locked={settings.managedKeys.includes('overlayOrbStyle')}
                          onChange={(id) => patch({ overlayOrbStyle: id })}
                        />
                      </>
                    ) : null}
                  </div>
                </Section>
                <Section
                  title="Language"
                  desc="Pick the language for live answers, and a separate one for the saved summary (useful when the meeting is in one language but you want notes in another)."
                  icon={MessageSquare}
                >
                  <label className="mb-1 block text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                    Answers & live assist
                  </label>
                  <select
                    value={settings.outputLanguage}
                    onChange={(e) => patch({ outputLanguage: e.target.value })}
                    disabled={settings.managedKeys.includes('outputLanguage')}
                    aria-label="Answers and live assist language"
                    className={'w-full ' + ctl}
                  >
                    <option value="auto">Auto · match the conversation</option>
                    {LANGUAGE_OPTIONS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <label className="mb-1 mt-3 block text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                    Summary &amp; recap
                  </label>
                  <select
                    value={settings.summaryLanguage}
                    onChange={(e) => patch({ summaryLanguage: e.target.value })}
                    disabled={settings.managedKeys.includes('summaryLanguage')}
                    aria-label="Summary and recap language"
                    className={'w-full ' + ctl}
                  >
                    <option value="auto">Same as answers</option>
                    {LANGUAGE_OPTIONS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Section>
                <Section title="Custom instructions" desc="Added to every mode's prompt. Leave blank to use the defaults." icon={AlignLeft}>
                  <LazyTextarea
                    value={settings.systemPrompt}
                    onCommit={(v) => patch({ systemPrompt: v })}
                    disabled={settings.managedKeys.includes('systemPrompt')}
                    rows={3}
                    spellCheck={false}
                    placeholder="e.g. Always answer in British English. Keep answers concise."
                    className={'w-full resize-y ' + ctl}
                  />
                </Section>
                {/* ProfileEditor moved to the Profile tab */}
              </div>
            )}

            {tab === 'audio' && (
              <div className="flex min-w-0 max-w-full flex-col gap-6">
                <Section title="Listen to" desc="Whose audio Métis transcribes during a meeting." icon={Mic}>
                  <div className="mb-2"><ManagedChip keys={settings.managedKeys} k="audioSource" /></div>
                  <AudioChoices settings={settings} patch={patch} />
                  <MicPicker settings={settings} patch={patch} />
                  {/* Mic-only capture trace — same after-the-fact contract as asrLastFallbackAt in the
                      Speech tab: a meeting that requested system audio ran with the microphone only, so
                      the other side's speech is missing from the transcript. Persists until dismissed. */}
                  {settings.micOnlyFallbackAt != null && (
                    <div className="mt-1 flex min-w-0 flex-wrap items-start justify-between gap-2 pl-1 text-[12px] text-[color:var(--color-ink-3)]">
                      <span className="min-w-0 flex-1 break-words">
                        A recent meeting captured your microphone only. The other side&apos;s audio was not
                        recorded
                        {isWindows
                          ? ' (check that the call plays through your default output device)'
                          : ' (usually the Screen Recording permission)'}
                        . {new Date(settings.micOnlyFallbackAt).toLocaleString()}.
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {!isWindows && (
                          <TextButton onClick={() => void window.toto.openPermissionSettings('screenRecording')}>
                            Open Screen Recording settings
                          </TextButton>
                        )}
                        <TextButton onClick={() => patch({ micOnlyFallbackAt: null })}>Dismiss</TextButton>
                      </span>
                    </div>
                  )}
                </Section>
                <TapControlCard settings={settings} patch={patch} />
                <Section title="In meetings" icon={Headphones}>
                  <ToggleRow
                    label="Auto-answer"
                    desc="Draft a reply the moment they ask a question."
                    on={settings.autoSuggest}
                    onChange={(v) => patch({ autoSuggest: v })}
                    disabled={settings.managedKeys.includes('autoSuggest')}
                    icon={MessageSquare}
                  />
                  <label className="flex items-center justify-between gap-3 px-1 py-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
                    <span className="flex items-center gap-2">
                      Auto-answer cooldown · {settings.suggestEverySec}s
                      <ManagedChip keys={settings.managedKeys} k="suggestEverySec" />
                    </span>
                    <input
                      type="range"
                      min={5}
                      max={120}
                      step={5}
                      value={settings.suggestEverySec}
                      disabled={settings.managedKeys.includes('suggestEverySec')}
                      onChange={(e) => patch({ suggestEverySec: Number(e.target.value) })}
                      className={['no-drag accent-[var(--cl-primary)]', settings.managedKeys.includes('suggestEverySec') ? 'opacity-60' : ''].join(' ')}
                    />
                  </label>
                  <ToggleRow
                    label="Show live transcript"
                    desc="On shows the rolling transcript alongside suggested replies; off shows replies only."
                    on={settings.showLiveTranscript}
                    onChange={(v) => patch({ showLiveTranscript: v })}
                    disabled={settings.managedKeys.includes('showLiveTranscript')}
                  />
                  <ToggleRow
                    label="Show full transcript in review"
                    desc="Off = the end-of-meeting screen shows just the summary; the transcript stays one click away."
                    on={settings.showFullTranscriptInReview}
                    onChange={(v) => patch({ showFullTranscriptInReview: v })}
                    disabled={settings.managedKeys.includes('showFullTranscriptInReview')}
                  />
                  {!isCloudOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive)) && (
                    <>
                      <CoreAsrAssetsRow />
                      <WhisperQualityRow bundled={asrBundled} settings={settings} patch={patch} />
                    </>
                  )}
                  {(() => {
                    const liveProfile = resolveEnterpriseLiveProfile(settings.enterpriseLive)
                    const cloudOnly = isCloudOnlyProfile(liveProfile)
                    const cloudProvider = effectiveCloudSttProvider(liveProfile, settings.cloudSttProvider)
                    if (cloudOnly) {
                      return (
                        <div className="flex flex-col gap-1.5 px-1 py-1">
                          <label className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
                            Transcript source
                            <FieldHint text="This organization profile sends meeting audio to approved cloud speech recognition. Cloudflare Nova-3 is the default. Soniox is available when your organization has approved it. On-device Whisper, Parakeet, and Apple Speech stay off for this profile, including when cloud speech fails.">
                              <Info size={12} className="shrink-0 text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]" />
                            </FieldHint>
                            <ManagedChip keys={settings.managedKeys} k="cloudSttProvider" />
                          </label>
                          <select
                            value={cloudProvider}
                            onChange={(e) =>
                              patch({ cloudSttProvider: e.target.value as CloudSttProviderId })
                            }
                            disabled={settings.managedKeys.includes('cloudSttProvider')}
                            aria-label="Transcript source"
                            className={'w-full ' + ctl}
                          >
                            <option value="cloudflare-nova3">Cloudflare Nova-3 · cloud speech</option>
                            <option value="soniox">Soniox · cloud speech (when approved)</option>
                          </select>
                          <p className="pl-0.5 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                            Live captions use cloud speech. Audio capture stays on this device; transcripts are
                            transient. Summaries and actions are what get saved.
                          </p>
                          {cloudProvider === 'cloudflare-nova3' && (
                            <div className="mt-1 flex flex-col gap-2 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.02] p-2.5">
                              <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                                Nova needs a Cloudflare account token (Settings → AI / Keys), plus account id or
                                an account-scoped base URL. Gateway id is optional (blank uses default).
                                {settings.hasKeys?.cloudflare
                                  ? ' Cloudflare token is seated.'
                                  : ' Cloudflare token is not seated yet.'}
                              </p>
                              <label className="flex flex-col gap-1 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                                Cloudflare account id
                                <LazyInput
                                  value={settings.cloudflareAccountId ?? ''}
                                  disabled={settings.managedKeys.includes('cloudflareAccountId')}
                                  onCommit={(v) => patch({ cloudflareAccountId: v.trim() })}
                                  placeholder="32 hex characters"
                                  aria-label="Cloudflare account id for Nova"
                                  className={'w-full ' + ctl}
                                />
                              </label>
                              <label className="flex flex-col gap-1 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                                CF AI Gateway id
                                <LazyInput
                                  value={settings.cfAiGatewayId ?? ''}
                                  disabled={settings.managedKeys.includes('cfAiGatewayId')}
                                  onCommit={(v) => patch({ cfAiGatewayId: v.trim() })}
                                  placeholder="default"
                                  aria-label="CF AI Gateway id for Nova"
                                  className={'w-full ' + ctl}
                                />
                              </label>
                            </div>
                          )}
                          {cloudProvider === 'soniox' && (
                            <SonioxKeySeat
                              hasKey={!!settings.hasKeys?.soniox}
                              envLocked={settings.envKeys.includes('soniox')}
                              onSaved={() => void refreshSettings()}
                            />
                          )}
                        </div>
                      )
                    }
                    return (
                      <div className="flex flex-col gap-1.5 px-1 py-1">
                        <label className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
                          Transcription engine
                          <FieldHint text="For fresh setup, 8 GB or less selects Parakeet; more than 8 GB selects Whisper. Unknown memory uses Parakeet. Existing choices and organization policy are preserved. Parakeet supports European languages; Whisper supports a wider range of languages. Apple Speech uses the macOS on-device recognizer for live meetings; imports use Whisper. Managed cloud profiles hide these on-device engines and use Cloudflare Nova-3 or Soniox instead.">
                            <Info size={12} className="shrink-0 text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]" />
                          </FieldHint>
                          <ManagedChip keys={settings.managedKeys} k="asrEngine" />
                        </label>
                        <select
                          value={settings.asrEngine}
                          onChange={(e) => patch({ asrEngine: e.target.value as 'parakeet' | 'whisper' | 'apple' })}
                          disabled={settings.managedKeys.includes('asrEngine')}
                          aria-label="Transcription engine"
                          className={'w-full ' + ctl}
                        >
                          <option value="parakeet">Parakeet · European languages</option>
                          <option value="whisper">Whisper · multilingual</option>
                          <option value="apple">Apple Speech · on-device{isWindows ? ' (macOS only)' : ''}</option>
                        </select>
                      </div>
                    )
                  })()}
                  <div className="flex flex-col gap-1.5 px-1 py-1">
                    <label className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
                      Spoken language
                      <FieldHint text="The language your meetings usually start in. Whisper decodes in this language and follows automatically if the conversation switches mid-meeting; Apple Speech uses it as its recognizer language; Parakeet always auto-detects; cloud STT (Nova-3 / Soniox) maps Auto to multilingual detect for French, English, Spanish, Portuguese, and Italian (and more), pins sticky when speech settles, and follows mid-meeting switches. Explicit French still prefers fr-CA. Applies immediately, even during a live meeting. Auto = detect from speech.">
                        <Info size={12} className="shrink-0 text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]" />
                      </FieldHint>
                      <ManagedChip keys={settings.managedKeys} k="asrLanguage" />
                    </label>
                    <select
                      value={settings.asrLanguage}
                      onChange={(e) => patch({ asrLanguage: e.target.value })}
                      disabled={settings.managedKeys.includes('asrLanguage')}
                      aria-label="Spoken language"
                      className={'w-full ' + ctl}
                    >
                      <option value="auto">Auto · detect per phrase</option>
                      {LANGUAGE_OPTIONS.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Engine broken in this build (native addon failed to load) — distinct from missing
                      packaged assets, which require a complete installer. */}
                  {parakeetAddonError != null && (
                    <div className="-mt-1 flex items-start gap-1.5 pl-1 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
                      <AlertCircle size={12} className="mt-0.5 shrink-0" />
                      <span>
                        The Parakeet engine can&apos;t load in this build: {parakeetAddonError}. This is an
                        engine problem, not a missing model download. Meetings will use Whisper until a
                        build with a working engine is installed.
                      </span>
                    </div>
                  )}
                  {settings.asrLastFallbackAt != null && (
                    <div className="-mt-1 flex min-w-0 flex-wrap items-start justify-between gap-2 pl-1 text-[12px] text-[color:var(--color-ink-3)]">
                      <span className="min-w-0 flex-1 break-words">
                        Parakeet failed and auto-switched to Whisper for the rest of a recent meeting.{' '}
                        {new Date(settings.asrLastFallbackAt).toLocaleString()}.
                      </span>
                      <TextButton onClick={() => patch({ asrLastFallbackAt: null })}>Dismiss</TextButton>
                    </div>
                  )}
                  {!isCloudOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive)) && (
                    <AsrModelRow engine={settings.asrEngine} />
                  )}
                  {settings.asrImportTierFallbackAt != null && (
                    <div className="-mt-1 flex min-w-0 flex-wrap items-start justify-between gap-2 pl-1 text-[12px] text-[color:var(--color-ink-3)]">
                      <span className="min-w-0 flex-1 break-words">
                        A recent imported recording used compact Whisper base because the larger
                        import model was unavailable. {new Date(settings.asrImportTierFallbackAt).toLocaleString()}.
                      </span>
                      <TextButton onClick={() => patch({ asrImportTierFallbackAt: null })}>Dismiss</TextButton>
                    </div>
                  )}
                  {(settings as SettingsWithAsrWebgpuFallback).asrWebgpuFallbackAt != null && (
                    <div className="-mt-1 flex min-w-0 flex-wrap items-start justify-between gap-2 pl-1 text-[12px] text-[color:var(--color-ink-3)]">
                      <span className="min-w-0 flex-1 break-words">
                        A recent live session used Whisper base instead of the requested large model.
                        Packaged builds use Whisper base for live transcription. The optional larger
                        download changes imported recordings only.
                      </span>
                      <TextButton
                        onClick={() =>
                          patch({ asrWebgpuFallbackAt: null } as Partial<SettingsWithAsrWebgpuFallback>)
                        }
                      >
                        Dismiss
                      </TextButton>
                    </div>
                  )}
                  <ToggleRow
                    label="Start-of-recording chime"
                    desc="Plays a short tone so everyone knows the moment Métis starts listening."
                    on={settings.playListenChime}
                    onChange={(v) => patch({ playListenChime: v })}
                    disabled={settings.managedKeys.includes('playListenChime')}
                  />
                  <ToggleRow
                    label="Sound cues"
                    desc="A subtle tone when an answer is ready, and a gentle one if it fails."
                    on={settings.soundCues}
                    onChange={(v) => patch({ soundCues: v })}
                    disabled={settings.managedKeys.includes('soundCues')}
                  />
                  <ToggleRow
                    label="Interface sounds"
                    desc="A soft click when you tap buttons. Turn off for fully silent interaction."
                    on={settings.uiSounds}
                    onChange={(v) => patch({ uiSounds: v })}
                    disabled={settings.managedKeys.includes('uiSounds')}
                  />
                  <ToggleRow
                    label="Rainbow ring on quick actions"
                    desc="Show the spinning rainbow border on the quick-action chips."
                    on={settings.quickActionsRainbow}
                    onChange={(v) => patch({ quickActionsRainbow: v })}
                    disabled={settings.managedKeys.includes('quickActionsRainbow')}
                  />
                  <ToggleRow
                    label="Instant suggestions"
                    desc="Pre-generate 'What to say next' while a meeting is live so it appears instantly. Uses more credits during meetings."
                    on={settings.instantSuggestions}
                    onChange={(v) => patch({ instantSuggestions: v })}
                    disabled={settings.managedKeys.includes('instantSuggestions')}
                  />
                  <ToggleRow
                    label="Preload screen context (on-device)"
                    desc={
                      settings.backgroundScreenReady || !settings.backgroundScreenContext
                        ? // Deliberately does not name the local model as the reader: on macOS the
                          // reader can be the Vision OCR helper, with no model involved at all.
                          "When you switch windows, Métis quietly reads your screen on this device so 'What's on my screen' answers instantly. Stays on your device, nothing extra is sent to the cloud, and Private View turns it off."
                        : settings.localReady
                          ? isWindows
                            ? // Local AI is ready, so the missing piece is the OS window signal — telling
                              // this user to enable Local AI would just be the opposite lie.
                              "Not running on this machine. Métis can't tell when you switch windows, so screen asks capture live instead."
                            : // On macOS there is a second way to be off: the reader is gated on Screen
                              // Recording already being granted, because its own capture would otherwise be
                              // what raises the system prompt (MQA-209). The renderer can't tell the two
                              // apart, so name the actionable one first rather than guess wrong.
                              'Not running on this machine. Check Screen Recording under Permissions below (a new grant needs a restart). Screen asks capture live instead.'
                          : 'Enable Local AI (below) to use this. The background reader never leaves your device.'
                    }
                    on={settings.backgroundScreenContext}
                    onChange={(v) => patch({ backgroundScreenContext: v })}
                    disabled={settings.managedKeys.includes('backgroundScreenContext')}
                  />
                </Section>
                <Section title="Vocabulary corrections" desc="Words the transcriber keeps getting wrong. Fix them once, applied to every meeting." icon={MessageSquareQuote}>
                  <ToggleRow
                    label="Spell known names correctly"
                    desc="Spell names from your meeting history correctly in transcripts (people and accounts your brain already knows)."
                    on={settings.asrEntityBias}
                    onChange={(v) => patch({ asrEntityBias: v })}
                    disabled={settings.managedKeys.includes('asrEntityBias')}
                  />
                  <VocabCorrectionsTextarea
                    corrections={settings.asrCorrections}
                    onCommit={(next) => patch({ asrCorrections: next })}
                    placeholder={'Metis => Métis\nMantu => Mantu\nparakeet => Parakeet'}
                    disabled={settings.managedKeys.includes('asrCorrections')}
                    className={[
                      ctl,
                      'h-20 resize-none text-[12px]',
                      settings.managedKeys.includes('asrCorrections') ? 'opacity-60 cursor-not-allowed' : ''
                    ].join(' ')}
                  />
                  <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                    One per line, format: heard =&gt; correct.
                  </span>
                  <VocabSuggestions settings={settings} patch={patch} />
                </Section>
              </div>
            )}

            {tab === 'privacy' && (
              <div className="flex flex-col gap-6">
                <Section title="Screen capture" desc="Two separate switches: what others can see of Métis, and what Métis can see of your screen." icon={Camera}>
                  <ToggleRow
                    label="Hide from screen capture"
                    desc="Hide the Métis window from screen capture & sharing, so people you share with never see it. Doesn't affect screen questions."
                    on={settings.contentProtection}
                    onChange={(v) => patch({ contentProtection: v })}
                    disabled={settings.managedKeys.includes('contentProtection')}
                    icon={Camera}
                  />
                  <ToggleRow
                    label="Private View"
                    // MQA-036: the bar's eye button toggles contentProtection (whether OTHERS can see the
                    // overlay), not this setting (whether MÉTIS can see your screen). Claiming they are
                    // the same switch is what made the eye button read as a privacy control.
                    desc="Métis won't look at or capture your screen while this is on. Screen questions answer from context only. Separate from the bar's eye button, which controls whether the Métis overlay is visible in a screen share."
                    on={settings.privateView}
                    onChange={(v) => patch({ privateView: v })}
                    disabled={settings.managedKeys.includes('privateView')}
                  />
                </Section>
                <Section title="Screen access" desc="Whether Métis can see your own screen to answer what's in front of you." icon={Eye}>
                  <ToggleRow
                    label="Let Métis see your screen on request"
                    desc="Governs the explicit screen asks: the Capture button, its shortcut, quick actions, and pressing Enter with an empty box. Typed questions never capture your screen."
                    on={settings.screenAsk}
                    onChange={(v) => patch({ screenAsk: v })}
                    disabled={settings.managedKeys.includes('screenAsk')}
                    icon={Eye}
                  />
                </Section>
                <Section
                  title="Conversation memory"
                  desc="Whether a new question you type remembers the previous questions and answers."
                  icon={MessageSquare}
                >
                  <ToggleRow
                    label="Carry context into follow-up questions"
                    desc="When on, the next question can refer back to the last few answers (expires after 10 idle minutes). When off (default), every question outside a meeting starts completely fresh. Nothing from the previous question leaks into the next answer. During a live meeting, Copilot always keeps the meeting's context either way."
                    on={settings.askFollowUpMemory}
                    onChange={(v) => patch({ askFollowUpMemory: v })}
                    disabled={settings.managedKeys.includes('askFollowUpMemory')}
                  />
                </Section>
                <Section
                  title="Recording consent"
                  desc="This reminder is shown to YOU, the operator. It does not notify or ask the other participants. Métis has no way to show anything to the other people on the call; getting their consent is on you, by whatever means your company policy or local law requires (verbal notice, a calendar invite disclosure, etc.)."
                  icon={ShieldCheck}
                >
                  <ToggleRow
                    label="I will inform participants before recording"
                    desc="Your acknowledgement that you follow your company's policy and the law when recording. Revocable here."
                    on={settings.recordingConsent}
                    onChange={(v) => patch({ recordingConsent: v })}
                    disabled={settings.managedKeys.includes('recordingConsent')}
                  />
                  <ToggleRow
                    label="Require consent reminder"
                    desc='Show the "other participants are being recorded" reminder every time Listen starts, instead of a one-time-per-day toast. On by default.'
                    on={settings.requireConsentIndicator}
                    onChange={(v) => patch({ requireConsentIndicator: v })}
                    disabled={settings.managedKeys.includes('requireConsentIndicator')}
                  >
                    <div className="mt-1.5 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                      Useful for regulated environments or when local law requires explicit notice. Note: this
                      also does not distinguish or flag sensitive topics (health, legal, financial) that come up
                      in a recorded call; everything spoken is transcribed and treated the same way.
                    </div>
                  </ToggleRow>
                </Section>
                <Section title="Sensitive data" desc="Keep secrets out of what's sent to AI providers." icon={Lock}>
                  <ToggleRow
                    label="Redact secrets before sending to AI"
                    desc="Strips credit-card numbers, API keys, SSNs, and private keys from the captured transcript before it goes to a cloud model. Your typed questions and the saved transcript are never changed."
                    on={settings.redactSensitive}
                    onChange={(v) => patch({ redactSensitive: v })}
                    disabled={settings.managedKeys.includes('redactSensitive')}
                  >
                    <div className="mt-1.5 text-[11px] leading-snug text-[color:var(--color-danger)]">
                      This only scrubs text. Screenshots sent for screen-based questions are NOT redacted;
                      anything visible on-screen (passwords, IDs, open documents) goes to the provider as-is.
                      Turn on Private View before capturing a screen you don't want sent.
                    </div>
                  </ToggleRow>
                </Section>
                <Section title="Permissions" desc="Status of the OS permissions Métis needs." icon={ShieldCheck}>
                  <PermissionsSection />
                </Section>
                <Section
                  title="Usage"
                  desc="On-device performance and quality from your local audit log. Never leaves this device."
                  icon={FileSearch}
                >
                  <SupportBundleSection />
                </Section>
                <Section
                  title="Operator"
                  desc="Your Métis licence securely connects this device to managed AI. You do not need a personal API key or a shared connection secret."
                  icon={Settings2}
                >
                  <label className="flex flex-col gap-1 px-1 py-2">
                    <span className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">Operator URL</span>
                    <input
                      value={settings.operatorUrl || ''}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={DEFAULT_OPERATOR_URL}
                      disabled={settings.managedKeys.includes('operatorUrl')}
                      onChange={(e) => patch({ operatorUrl: e.target.value.trim() })}
                      className={`${ctl} w-full`}
                    />
                    <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                      Leave empty to use {DEFAULT_OPERATOR_URL}. Changing this address disconnects your licence; activate it again for the new service. Only change it when instructed by your administrator.
                    </span>
                  </label>
                  <details className="px-1 py-2">
                    <summary className="text-[11px] text-[color:var(--cl-muted-foreground)]">Legacy administrator connection</summary>
                    <label className="mt-2 flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">Legacy ingest secret</span>
                    <input
                      type="password"
                      value={operatorSecretDraft}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={settings.operatorLegacyCredentialConfigured ? 'Connection saved. Enter a replacement to change it.' : 'Administrator-provided secret (not needed with a licence)'}
                      disabled={operatorSecretSaving || settings.managedKeys.includes('operatorIngestSecret')}
                      onChange={(e) => setOperatorSecretDraft(e.target.value)}
                      className={`${ctl} w-full`}
                    />
                    </label>
                    <button type="button" className={`${primaryBtnStyle} mt-2`}
                      disabled={!operatorSecretDraft.trim() || operatorSecretSaving || settings.managedKeys.includes('operatorIngestSecret')}
                      onClick={() => void saveOperatorSecret()}>{operatorSecretSaving ? 'Saving…' : 'Save connection'}</button>
                    {operatorSecretError && <p role="alert" className="mt-1 text-[11px] text-[color:var(--cl-destructive)]">{operatorSecretError}</p>}
                  </details>
                  <p className="px-1 py-2 text-[11px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
                    Operator telemetry sends only operational metadata: event types, status, timing and usage counts,
                    plus device and license health. Content is not included in telemetry. Provider inference and user-approved
                    destination writes are separate.
                  </p>
                  {operatorUrlConfigured(settings) && (
                    <button
                      type="button"
                      onClick={() => void window.toto.operatorOpen()}
                      className="no-drag cl-focus mt-1 flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]"
                    >
                      <ExternalLink size={12} /> Open Operator
                    </button>
                  )}
                  {operatorUrlConfigured(settings) && <OperatorLicenseCard refreshSettings={refreshSettings} />}
                </Section>
              </div>
            )}

            {tab === 'meetings' && (
              <>
              <Section
                title="Meetings & transcripts"
                desc="Meetings are saved here as notes your Dust agents can read."
                icon={FolderOpen}
              >
                <div className="cl-card px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={15} className="shrink-0 text-[color:var(--cl-primary)]" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]" title={settings.resolvedMeetingsFolder}>
                      {settings.resolvedMeetingsFolder}
                    </span>
                    <ManagedChip keys={settings.managedKeys} k="meetingsFolder" />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={settings.managedKeys.includes('meetingsFolder')}
                      onClick={async () => {
                        await window.toto.pickFolder()
                        void patch({})
                      }}
                      className={[
                        'no-drag cl-focus flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]',
                        settings.managedKeys.includes('meetingsFolder') ? 'opacity-60 cursor-not-allowed' : ''
                      ].join(' ')}
                    >
                      <FolderCog size={12} /> Change folder
                    </button>
                    <button
                      type="button"
                      disabled={settings.managedKeys.includes('meetingsFolder')}
                      onClick={async () => {
                        const result = await window.toto.openMeetingsFolder()
                        setMeetingsFolderErr(result || null)
                      }}
                      className={[
                        'no-drag cl-focus flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]',
                        settings.managedKeys.includes('meetingsFolder') ? 'opacity-60 cursor-not-allowed' : ''
                      ].join(' ')}
                    >
                      <FolderOpen size={12} /> Open
                    </button>
                  </div>
                  {meetingsFolderErr && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
                      <AlertCircle size={12} className="shrink-0" /> {meetingsFolderErr}
                    </div>
                  )}
                </div>
                {/* Team transcripts — shared folders whose meetings are ALSO ingested into this brain,
                    attributed by folder name (settings.teamTranscriptFolders). Centralizes the team's calls
                    without touching where the user's OWN meetings are saved. */}
                <div className="cl-card mt-2 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={15} className="shrink-0 text-[color:var(--cl-primary)]" />
                    <span className="min-w-0 flex-1 text-[12px] text-[color:var(--cl-foreground)]">Team transcripts</span>
                    <ManagedChip keys={settings.managedKeys} k="teamTranscriptFolders" />
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                    Shared folders whose meeting transcripts also feed this brain, attributed by folder name. Point one at a teammate&apos;s synced meetings folder to centralize the team&apos;s calls automatically.
                  </p>
                  {(settings.teamTranscriptFolders ?? []).length > 0 && (
                    <div className="mt-2 flex flex-col gap-1">
                      {(settings.teamTranscriptFolders ?? []).map((folder) => (
                        <div key={folder} className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2 py-1.5">
                          <FolderOpen size={12} className="shrink-0 text-[color:var(--cl-muted-foreground)]" />
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]" title={folder}>
                            {folder}
                          </span>
                          <button
                            type="button"
                            disabled={settings.managedKeys.includes('teamTranscriptFolders')}
                            onClick={async () => {
                              await window.toto.removeTeamTranscriptFolder(folder)
                              void patch({})
                            }}
                            title="Stop ingesting this folder"
                            className="no-drag cl-focus rounded-md p-1 text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.08] hover:text-[color:var(--cl-foreground)] disabled:opacity-60"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-2">
                    <button
                      type="button"
                      disabled={settings.managedKeys.includes('teamTranscriptFolders')}
                      onClick={async () => {
                        await window.toto.addTeamTranscriptFolder()
                        void patch({})
                      }}
                      className={[
                        'no-drag cl-focus flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]',
                        settings.managedKeys.includes('teamTranscriptFolders') ? 'opacity-60 cursor-not-allowed' : ''
                      ].join(' ')}
                    >
                      <FolderCog size={12} /> Add shared folder
                    </button>
                  </div>
                </div>
                <div className="mt-2">
                  <div className="rounded-lg bg-white/[0.03] px-3 py-2">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-[color:var(--cl-foreground)]">
                      <Check size={14} className="text-[var(--color-accent-text)]" />
                      Meetings are always saved
                    </div>
                    <div className="mt-0.5 text-[12px] leading-snug text-[color:var(--cl-muted-foreground)]">
                      Every meeting&rsquo;s transcript and notes are written to the folder above when it ends.
                      Remove any you don&rsquo;t want from History.
                    </div>
                  </div>
                  {!settings.encryptTranscripts && (
                    <div className="mt-1 flex items-start gap-1.5 px-1 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
                      <AlertCircle size={12} className="mt-0.5 shrink-0" />
                      Transcripts are saved as plain text in your chosen folder. If that folder syncs to the
                      cloud, your data leaves this device.
                    </div>
                  )}
                  <ToggleRow
                    label="Encrypt transcripts at rest"
                    desc={`Locks saved transcripts/notes with ${isWindows ? 'the Windows credential store' : 'your macOS Keychain'} so they're unreadable on disk. On by default. Métis's own History, search, and follow-up drafting still work normally; only a separate tool reading the raw files directly (outside Métis) would be blocked.`}
                    on={settings.encryptTranscripts}
                    onChange={(v) => patch({ encryptTranscripts: v })}
                    disabled={settings.managedKeys.includes('encryptTranscripts')}
                  >
                    {settings.encryptTranscripts && (
                      <div className="mt-1 flex items-start gap-1.5 px-1 text-[11px] leading-snug text-[color:var(--cl-success)]">
                        <CircleCheck size={12} className="mt-0.5 shrink-0" />
                        Encrypted at rest. Even if the folder syncs to the cloud, contents stay locked to
                        this device. Opening a transcript shows a temporary decrypted copy.
                      </div>
                    )}
                  </ToggleRow>
                  <ToggleRow
                    label="Launch at login"
                    desc="Open Métis automatically when you sign in."
                    on={settings.launchAtLogin}
                    onChange={(v) => patch({ launchAtLogin: v })}
                    disabled={settings.managedKeys.includes('launchAtLogin')}
                  />
                </div>
              </Section>
              <DangerZoneSection settings={settings} patch={patch} />
              </>
            )}

            {tab === 'intelligence' && (
              <IntelligenceTab
                settings={settings}
                patch={patch}
                onOpenIntelligence={onOpenIntelligence}
                onOpenHistory={onOpenHistory}
                onOpenMeeting={onOpenMeeting}
              />
            )}

            {tab === 'calendar' && (
              <CalendarTab settings={settings} patch={patch} />
            )}

            {tab === 'profile' && (
              <div className="flex flex-col gap-6">
                <OperatorLicenseCard refreshSettings={refreshSettings} showIdentity />
                <Section title="About you" desc="Used for interview and sales modes. The more detail, the better the answers." icon={User}>
                  <ProfileEditor
                    profile={settings.profile}
                    onChange={(p) => patch({ profile: p })}
                    disabled={settings.managedKeys.includes('profile')}
                  />
                </Section>
                {/* License activation follows the profile — the last setup step once you're set up as you.
                    OFF for phase 1 (LICENSE_UI_ENABLED); the section + LicenseSection component stay in
                    source and reappear here the moment the flag flips. */}
                {LICENSE_UI_ENABLED && (
                  <Section title="License" desc="Activate Métis against your organization's license server." icon={ShieldCheck}>
                    <LicenseSection settings={settings} patch={patch} />
                  </Section>
                )}
                {/* Keybinds live with Profile: both are "how Métis is set up for you". */}
                <Section title="Keyboard shortcuts" desc="Click any keybind below to edit it." icon={Settings2}>
                  <Shortcuts settings={settings} patch={patch} />
                </Section>
              </div>
            )}

            {tab === 'about' && (
              // Everything in About is centered: the story, the thanks, and the footer.
              <div className="flex flex-col gap-6 text-center">
                {/* Microsoft sign-in is in Calendar, the license is in Profile, and permissions + usage
                    moved to Privacy. About is the story — plus the update check, which lives here so
                    every build (including ones that can't auto-install) can still discover a release. */}
                <UpdatesSection />
                <DiagnosticsSection />
                <Section title="Why “Métis”" desc="The name is the mission." icon={Sparkles}>
                  <div className="flex flex-col items-center gap-2 pb-1 text-center">
                    <MetisMark size={76} />
                    <p className="text-[12px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
                      Métis is the Greek goddess of cunning, wisdom, and prudence, Zeus&apos;s first
                      counselor and the mother of Athena. She&apos;s a fascinating figure because she
                      stands for a very particular kind of intelligence: not just &ldquo;being
                      intelligent,&rdquo; but knowing how to see what&apos;s coming, adapt, maneuver, and
                      choose exactly the right moment. That&apos;s the job of this app. It listens with
                      you, reads the room, and puts the right words within reach at the moment you need
                      them.
                    </p>
                  </div>
                </Section>
                <Section title="Thanks" desc="Métis got better because people believed in it early." icon={CircleCheck}>
                  <p className="text-[12px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
                    To{' '}
                    <a
                      href="https://www.linkedin.com/in/marc-bisiou-1a79ba78/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="no-drag font-medium text-[color:var(--cl-primary)] transition-colors hover:underline"
                    >
                      Marc Bisiou
                    </a>
                    , patient zero: the first to test every build, and generous with the feedback and
                    support that shaped this app.
                  </p>
                  <p className="mt-2.5 text-[12px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
                    And to{' '}
                    <a
                      href="https://www.linkedin.com/in/berichard/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="no-drag font-medium text-[color:var(--cl-primary)] transition-colors hover:underline"
                    >
                      Benjamin Richard
                    </a>
                    {' '}and{' '}
                    <a
                      href="https://www.linkedin.com/in/yanezsondagur/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="no-drag font-medium text-[color:var(--cl-primary)] transition-colors hover:underline"
                    >
                      Yanez Sondagur
                    </a>
                    , for the support and belief that made this possible.
                  </p>
                </Section>
                {/* Model/library license attributions live in THIRD_PARTY_NOTICES.md, shipped in the
                    app's install directory (electron-builder extraFiles) — kept out of the UI on
                    purpose (the owner, 2026-07-05). */}
                <div className="flex flex-col items-center gap-2.5 pb-2 pt-4">
                  <MantuLogo size={190} />
                  <div className="text-[13px] font-semibold text-[color:var(--cl-foreground)]">
                    Métis {appPackage.version} · Mantu
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
                    <a
                      href="https://www.mantu.com/legal/privacy-policy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="transition-colors hover:text-[color:var(--cl-foreground)]"
                    >
                      Privacy
                    </a>
                    <span aria-hidden>·</span>
                    <a
                      href="https://www.mantu.com/legal/data-handling"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="transition-colors hover:text-[color:var(--cl-foreground)]"
                    >
                      Data handling
                    </a>
                    {METIS_FEEDBACK_EMAIL ? (
                      <>
                        <span aria-hidden>·</span>
                        <a
                          href={`mailto:${METIS_FEEDBACK_EMAIL}`}
                          className="transition-colors hover:text-[color:var(--cl-foreground)]"
                        >
                          Support
                        </a>
                        <span aria-hidden>·</span>
                        <a
                          href={`mailto:${METIS_FEEDBACK_EMAIL}?subject=M%C3%A9tis%20feedback`}
                          className="transition-colors hover:text-[color:var(--cl-foreground)]"
                        >
                          Send feedback
                        </a>
                      </>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                    Built at Mantu
                  </div>
                </div>
              </div>
            )}
        </div>
        </TabIconContext.Provider>
      </main>

      {/* Footer — secondary actions left, Done right */}
      <footer className="cl-footer flex h-14 shrink-0 items-center gap-2 rounded-b-2xl px-4">
        {replayState.error ? (
          <p role="alert" className="m-0 mr-1 max-w-[250px] text-[11px] leading-snug text-[color:var(--cl-destructive)]">
            {replayState.error}
          </p>
        ) : null}
        <button
          type="button"
          // Act 6 (Ready, MQA-283): "Replay onboarding" — re-arms the SAME gate App.tsx checks
          // (`!settings.onboardingDone`), so the very next render remounts the six-act experience fresh
          // from hero, exactly like a first run. Nothing else is touched: no other setting is cleared.
          // The invoke must settle before main replaces this transparent BrowserWindow with the opaque
          // onboarding stage. `onboardingEnter` is deliberately a one-way IPC after that durable write.
          onClick={() => void replayOnboarding()}
          disabled={replayState.busy}
          className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-border)] bg-white/[0.03] px-3 py-2 text-[12px] text-[color:var(--cl-foreground)] transition-colors hover:border-[var(--cl-input)] hover:bg-white/[0.08] disabled:opacity-60"
        >
          <RotateCcw size={13} className="shrink-0 text-[color:var(--cl-muted-foreground)]" />
          {replayState.busy ? 'Starting setup…' : 'Replay onboarding'}
        </button>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const choice = await navigationGuard.request({
                title: 'Log out of Métis?',
                message: "You'll need to sign in again to use Dust and your Mantu Microsoft account.",
                saveLabel: 'Log out',
                discardLabel: 'Stay signed in',
                cancelLabel: 'Cancel',
                destructive: true
              })
              if (choice === 'save') onLogout ? onLogout() : void window.toto.signOut()
            })()
          }}
          className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-border)] bg-white/[0.03] px-3 py-2 text-[12px] text-[color:var(--cl-foreground)] transition-colors hover:border-[var(--cl-input)] hover:bg-white/[0.08]"
        >
          <X size={13} className="shrink-0 text-[color:var(--cl-muted-foreground)]" />
          Log out
        </button>
        <button
          type="button"
          onClick={() => (onQuit ? onQuit() : void window.toto.quit())}
          className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/5 px-3 py-2 text-[12px] text-[color:var(--cl-destructive)] transition-colors hover:bg-[var(--cl-destructive)]/15"
        >
          <X size={13} className="shrink-0" />
          Quit
        </button>
        <button
          type="button"
          onClick={onClose}
          className="no-drag cl-focus ml-auto rounded-[10px] bg-[var(--cl-primary)] px-5 py-2 text-[13px] font-semibold text-white hover:opacity-90"
        >
          Done
        </button>
      </footer>
    </div>
  )
}


// Last recent-meetings list fetched this session — reused on remount so revisiting this tab shows the
// prior list instantly instead of flashing "Loading…" again, while the effect below still refreshes it.
let lastMeetings: MeetingSummary[] | null = null

/**
 * Mantu Intelligence tab — everything "what my meetings know" in one place: the Intelligence dashboard
 * (graphs), the knowledge-graph builder, and the recent meetings history with follow-up entry points.
 * Navigation is delegated to the parent (BrainView / History / a meeting's Review are top-level views).
 */
/**
 * Time saved — the durable lifetime figure, plus the transparent assumption editor. The estimate is
 * recomputed live as the user drags the sliders, so the number is visibly THEIRS: they can see exactly
 * what write-up-per-meeting assumption produces it. Honest by construction — an "≈", the word "estimate",
 * and every input on screen. A managed/locked `timeSaved` key disables the editor (org policy wins), like
 * every other locked setting.
 */
function TimeSavedSettings({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const a = settings.timeSaved
  const saved = timeSavedFromTotals(settings.usageStats, a)
  const locked = settings.managedKeys?.includes('timeSaved') ?? false
  const setAssumption = (next: Partial<typeof a>): void => patch({ timeSaved: { ...a, ...next } })
  const NumberRow = ({
    label,
    value,
    min,
    max,
    step,
    suffix,
    onChange
  }: {
    label: string
    value: number
    min: number
    max: number
    step: number
    suffix: string
    onChange: (v: number) => void
  }): JSX.Element => (
    <label className="flex items-center justify-between gap-3 py-1">
      <span className="text-[12px] text-[color:var(--cl-foreground)]">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={locked}
          onChange={(e) => onChange(Number(e.target.value))}
          className="no-drag h-1 w-32 cursor-pointer accent-[var(--cl-primary)] disabled:cursor-not-allowed"
        />
        <span className="w-14 shrink-0 text-right text-[12px] tabular-nums text-[color:var(--cl-muted-foreground)]">
          {value}
          {suffix}
        </span>
      </span>
    </label>
  )
  return (
    <Section
      title="Time saved"
      desc="An honest estimate of work Métis finished: notes, second-brain captures, email recaps, and pushes you confirmed. Adjust the meeting-note assumption below. The number is yours."
      icon={Timer}
    >
      <TimeSavedView meetingWriteupMinutes={saved.savedMinutes} meetingCount={saved.meetings} />
      <div className="cl-card px-3.5 py-3">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[color:var(--cl-muted-foreground)]">
          Meeting-note assumption
        </div>
        {saved.meetings === 0 ? (
          <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
            Summarize your first meeting and the write-up estimate shows up here.
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-0.5">
              <NumberRow
                label="Write-up time, as % of the meeting"
                value={Math.round(a.writeupRatio * 100)}
                min={0}
                max={60}
                step={5}
                suffix="%"
                onChange={(v) => setAssumption({ writeupRatio: v / 100 })}
              />
              <NumberRow
                label="Minimum credited per meeting"
                value={a.floorMin}
                min={0}
                max={30}
                step={1}
                suffix=" min"
                onChange={(v) => setAssumption({ floorMin: v })}
              />
              <NumberRow
                label="Maximum credited per meeting"
                value={a.capMin}
                min={5}
                max={90}
                step={5}
                suffix=" min"
                onChange={(v) => setAssumption({ capMin: v })}
              />
            </div>
            <div className="mt-2 text-[10.5px] text-[color:var(--cl-muted-foreground)]">
              Currently crediting ~{saved.perMeetingAvgMin} min of write-up avoided per meeting. This is an
              estimate, not a measured figure.{locked ? ' Managed by your organization.' : ''}
            </div>
          </>
        )}
      </div>
    </Section>
  )
}

function IntelligenceTab({
  settings,
  patch,
  onOpenIntelligence,
  onOpenHistory,
  onOpenMeeting
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  onOpenIntelligence?: () => void
  onOpenHistory?: () => void
  onOpenMeeting?: (file: string) => void
}): JSX.Element {
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(lastMeetings)
  useEffect(() => {
    let alive = true
    void window.toto.recallList().then((list) => {
      if (alive) {
        setMeetings(list)
        lastMeetings = list
      }
    })
    return () => {
      alive = false
    }
  }, [])
  const recent = (meetings ?? []).slice(0, 6)
  // MeetingSummary.date is an ISO stamp — render it as a short human date ("Jun 30"), not a log line.
  const shortDate = (iso: string): string => {
    const d = new Date(iso)
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Mantu Intelligence"
        desc="Your meeting brain: dashboards and graphs built from every meeting Métis has captured, covering pipeline, people, deals going cold, and the week's Mars draft."
      >
        <div className="cl-card flex items-center gap-3 px-3 py-3">
          <MantuMark size={34} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Intelligence dashboard</div>
            <div className="truncate text-[11px] text-[color:var(--cl-muted-foreground)]">
              Graphs and insights from {meetings === null ? 'your' : meetings.length} indexed meeting{meetings !== null && meetings.length === 1 ? '' : 's'}.
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenIntelligence}
            disabled={!onOpenIntelligence}
            className="no-drag cl-focus flex shrink-0 items-center gap-1.5 rounded-[10px] bg-[var(--cl-primary)] px-3 py-2 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <ExternalLink size={13} /> Open
          </button>
        </div>
      </Section>

      <TimeSavedSettings settings={settings} patch={patch} />

      <Section
        title="Meetings & follow-up"
        desc="Recent meeting history. Open one to review its recap, transcript, and generate a follow-up."
        icon={FolderOpen}
      >
        <div className="flex flex-col gap-1.5">
          {meetings === null ? (
            <div className="cl-card px-3 py-2.5">
              <AgentStatus kind="searching" size="inline" caption />
            </div>
          ) : recent.length === 0 ? (
            <div className="cl-card px-3 py-2.5 text-[12px] text-[color:var(--cl-muted-foreground)]">
              No meetings saved yet. They appear here as soon as one ends.
            </div>
          ) : (
            recent.map((m) => (
              <button
                key={m.file}
                type="button"
                onClick={() => onOpenMeeting?.(m.file)}
                disabled={!onOpenMeeting}
                className="no-drag cl-focus cl-card flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06] disabled:opacity-60"
              >
                {m.locked ? (
                  <Lock
                    size={14}
                    className="shrink-0 text-[color:var(--cl-muted-foreground)]"
                    aria-label="Encrypted, can't be opened on this device"
                  />
                ) : (
                  <FileText size={14} className="shrink-0 text-[color:var(--color-accent-text)]" />
                )}
                <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]">{m.title}</span>
                {/* Locked: a real encrypted meeting that couldn't be decrypted on this device — surface it
                    here too (matches RecallView's row) so the click isn't a silent dead end with no cue. */}
                {m.locked && (
                  <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-[color:var(--cl-muted-foreground)]">
                    Locked
                  </span>
                )}
                <span className="shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)]">
                  {shortDate(m.date)}
                  {m.durationMin ? ` · ${m.durationMin} min` : ''}
                </span>
              </button>
            ))
          )}
          <button
            type="button"
            onClick={onOpenHistory}
            disabled={!onOpenHistory}
            className="no-drag cl-focus mt-1 flex items-center justify-center gap-1.5 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-50"
          >
            Open full history
          </button>
        </div>
      </Section>

      <GraphSection settings={settings} patch={patch} />

      <Section
        title="Brain consolidation"
        desc="The Intelligence index runs at 06:00, 12:00, and 18:00 America/Toronto. If Métis was closed at a slot, the next launch catches up. This toggle only batches extra extracts between those named slots. Manual Update Intelligence still runs immediately."
        icon={Cpu}
      >
        <ToggleRow
          label="Batch index (1–2× / day)"
          desc={
            settings.brainConsolidation.enabled
              ? `Named slots stay 06:00, 12:00, and 18:00 America/Toronto. Up to ${settings.brainConsolidation.maxPassesPerDay} extra consolidation pass${settings.brainConsolidation.maxPassesPerDay === 1 ? '' : 'es'} may run between slots. New meetings still save immediately; extracts can wait for the next named pass.`
              : 'Off: each saved meeting is indexed with an LLM extract as soon as it lands (higher token use). The named 06:00 / 12:00 / 18:00 America/Toronto index still runs.'
          }
          on={settings.brainConsolidation.enabled}
          onChange={(v) =>
            patch({ brainConsolidation: { ...settings.brainConsolidation, enabled: v } })
          }
        />
        {settings.brainConsolidation.enabled && (
          <>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[12px] text-[color:var(--cl-foreground)]">Max passes per day</span>
              <select
                className="no-drag cl-focus rounded-lg border border-[var(--cl-input)] bg-white/[0.04] px-2 py-1 text-[12px]"
                value={settings.brainConsolidation.maxPassesPerDay}
                onChange={(e) =>
                  patch({
                    brainConsolidation: {
                      ...settings.brainConsolidation,
                      maxPassesPerDay: Number(e.target.value) as 1 | 2 | 3 | 4
                    }
                  })
                }
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <ToggleRow
              label="Prefer on-device model for consolidation"
              desc="When Métis Local is ready, use it for batch extracts before burning cloud tokens."
              on={settings.brainConsolidation.preferLocal}
              onChange={(v) =>
                patch({ brainConsolidation: { ...settings.brainConsolidation, preferLocal: v } })
              }
            />
          </>
        )}
      </Section>

      <Section
        title="Published wiki (Dust-readable)"
        desc="Mirrors your CRM-corrected brain (account/people/deal pages and meeting note cards) as plain markdown under a wiki/ folder next to your meetings, so Dust and other agents can read it."
        icon={FileText}
      >
        <ToggleRow
          label="Publish meeting intelligence"
          desc={
            settings.encryptTranscripts
              ? 'Publishes readable meeting intelligence to your OneDrive folder, even though transcript encryption stays on. Meetings you flag confidential are always excluded. You will be asked to confirm.'
              : 'Publishes readable meeting intelligence to your OneDrive folder. Meetings you flag confidential are always excluded.'
          }
          on={settings.publishBrainPages}
          onChange={(v) => patch({ publishBrainPages: v })}
        />
        {settings.publishBrainPages && (
          <div className="cl-card mt-2 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <FolderOpen size={15} className="shrink-0 text-[color:var(--cl-primary)]" />
              <span className="min-w-0 flex-1 text-[12px] text-[color:var(--cl-foreground)]">Give Claude your second brain</span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              The published folder includes a <span className="font-medium text-[color:var(--cl-foreground)]">CLAUDE.md</span> entry doc that orients Claude. Point Claude at this folder (add it to a Claude Project, open it in Claude Desktop, or sync it via a connector) and Claude reads your meetings, people, and deals directly and surfaces your next steps. Nothing here is a raw transcript.
            </p>
            <div className="mt-2">
              <button
                type="button"
                onClick={() => void window.toto.openBrainForClaude()}
                className="no-drag cl-focus flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]"
              >
                <FolderOpen size={12} /> Open the folder for Claude
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Polo Pre-Sales"
        desc="Push meeting recaps to your pre-sales CRM. Manual and review-first: nothing sends automatically."
        icon={MessageSquare}
      >
        <McpConnectionCard
          settings={settings}
          patch={patch}
          kind="bidstack"
          defaultLabel="Polo Pre-Sales"
          title="Polo Pre-Sales · your CRM"
          desc="Push meeting recaps to Polo Pre-Sales over its MCP server. Manual and review-first: nothing sends automatically."
          endpointPlaceholder="http://localhost:4001/mcp"
          apiKeyHint="Bearer token from Polo Pre-Sales → Developer access → API keys (mcp + write scope)"
        />
      </Section>

      <Section
        title="Plane"
        desc="Push meeting action items to Plane as work items. See Review → Book next steps. Manual and review-first: nothing sends automatically."
      >
        <PlaneCard settings={settings} patch={patch} />
      </Section>

      <Section
        title="ClickUp"
        desc="Push meeting action items to ClickUp as tasks. See Review → Book next steps. Manual and review-first: nothing sends automatically."
      >
        <ClickupCard settings={settings} patch={patch} />
      </Section>

      <OperatorMcpServersSection />
    </div>
  )
}

/**
 * Read-only list of MCP connections Operator has registered on this seat (coordinator addition to
 * PLAN.md P2.2b #3: hubspot/salesforce/pipedrive/notion/custom-mcp — anything beyond the three kinds
 * the cards above manage locally). Renders nothing when the Operator hasn't delivered any. Rows are
 * informational only: there is nothing to configure here, Operator owns the credential and endpoint.
 */
function OperatorMcpServersSection(): JSX.Element | null {
  const [servers, setServers] = useState<Array<{ id: string; kind: string; label: string; tools: string[] }>>([])
  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void window.toto.operatorStatus().then((status) => {
        if (!cancelled) setServers(status.mcpServers)
      })
    }
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  if (servers.length === 0) return null

  return (
    <Section
      title="Operator-managed connections"
      desc="Delivered by Métis Operator. Credential and endpoint are managed there, not on this device."
      icon={Link2}
    >
      <div className="flex flex-col gap-2">
        {servers.map((s) => (
          <div key={s.id} className="flex flex-col gap-1 rounded-[10px] border border-[var(--cl-border)] bg-white/[0.02] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">{s.label}</span>
              <span className={activePillStyle}>
                <CircleCheck size={12} /> Managed by Operator
              </span>
            </div>
            <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              {s.tools.length > 0 ? `Tools: ${s.tools.join(', ')}` : 'Tools not listed yet.'}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function GraphSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [status, setStatus] = useState<GraphStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [rebuildErr, setRebuildErr] = useState<string | null>(null)
  const refresh = (): void => void window.toto.graphifyStatus().then(setStatus)
  useEffect(refresh, [settings.graphifyEnabled])

  const rebuild = async (): Promise<void> => {
    setBusy(true)
    setRebuildErr(null)
    try {
      setStatus(await window.toto.graphifyRebuild())
    } catch (e) {
      // e.g. the SSO session expired between opening Settings and clicking Rebuild — without this catch,
      // the rejection propagates past setBusy(false) and the button stays disabled/spinning forever.
      setRebuildErr(e instanceof Error ? e.message : 'Could not rebuild the graph.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Knowledge graph"
      desc="See how your meetings, people, and topics connect. Uses your existing Claude or Claude Code sign-in, so there is no extra key to add."
      icon={Network}
    >
      <ToggleRow
        label="Build a knowledge graph of my notes"
        desc="Links the people, deals, and topics across your saved meetings. Connections show up in Meeting history (the network icon on each note)."
        on={settings.graphifyEnabled}
        onChange={(v) => patch({ graphifyEnabled: v })}
      />
      {settings.graphifyEnabled && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="cl-card flex items-center gap-2 px-3 py-2.5 text-[12px]">
            <Network
              size={15}
              className={status?.installed ? 'text-[color:var(--cl-primary)]' : 'text-[color:var(--cl-muted-foreground)]'}
            />
            {!status ? (
              <AgentStatus kind="loading" size="inline" caption />
            ) : !status.installed ? (
              <span className="text-[color:var(--cl-muted-foreground)]">
                The optional knowledge-graph tool is not installed. Install graphifyy explicitly, then reopen Settings.
              </span>
            ) : !status.backend ? (
              <span className="text-[color:var(--cl-muted-foreground)]">
                Connect Claude Code, or add a Claude or OpenAI key in Settings, AI tab, to build the graph.
              </span>
            ) : status.error && !status.hasGraph ? (
              <span className="text-[color:var(--color-danger)]">{status.error}</span>
            ) : status.building || busy ? (
              'Building the graph…'
            ) : status.hasGraph ? (
              <span className="text-[color:var(--cl-foreground)]">
                {status.nodes ?? 0} nodes · {status.edges ?? 0} links
              </span>
            ) : (
              <span className="text-[color:var(--cl-muted-foreground)]">No graph yet. Select Rebuild now to create one.</span>
            )}
          </div>
          <ToggleRow
            label="Auto-rebuild after each note"
            desc="Refresh the graph automatically (incremental) when a meeting or note is saved."
            on={settings.graphifyAutoRebuild}
            onChange={(v) => patch({ graphifyAutoRebuild: v })}
          />
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[12px] text-[color:var(--cl-muted-foreground)]">Engine</span>
            <select
              value={settings.graphifyBackend}
              onChange={(e) => patch({ graphifyBackend: e.target.value as 'auto' | 'claude' | 'openai' })}
              aria-label="Graphify engine"
              className={'flex-1 ' + ctl}
            >
              <option value="auto">Auto · Claude Code, then your Claude or OpenAI key</option>
              <option value="claude">Claude · uses your Anthropic key</option>
              <option value="openai">OpenAI · uses your OpenAI key</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={rebuild}
              disabled={busy || status?.building || !status?.installed || !status?.backend}
              className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] bg-[var(--cl-primary)] px-3 py-2 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy || status?.building ? <InlineOrb kind="loading" /> : <RefreshCw size={13} />} Rebuild now
            </button>
            {status?.hasGraph && (
              <button
                type="button"
                onClick={() => void window.toto.graphifyOpenGraph()}
                className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08]"
              >
                <ExternalLink size={13} /> Open graph
              </button>
            )}
          </div>
          {rebuildErr && (
            <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-danger)]">
              <AlertCircle size={12} /> {rebuildErr}
            </div>
          )}
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

function LicenseSection({
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



const SHORTCUT_LABELS: Record<HotkeyAction, string> = {
  ask: 'Ask (global)',
  hide: 'Show / hide',
  capture: 'Capture screen',
  factcheck: 'Fact-check',
  'toggle-listen': 'Toggle Listen',
  'metis-command': 'Summon Métis command',
  reset: 'New / reset',
  whatnext: 'What to say next',
  explain: 'Explain',
  summarize: 'Summarize screen',
  'spotlight-ref': 'Spotlight Ref',
  'scroll-up': 'Move up',
  'scroll-down': 'Move down',
  'scroll-left': 'Move left',
  'scroll-right': 'Move right',
  settings: 'Open settings',
  agenda: "Today's agenda" // tray-only action; not listed in HOTKEY_ACTIONS so it renders no shortcut row
}

type ShortcutGroup = 'General' | 'Window'

const SHORTCUT_GROUPS: Record<HotkeyAction, ShortcutGroup> = {
  ask: 'General',
  hide: 'General',
  reset: 'General',
  settings: 'General',
  'toggle-listen': 'General',
  'metis-command': 'General',
  capture: 'General',
  factcheck: 'General',
  whatnext: 'General',
  explain: 'General',
  summarize: 'General',
  'spotlight-ref': 'General',
  'scroll-up': 'Window',
  'scroll-down': 'Window',
  'scroll-left': 'Window',
  'scroll-right': 'Window',
  agenda: 'General'
}

const SHORTCUT_ICONS: Partial<Record<HotkeyAction, LucideIcon>> = {
  ask: MessageSquare,
  hide: Eye,
  reset: RotateCcw,
  settings: Settings2,
  'toggle-listen': Mic,
  capture: Camera,
  factcheck: CircleCheck,
  whatnext: MessageSquareQuote,
  explain: Lightbulb,
  summarize: AlignLeft,
  'spotlight-ref': FileSearch,
  'scroll-up': ArrowUp,
  'scroll-down': ArrowDown,
  'scroll-left': ArrowLeft,
  'scroll-right': ArrowRight
}


// Maps a KeyboardEvent key value to the Electron accelerator token.
// Lone modifiers, PrintScreen, etc. are not valid as the main key.
const LONE_MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock'])

function keyEventToAccelerator(e: React.KeyboardEvent<HTMLInputElement>): string | null {
  const key = e.key
  if (LONE_MODIFIERS.has(key)) return null // lone modifier — not a complete combo

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  // Must have at least one modifier — bare keys would conflict with typing
  if (parts.length === 0) return null

  // Normalise the main key to Electron accelerator notation
  let main = key
  if (key === ' ') main = 'Space'
  else if (key === 'Enter') main = 'Return'
  else if (key === 'ArrowUp') main = 'Up'
  else if (key === 'ArrowDown') main = 'Down'
  else if (key === 'ArrowLeft') main = 'Left'
  else if (key === 'ArrowRight') main = 'Right'
  else if (key === 'Escape') main = 'Escape'
  else if (key === 'Backspace') main = 'Backspace'
  else if (key === 'Delete') main = 'Delete'
  else if (key.length === 1) main = key.toUpperCase() // A-Z, 0-9, punctuation
  // Function keys (F1-F24), PageUp/PageDown, Home, End, Insert — pass through as-is

  parts.push(main)
  return parts.join('+')
}

function KeyChips({ accelerator }: { accelerator: string }): JSX.Element {
  if (!accelerator) {
    return <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">Click to record</span>
  }
  const parts = displayAccelerator(accelerator).split('+')
  return (
    <span className="flex flex-wrap items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center rounded border border-[var(--cl-border)] bg-[var(--cl-card)] px-1.5 text-[11px] font-medium text-[color:var(--cl-foreground)]">
          {part}
        </span>
      ))}
    </span>
  )
}

function KeyRecorder({
  value,
  onChange
}: {
  value: string
  // Returns a conflict message to display inline (and block the change) or null once the accelerator
  // was accepted and committed.
  onChange: (v: string) => string | null
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [conflictMsg, setConflictMsg] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // True when recording ended by keypress (cancel or commit) rather than because focus had already moved
  // away. The input unmounts either way, so without this focus falls to <body> and a keyboard user restarts
  // from the top of a nine-tab Settings panel.
  const returnFocus = useRef(false)

  // Auto-focus the capture input when recording starts; hand focus back to the row's trigger when a
  // keypress ends it, so the keyboard user stays where they were.
  useEffect(() => {
    if (recording) {
      inputRef.current?.focus()
      return
    }
    if (!returnFocus.current) return
    returnFocus.current = false
    triggerRef.current?.focus()
  }, [recording])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Tab stays sequential-focus navigation. Cancelling it here made the recorder a keyboard trap
    // (WCAG 2.1.2, No Keyboard Trap): Tab did nothing, and Shift+Tab did not escape but RECORDED, binding
    // reverse-tab as an OS-global hotkey. Let the browser move focus — the resulting blur ends recording.
    if (e.key === 'Tab') return
    e.preventDefault()
    // Escape is the advertised way out (the hint under the field says so), so it stops here. Left to bubble
    // it also reaches App's window-level Escape handler, which closes the entire Settings panel — an exit
    // that throws away the user's place is not an exit.
    e.stopPropagation()
    if (e.key === 'Escape') {
      returnFocus.current = true
      setRecording(false)
      setPreview(null)
      setConflictMsg(null)
      return
    }
    const acc = keyEventToAccelerator(e)
    if (acc === null) {
      setPreview(null)
      return
    }
    const err = onChange(acc)
    if (err) {
      // Blocked by a collision with another action's binding — stay in recording mode so the user can
      // immediately try a different combination, and name what it collided with.
      setPreview(acc)
      setConflictMsg(err)
      return
    }
    setConflictMsg(null)
    setPreview(acc)
    setTimeout(() => {
      returnFocus.current = true
      setRecording(false)
      setPreview(null)
    }, 120)
  }

  const onBlur = (): void => {
    // Focus has already gone somewhere the user chose (Tab, or a click) — pulling it back to the trigger
    // would fight them.
    returnFocus.current = false
    setRecording(false)
    setPreview(null)
    setConflictMsg(null)
  }

  if (recording) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={preview !== null ? displayAccelerator(preview) : 'Recording… press keys'}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          title="Press your desired key combination"
          className="no-drag cl-input font-ui min-w-0 flex-1 cursor-pointer select-none px-2 py-1 text-[12px] border-[var(--cl-primary)] bg-[var(--cl-primary-soft)] text-[color:var(--cl-primary)] outline-none ring-1 ring-[var(--cl-primary)] transition-colors"
        />
        <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
          Press Esc to cancel · Tab to move on
        </span>
        {conflictMsg && (
          <span className="text-[11px] text-[color:var(--cl-destructive)]">{conflictMsg}</span>
        )}
      </div>
    )
  }

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setRecording(true)}
      title="Click then press your desired key combination"
      className="no-drag cl-focus cl-input min-w-0 flex-1 cursor-pointer px-2 py-1 text-left transition-colors hover:bg-white/[0.04]"
    >
      <KeyChips accelerator={value} />
    </button>
  )
}

function Shortcuts({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const user = settings.shortcuts ?? {}
  // Bindings main could NOT register globally (another app or the OS already owns the combo — Electron
  // fails silently, so without this the row looks bound but the key does nothing). Keyed on
  // settings.shortcuts rather than a manual refetch-after-save: patch() only updates settings once the
  // settingsSet handler has already re-run registerShortcuts(), so this effect fires on mount AND after
  // every save, always reading the post-registration failure list.
  const [failures, setFailures] = useState<ShortcutFailure[]>([])
  useEffect(() => {
    let cancelled = false
    void window.toto.getShortcutFailures().then((f) => {
      if (!cancelled) setFailures(f)
    })
    return () => {
      cancelled = true
    }
  }, [settings.shortcuts])
  const reset = (action: HotkeyAction): void => {
    const next = { ...user }
    next[action] = DEFAULT_SHORTCUTS[action] ?? ''
    patch({ shortcuts: next })
  }
  // An action's currently-resolved binding — its own override, or the shipped default.
  const resolvedShortcut = (a: HotkeyAction): string => user[a] ?? DEFAULT_SHORTCUTS[a] ?? ''
  // Rebinding one action must never silently steal another's hotkey (Electron's registerShortcuts()
  // just rebinds duplicates to whichever registers last, with no error), so validate against every
  // other action's resolved binding before committing. Returns a conflict message to surface inline
  // (and blocks the save) instead of committing, or null once the value is safely persisted.
  const set = (action: HotkeyAction, value: string): string | null => {
    if (value) {
      const other = HOTKEY_ACTIONS.find((a) => a !== action && resolvedShortcut(a) === value)
      if (other) return `Already used by ${SHORTCUT_LABELS[other]}.`
    }
    patch({ shortcuts: { ...user, [action]: value } })
    return null
  }

  const groups: ShortcutGroup[] = ['General', 'Window']

  return (
    <div className="flex flex-col gap-4">
      {failures.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/5 px-3 py-2.5">
          <div className="flex items-start gap-1.5 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
            <AlertCircle size={13} className="mt-px shrink-0" />
            <span>
              {failures.length === 1 ? "This shortcut couldn't" : "These shortcuts couldn't"} be
              registered. Either another app already owns the combo, or it is a navigation key Métis will
              not take over globally. Rebind {failures.length === 1 ? 'it' : 'them'} below.
            </span>
          </div>
          {failures.map((f) => (
            <div key={f.action} className="flex items-center gap-2 pl-5 text-[11px] text-[color:var(--cl-muted-foreground)]">
              <span className="min-w-[110px]">{SHORTCUT_LABELS[f.action as HotkeyAction] ?? f.action}</span>
              <KeyChips accelerator={f.accel} />
            </div>
          ))}
        </div>
      )}
      {groups.map((group) => {
        const actions = HOTKEY_ACTIONS.filter((a) => SHORTCUT_GROUPS[a] === group)
        if (actions.length === 0) return null
        return (
          <div key={group} className="flex flex-col gap-1">
            <div className="cl-eyebrow mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--cl-muted-foreground)]">
              {group}
            </div>
            {actions.map((action) => {
              const current = user[action] ?? DEFAULT_SHORTCUTS[action] ?? ''
              const isDefault = current === (DEFAULT_SHORTCUTS[action] ?? '')
              const Icon = SHORTCUT_ICONS[action]
              return (
                <div key={action} className="flex items-center justify-between gap-3 px-1 py-1.5 text-[13px]">
                  <span className="flex min-w-[140px] items-center gap-1.5 text-[12px] text-[color:var(--cl-muted-foreground)]">
                    {Icon && <Icon size={14} className="shrink-0" />}
                    {SHORTCUT_LABELS[action]}
                  </span>
                  <div className="flex flex-1 items-center gap-2">
                    <KeyRecorder value={current} onChange={(v) => set(action, v)} />
                    <button
                      type="button"
                      onClick={() => set(action, '')}
                      className="no-drag cl-focus rounded-md px-2 py-1 text-[11px] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] hover:text-[color:var(--cl-foreground)]"
                    >
                      Clear
                    </button>
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => reset(action)}
                        className="no-drag cl-focus rounded-md px-2 py-1 text-[11px] text-[color:var(--cl-primary)] hover:bg-white/[0.06]"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
      <div className="text-[11px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
        Click a shortcut field and press your desired key combination. Changes apply immediately.
      </div>
    </div>
  )
}

function ProfileEditor({
  profile,
  onChange,
  disabled = false
}: {
  profile: Profile
  onChange: (p: Profile) => void
  disabled?: boolean
}): JSX.Element {
  const set = (k: keyof Profile, v: string): void => {
    if (disabled) return
    onChange({ ...profile, [k]: v })
  }
  const inputCls = [ctl, disabled ? 'opacity-60' : ''].join(' ')
  const nameId = useId()
  const roleId = useId()
  const companyId = useId()
  const jdId = useId()
  const resumeId = useId()
  const notesId = useId()
  return (
    <div className={['flex flex-col gap-2', disabled ? 'opacity-80' : ''].join(' ')}>
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={nameId} className="sr-only">Name</label>
          <LazyInput id={nameId} disabled={disabled} className={inputCls} placeholder="Name" value={profile.name} onCommit={(v) => set('name', v)} />
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={roleId} className="sr-only">Role</label>
          <LazyInput id={roleId} disabled={disabled} className={inputCls} placeholder="Role" value={profile.role} onCommit={(v) => set('role', v)} />
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={companyId} className="sr-only">Company</label>
          <LazyInput id={companyId} disabled={disabled} className={inputCls} placeholder="Company" value={profile.company} onCommit={(v) => set('company', v)} />
        </div>
      </div>
      <label htmlFor={jdId} className="sr-only">Job description</label>
      <LazyTextarea
        id={jdId}
        disabled={disabled}
        className={inputCls + ' h-16 w-full resize-none'}
        placeholder="Job description (paste the posting)…"
        value={profile.jobDescription}
        onCommit={(v) => set('jobDescription', v)}
      />
      <label htmlFor={resumeId} className="sr-only">Background / résumé</label>
      <LazyTextarea
        id={resumeId}
        disabled={disabled}
        className={inputCls + ' h-20 w-full resize-none'}
        placeholder="Your background / résumé…"
        value={profile.resume}
        onCommit={(v) => set('resume', v)}
      />
      <label htmlFor={notesId} className="sr-only">Notes</label>
      <LazyTextarea
        id={notesId}
        disabled={disabled}
        className={inputCls + ' h-12 w-full resize-none'}
        placeholder="Anything else Métis should know…"
        value={profile.notes}
        onCommit={(v) => set('notes', v)}
      />
      <div className="flex items-center gap-1.5 px-1 text-[11px] text-[color:var(--cl-muted-foreground)]">
        <Sparkles size={11} className="text-[color:var(--cl-primary)]" />
        Paste your résumé and the job post for better interview answers.
      </div>
    </div>
  )
}
