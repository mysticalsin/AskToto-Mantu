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
import appPackage from '../../../../../package.json'
import type { NavigationGuardService } from '../../lib/navigation-guard'
import { TapControlCard } from '../../components/TapCalibration'
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
  Bell,
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
  type DustAgent,
  DUST_BASE_AGENT_ID,
  type ConversationMode,
  type BuiltinMode,
  type CustomMode,
  type AuthStatus,
  type GraphStatus,
  type HotkeyAction,
  type EvalMetrics,
  type MeetingSummary,
  type ShortcutFailure,
  type LocalModelSummary,
  type PlatformPermissions,
  type UpdateCheckResult,
  type McpConnectionKind,
  type LicenseStatusResult,
  type ScreenCaptureCheckResult,
  type PreservedBrainIndexCopy
} from '@shared/ipc'
import { nextScreenCheckPass } from '@shared/screen-capture-check'
import { bundleFailureUserMessage, isRepairRequiredBundleMessage, isRetryableBundleMessage } from '@shared/bundle-response'
import {
  PROVIDERS,
  PROVIDER_IDS,
  requiresUserBaseUrl,
  detectProvider,
  parseDustUrl,
  resolveModelTier,
  applyInteractiveGuardrail,
  isDustReady,
  dustStoredAgentMissing,
  type ProviderId
} from '@shared/providers'
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
import {
  DUST_EMPTY_AGENTS_ERROR,
  DUST_WORKSPACE_MISSING_SETUP_ERROR,
  decideDustInstantValidate,
  formatDustConnectedMessage,
  proveDustConnection,
  type DustInstantValidateResult
} from '@shared/dust-validate'
import {
  SETTINGS_CONTENT_SCROLL_CLASS,
  Section,
  TabIconContext,
  ToggleRow,
  ctl,
  managedChipCls,
  settingsScrollClipsOverflowX
} from '../../ui/settings'

declare const __METIS_FEEDBACK_EMAIL__: string

export const METIS_FEEDBACK_EMAIL =
  typeof __METIS_FEEDBACK_EMAIL__ === 'string' ? __METIS_FEEDBACK_EMAIL__.trim() : ''

// Name the OS credential facility the way the user's own OS names it — "Keychain" is macOS-only, and
// telling a Windows user to "restore Keychain access" names something their machine does not have. Two
// constants, not one, because these are genuinely different facilities on Windows: the Dust CLI session
// is read out of Credential Manager (dust-secret-store.ts CredReadW), while the encrypted profile's key
// is wrapped by DPAPI via safeStorage. The profile wording matches main's KeychainKeyRecoveryError.
export const DUST_CREDENTIAL_STORE = isWindows ? 'Windows Credential Manager' : 'Keychain'
export const PROFILE_CREDENTIAL_STORE = isWindows ? 'Windows credential store' : 'Keychain'

// Providers excluded from the generic provider tiles grid + generic "key" Section because they have
// their OWN dedicated setup card instead (dust → DustSetup, claude-cli/codex-cli → CliIntegration).
// Gemini used to be listed here too by mistake — it has no dedicated card, so that made it
// unselectable ANYWHERE in Settings. It's a normal API-key provider like GPT/Grok; removed.
// Métis Local (kind === 'local') is excluded the same way, below, wherever `selectable`/`keyEntrySection`
// is computed — it has its own dedicated LocalAiSection card and is keyless, so it must never render a
// key row or test-key CTA.
export const CLI_PROVIDERS = new Set<ProviderId>(['dust', 'claude-cli', 'codex-cli'])

// Phase 1: license activation is OFF. The LicenseSection component + main-process license code stay in
// source (nothing enforces a license today — licenseGateEnabled defaults off), so this only hides the
// Profile section until we ship licensing. Flip to true to bring the UI back with zero other changes.
export const LICENSE_UI_ENABLED: boolean = false

// asrWebgpuFallbackAt (WebGPU→WASM ASR downgrade marker) is a sibling addition to the settings schema
// not yet reflected in the shared PublicSettings type this file imports. Read/write it through this
// local extension — scoped to Settings.tsx only — so today's type still checks and the note below picks
// up the real field once @shared/ipc catches up, with no edit needed here.
export type SettingsWithAsrWebgpuFallback = PublicSettings & { asrWebgpuFallbackAt?: number | null }

/** Public release page used only when a signed package reports damaged built-in transcription assets. */
export const OFFICIAL_METIS_INSTALLER_URL = 'https://github.com/mysticalsin/Metis-Releases/releases/latest'


/**
 * After disconnecting/removing the active provider, pick another provider that is actually ready
 * (CLI providers need a live connection; the rest need a saved key) so the user is never left on a
 * provider that can't answer. Falls back to Anthropic, which then shows the normal "add a key" prompt.
 * MQA-095: `allowed` is the org data-residency allowlist (null = unrestricted) — a provider outside it
 * is never "ready", because the main process rejects every ask sent to it. Exported for a focused test.
 */
export function pickReadyProvider(
  exclude: ProviderId,
  hasKeys: Record<string, boolean>,
  cliConnected: Record<string, boolean>,
  dustWorkspaceId: string,
  providerModels: Partial<Record<string, string>>,
  allowed: string[] | null
): ProviderId {
  const permitted = (p: ProviderId): boolean => !allowed || allowed.includes(p)
  const ready = PROVIDER_IDS.find((p) => {
    if (p === exclude || !permitted(p)) return false
    if (p === 'dust') return isDustReady(hasKeys, dustWorkspaceId, providerModels)
    return PROVIDERS[p].kind === 'cli' ? !!cliConnected[p] : !!hasKeys[p]
  })
  if (ready) return ready
  // Nothing is ready. Anthropic's "add a key" prompt is the normal landing spot, but when the org
  // excludes it, land on an approved provider instead — otherwise the panel sits on a provider that has
  // no tile in the grid and that every ask then rejects.
  return permitted('anthropic') ? 'anthropic' : (PROVIDER_IDS.find(permitted) ?? 'anthropic')
}

/** The provider Settings nudges the user toward inside "Experience: more models" — an Anthropic key
 *  beats everything, then a configured Dust, then whichever other provider already has a working key
 *  or CLI connection. Drives the small "Best pick" badge on a provider tile. */
export function recommendedProvider(settings: PublicSettings): ProviderId {
  if (settings.hasKeys['anthropic']) return 'anthropic'
  if (isDustReady(settings.hasKeys, settings.dustWorkspaceId, settings.providerModels)) return 'dust'
  // Dust was already conclusively ruled out above — exclude it here so a saved-but-unready Dust key
  // (hasKeys.dust true, workspace/agent not set up) can't fall through and be picked as "ready".
  const ready = PROVIDER_IDS.find((p) =>
    p !== 'dust' && (PROVIDERS[p].kind === 'cli' ? !!settings.cliConnected?.[p] : !!settings.hasKeys[p])
  )
  return ready ?? 'anthropic'
}

/** Friendly name for a routed model in the thinking-mode explainer. Keeps raw model ids out of
 *  user-facing copy — recognized brands by name, everything else as a plain tier word. */
export function prettyModel(m: string, provider: ProviderId, tier: 'base' | 'think' | 'deep'): string {
  if (provider === 'dust') {
    // Dust only has a Base agent + an optional Thinking agent — there is no distinct "deep" agent. The
    // 'deep' tier resolves (resolveModelTier) to the Thinking agent, or Base if none is configured, so
    // it shares the Thinking agent's caption rather than naming a tier that doesn't exist.
    return tier === 'base' ? 'your base agent' : 'your thinking agent'
  }
  if (m) {
    if (/haiku/i.test(m)) return 'Haiku'
    if (/sonnet/i.test(m)) return 'Sonnet'
    if (/opus/i.test(m)) return 'Opus'
    if (/gpt-4o|gpt-4\.1|gpt-5/i.test(m)) return 'GPT'
  }
  return tier === 'think' ? 'the deeper model' : 'the fast model'
}

/**
 * Debounced text field — shows keystrokes instantly but only commits (which persists settings.json to
 * disk over IPC) ~350ms after typing stops, and on blur. Stops every keystroke from hitting disk.
 */
export function useLazyText(
  value: string,
  onCommit: (v: string) => void
): { local: string; onChange: (v: string) => void; onBlur: () => void } {
  const [local, setLocal] = useState(value)
  const last = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    // Sync only on EXTERNAL changes (not our own commits) so in-flight typing isn't reverted.
    if (value !== last.current) {
      last.current = value
      setLocal(value)
    }
  }, [value])
  const commit = (v: string): void => {
    last.current = v
    onCommit(v)
  }
  const onChange = (v: string): void => {
    setLocal(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => commit(v), 350)
  }
  const onBlur = (): void => {
    if (timer.current) clearTimeout(timer.current)
    if (local !== last.current) commit(local)
  }
  return { local, onChange, onBlur }
}

export function LazyTextarea({
  value,
  onCommit,
  className,
  placeholder,
  disabled,
  id,
  rows,
  spellCheck
}: {
  value: string
  onCommit: (v: string) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  rows?: number
  spellCheck?: boolean
}): JSX.Element {
  const { local, onChange, onBlur } = useLazyText(value, onCommit)
  return (
    <textarea
      id={id}
      value={local}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={className}
      rows={rows}
      spellCheck={spellCheck}
    />
  )
}

export function LazyInput({
  value,
  onCommit,
  className,
  placeholder,
  disabled,
  id,
  list,
  'aria-label': ariaLabel
}: {
  value: string
  onCommit: (v: string) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  /** Id of a sibling <datalist> — without it the model fields would lose their suggestion list when
   *  they moved onto this debounced input. */
  list?: string
  'aria-label'?: string
}): JSX.Element {
  const { local, onChange, onBlur } = useLazyText(value, onCommit)
  return (
    <input
      id={id}
      list={list}
      value={local}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={className}
    />
  )
}

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
export function VocabCorrectionsTextarea({
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

export function ManagedChip({ keys, k }: { keys: string[]; k: string }): JSX.Element | null {
  return keys.includes(k) ? <span className={managedChipCls}>Managed by your organization</span> : null
}

/** One selectable provider tile — shared by the always-visible "featured" grid and the collapsed
 *  "Experience: more models" grid, so both stay visually identical. */
export function ProviderTile({
  id,
  active,
  recommended,
  hasKey,
  locked,
  onSelect
}: {
  id: ProviderId
  active: boolean
  recommended: boolean
  hasKey: boolean
  locked: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={locked}
      onClick={onSelect}
      className={[
        'no-drag cl-focus flex min-w-0 w-full flex-col items-start gap-0.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors',
        active
          ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]'
          : 'border-[var(--cl-border)] bg-white/[0.02] hover:bg-white/[0.05]',
        locked ? 'opacity-60 cursor-not-allowed' : ''
      ].join(' ')}
    >
      <span className="flex w-full items-center justify-between gap-1.5">
        <span className="truncate text-[12px] font-medium text-[color:var(--cl-foreground)]">
          {PROVIDERS[id].label}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {recommended && (
            <span className="rounded-full bg-[var(--cl-primary-soft)] px-1.5 py-0 text-[10px] font-medium text-[color:var(--cl-primary)]">
              Best pick
            </span>
          )}
          {hasKey && <Check size={14} className="shrink-0 text-[color:var(--cl-success)]" />}
        </span>
      </span>
      <span className="w-full min-w-0 break-words text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{PROVIDERS[id].blurb}</span>
    </button>
  )
}

/** Like Section, but its body is collapsed behind a details-style toggle — closed on every mount, no
 *  persisted "remember this was open" state. Used for secondary content (e.g. "Experience: more
 *  models") that shouldn't compete with the primary flow for attention. */
export function ExpandableSection({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <section className="flex min-w-0 max-w-full flex-col rounded-[14px] border border-dashed border-[var(--cl-border)] px-4 py-3 transition-colors hover:border-[var(--cl-input)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="no-drag cl-focus flex w-full items-center justify-between gap-2 text-left"
      >
        <div>
          <div className="text-[13px] font-semibold leading-snug text-[color:var(--cl-foreground)]">{title}</div>
          {desc && <div className="mt-1 text-[12px] text-[color:var(--cl-muted-foreground)]">{desc}</div>}
        </div>
        <ChevronDown
          size={14}
          className={[
            'mt-0.5 shrink-0 text-[color:var(--cl-muted-foreground)] transition-transform',
            open ? 'rotate-180' : ''
          ].join(' ')}
        />
      </button>
      {open && <div className="fade-up mt-3 flex flex-col gap-5">{children}</div>}
    </section>
  )
}

/**
 * "Suggest names from your meetings" — one-click seeding of the vocabulary-corrections list from the
 * brain's known people/account names (brain:entityNames). Fetches lazily on first click (not on every
 * Settings open), then shows names not already covered by an existing correction (same `from`, folded to
 * lowercase) or already present byte-identical as a correction's `to`. Clicking a chip appends
 * `<lowercased name> => <Canonical Name>`, respecting the same 100-entry cap the textarea itself enforces.
 */
export function VocabSuggestions({
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

/** Friendly hint for an auto-detected or ambiguous pasted key. Exported for a focused test. */
export function detectHint(
  value: string,
  current: ProviderId,
  allowed: string[] | null
): { kind: 'ok' | 'tip'; text: string } | null {
  const v = value.trim()
  if (!v) return null
  const id = detectProvider(v)
  if (id) {
    // Only promise an auto-switch when one will actually happen: onKeyChange won't switch to a
    // CLI_PROVIDERS member (e.g. gemini has no selectable UI), so don't claim it did.
    if (id === current || CLI_PROVIDERS.has(id)) return { kind: 'ok', text: `Detected ${PROVIDERS[id].label}.` }
    // MQA-095: onKeyChange won't switch to a provider the org blocks either — say so, so the paste
    // isn't silently ignored while this line claims the provider was "Selected automatically."
    if (allowed && !allowed.includes(id))
      return { kind: 'tip', text: `Detected ${PROVIDERS[id].label}, restricted by your organization.` }
    return { kind: 'ok', text: `Detected ${PROVIDERS[id].label}. Selected automatically.` }
  }
  if (/^sk-/.test(v)) {
    return {
      kind: 'tip',
      text: 'This key shape is shared by several providers. Pick the right one in "Experience: more models".'
    }
  }
  return null
}

export function isProfileUnlockError(message: string): boolean {
  return /keychain|encrypted profile|secret.?key/i.test(message)
}


/** Seat Soniox API key for cloud STT (optional; Nova is the default transcript source). */
export function SonioxKeySeat({
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

