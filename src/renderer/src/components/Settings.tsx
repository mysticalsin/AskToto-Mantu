import {
  createContext,
  useCallback,
  useContext,
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
import { TimeSavedView } from './TimeSavedView'
import { autoHideOverlayForLayout } from '@shared/overlay-chrome'
import { OverlayChromePicker } from './OverlayChromePicker'
import { formatResetPhrase } from '@shared/reset-time'
import {
  DEFAULT_SHORTCUTS,
  HOTKEY_ACTIONS,
  BUILTIN_MODE_LABELS,
  MODE_GROUPS,
  modeLabel,
  type PublicSettings,
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
  type ScreenCaptureCheckResult
} from '@shared/ipc'
import { nextScreenCheckPass } from '@shared/screen-capture-check'
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
import { LANGUAGE_OPTIONS } from '@shared/lang-id'
import { MantuLogo } from './MantuLogo'
import { MantuMark } from './MantuMark'
import { ClickUpMark } from './brand/ClickUpMark'
import { PlaneMark } from './brand/PlaneMark'
import { MetisMark } from './MetisMark'
import { IdentitySection } from './IdentitySection'
import { FieldHint, TextButton } from './ui'
import { AgentStatus, InlineOrb } from './AgentStatus'
import { AgendaView } from './AgendaView'
import { usePermissions } from '../state'
import { displayAccelerator, isWindows } from '../lib/keys'
import { decideDustLiveCheck } from '../lib/dust-live-check'
import {
  DUST_EMPTY_AGENTS_ERROR,
  DUST_WORKSPACE_MISSING_SETUP_ERROR,
  decideDustInstantValidate,
  formatDustConnectedMessage,
  proveDustConnection,
  type DustInstantValidateResult
} from '@shared/dust-validate'

// Name the OS credential facility the way the user's own OS names it — "Keychain" is macOS-only, and
// telling a Windows user to "restore Keychain access" names something their machine does not have. Two
// constants, not one, because these are genuinely different facilities on Windows: the Dust CLI session
// is read out of Credential Manager (dust-secret-store.ts CredReadW), while the encrypted profile's key
// is wrapped by DPAPI via safeStorage. The profile wording matches main's KeychainKeyRecoveryError.
const DUST_CREDENTIAL_STORE = isWindows ? 'Windows Credential Manager' : 'Keychain'
const PROFILE_CREDENTIAL_STORE = isWindows ? 'Windows credential store' : 'Keychain'

// Shared control class for inputs + native <select>s. The trailing bits fix a Windows-only bug where a
// native <select> rendered as a blank white box (white text on a white native control) until you clicked
// it to open the popup: `[color-scheme:dark]` makes Chromium paint the native select control dark on
// Windows, and the `[&>option]:…` rules give the dropdown options an explicit dark background + light text
// (Windows renders <option> from its OWN colors, defaulting to white — the app's bg/text don't cascade in).
// The `option` selector only matches <select> children, so plain inputs sharing this class are unaffected.
export const ctl =
  'no-drag font-body cl-input cl-focus px-3 py-2.5 text-[13px] text-[color:var(--cl-foreground)] [color-scheme:dark] [&>option]:bg-[#1A0033] [&>option]:text-white'

// Providers excluded from the generic provider tiles grid + generic "key" Section because they have
// their OWN dedicated setup card instead (dust → DustSetup, claude-cli/codex-cli → CliIntegration).
// Gemini used to be listed here too by mistake — it has no dedicated card, so that made it
// unselectable ANYWHERE in Settings. It's a normal API-key provider like GPT/Grok; removed.
// Métis Local (kind === 'local') is excluded the same way, below, wherever `selectable`/`keyEntrySection`
// is computed — it has its own dedicated LocalAiSection card and is keyless, so it must never render a
// key row or test-key CTA.
const CLI_PROVIDERS = new Set<ProviderId>(['dust', 'claude-cli', 'codex-cli'])

// Phase 1: license activation is OFF. The LicenseSection component + main-process license code stay in
// source (nothing enforces a license today — licenseGateEnabled defaults off), so this only hides the
// Profile section until we ship licensing. Flip to true to bring the UI back with zero other changes.
const LICENSE_UI_ENABLED: boolean = false

// asrWebgpuFallbackAt (WebGPU→WASM ASR downgrade marker) is a sibling addition to the settings schema
// not yet reflected in the shared PublicSettings type this file imports. Read/write it through this
// local extension — scoped to Settings.tsx only — so today's type still checks and the note below picks
// up the real field once @shared/ipc catches up, with no edit needed here.
type SettingsWithAsrWebgpuFallback = PublicSettings & { asrWebgpuFallbackAt?: number | null }


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
function recommendedProvider(settings: PublicSettings): ProviderId {
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
function prettyModel(m: string, provider: ProviderId, tier: 'base' | 'think' | 'deep'): string {
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
function useLazyText(
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

function LazyTextarea({
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

function LazyInput({
  value,
  onCommit,
  className,
  placeholder,
  disabled,
  id,
  list
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
}): JSX.Element {
  const { local, onChange, onBlur } = useLazyText(value, onCommit)
  return (
    <input
      id={id}
      list={list}
      value={local}
      disabled={disabled}
      placeholder={placeholder}
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

const managedChipCls =
  'inline-flex items-center gap-1 rounded-full border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] px-1.5 py-0 text-[10px] font-medium text-[color:var(--cl-primary)]'

function ManagedChip({ keys, k }: { keys: string[]; k: string }): JSX.Element | null {
  return keys.includes(k) ? <span className={managedChipCls}>Managed by your organization</span> : null
}

// Lets a Section pick up its enclosing tab's icon automatically (Settings wraps each tab's content in a
// Provider) so most cards get sensible iconography for free; an explicit `icon` prop on a Section still
// wins, for the cards that want a more specific glyph than their tab's.
const TabIconContext = createContext<LucideIcon | ComponentType<{ size?: number }> | undefined>(undefined)

export function Section({
  title,
  desc,
  icon,
  children
}: {
  title: string
  desc?: string
  icon?: LucideIcon | ComponentType<{ size?: number }>
  children: ReactNode
}): JSX.Element {
  const tabIcon = useContext(TabIconContext)
  const Icon = icon ?? tabIcon
  return (
    <section className="cl-card flex flex-col gap-0 px-4 py-4">
      <div className="mb-3 flex items-start gap-2.5">
        {Icon && (
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--cl-primary-soft)] text-[color:var(--cl-primary)]">
            <Icon size={13} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-snug text-[color:var(--cl-foreground)]">{title}</div>
          {desc && (
            <div className="mt-1 text-[12px] text-[color:var(--cl-muted-foreground)]">{desc}</div>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

/** One selectable provider tile — shared by the always-visible "featured" grid and the collapsed
 *  "Experience: more models" grid, so both stay visually identical. */
function ProviderTile({
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
        'no-drag cl-focus flex flex-col items-start gap-0.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors',
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
      <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{PROVIDERS[id].blurb}</span>
    </button>
  )
}

/** Like Section, but its body is collapsed behind a details-style toggle — closed on every mount, no
 *  persisted "remember this was open" state. Used for secondary content (e.g. "Experience: more
 *  models") that shouldn't compete with the primary flow for attention. */
function ExpandableSection({
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
    <section className="flex flex-col rounded-[14px] border border-dashed border-[var(--cl-border)] px-4 py-3 transition-colors hover:border-[var(--cl-input)]">
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

function Toggle({
  id,
  on,
  onChange,
  label,
  disabled = false
}: {
  id?: string
  on: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        if (disabled) return
        e.stopPropagation()
        onChange(!on)
      }}
      className={[
        'no-drag cl-focus relative h-[24px] w-[42px] shrink-0 rounded-full transition-colors duration-[var(--duration-hover)]',
        on ? 'bg-[var(--cl-primary)]' : 'bg-white/15',
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-[2px] h-[20px] w-[20px] rounded-full bg-white transition-all duration-[var(--duration-hover)]',
          on ? 'left-[20px]' : 'left-[2px]'
        ].join(' ')}
      />
    </button>
  )
}

export function ToggleRow({
  label,
  desc,
  on,
  onChange,
  children,
  disabled = false,
  icon: Icon
}: {
  label: string
  desc: string
  on: boolean
  onChange: (v: boolean) => void
  children?: ReactNode
  disabled?: boolean
  icon?: LucideIcon
}): JSX.Element {
  const id = useId()
  const toggleId = `${id}-toggle`
  return (
    <label
      htmlFor={toggleId}
      className={[
        'no-drag flex w-full items-center justify-between gap-3 rounded-[var(--cl-radius)] px-1 py-2 text-left',
        disabled ? 'cursor-default' : 'cursor-pointer'
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
          {Icon && <Icon size={14} className="shrink-0 text-[color:var(--cl-muted-foreground)]" />}
          {label}
          {desc && (
            <FieldHint text={desc}>
              <Info size={12} className="shrink-0 text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]" />
            </FieldHint>
          )}
          {disabled && <span className={managedChipCls}>Managed by your organization</span>}
        </div>
        {children}
      </div>
      <Toggle id={toggleId} on={on} onChange={onChange} label={label} disabled={disabled} />
    </label>
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

function isProfileUnlockError(message: string): boolean {
  return /keychain|encrypted profile|secret.?key/i.test(message)
}

function AiSection({
  settings,
  patch,
  saveKey,
  recoverEncryptedProfile,
  clearKey,
  testKey
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  saveKey: (provider: ProviderId, k: string) => Promise<void>
  recoverEncryptedProfile: () => Promise<ProfileRecoveryResult>
  clearKey: (provider: ProviderId) => Promise<void>
  testKey: (provider: ProviderId, k: string) => Promise<TestKeyResponse>
}): JSX.Element {
  const provider = settings.provider
  const def = PROVIDERS[provider]
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [recoveryAvailable, setRecoveryAvailable] = useState(false)
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null)
  const [test, setTest] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; message?: string }>({
    status: 'idle'
  })
  // "Custom" and "Cloudflare" have no working provider without a base URL — that field lives inside
  // "Advanced", so start it open whenever one of them is active (and re-open if the user switches TO one
  // later) rather than leaving the one field they actually require hidden behind a collapsed toggle.
  const [adv, setAdv] = useState(requiresUserBaseUrl(provider))
  useEffect(() => {
    if (requiresUserBaseUrl(provider)) setAdv(true)
  }, [provider])
  const [filter, setFilter] = useState('')
  // MQA-261: removing a key is irreversible for the Cloudflare key this build ships, so the trash
  // icon asks once. Reset whenever the active provider changes, so a confirm armed on one tile can
  // never be spent on another.
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null)
  useEffect(() => {
    setConfirmRemove(false)
    setRestoreMsg(null)
  }, [provider])
  const skipClearRef = useRef(false) // don't wipe a freshly-pasted key when detection switches provider
  // Latest `provider` value, readable from inside onSave/onTest's async continuations — those closures
  // capture the provider a save/test was started for, then compare against this ref once the awaited
  // call resolves so a mid-flight provider switch can't attribute a stale result to the wrong tile.
  const providerRef = useRef(provider)
  providerRef.current = provider
  const baseModelName = resolveModelTier(provider, settings.providerModels, settings.providerModelsThinking, 'base')
  // Only used by the Auto caption below, to name the real middle tier (routeTier's 'think' bucket —
  // "heavy" but not "hard" prompts) instead of silently collapsing it into the base/deep story.
  const thinkModelName = resolveModelTier(provider, settings.providerModels, settings.providerModelsThinking, 'think')
  // The real ask flow (main/index.ts) always runs the resolved model through applyInteractiveGuardrail
  // before calling the provider — e.g. claude-cli is pinned to Sonnet for every tier. The caption must
  // show that same guarded result, not the raw tier, or it names a model that never actually answers.
  const guardedBaseModelName = applyInteractiveGuardrail(provider, 'base', baseModelName)
  const deepModelName = resolveModelTier(
    provider,
    settings.providerModels,
    settings.providerModelsThinking,
    'deep',
    settings.providerModelsDeep
  )
  const guardedDeepModelName = applyInteractiveGuardrail(provider, 'deep', deepModelName)
  const guardedThinkModelName = applyInteractiveGuardrail(provider, 'think', thinkModelName)
  const keyInputId = useId()
  const modelInputId = useId()
  const baseUrlInputId = useId()
  const locked = settings.managedKeys.includes('provider')

  useEffect(() => {
    if (skipClearRef.current) {
      skipClearRef.current = false
      return
    }
    setKey('')
    setTest({ status: 'idle' })
  }, [provider])

  // Custom/Cloudflare have nothing to configure without a base URL, and that field lives inside the
  // collapsed Advanced section — without this, picking one shows an empty card until a failed Save
  // surfaces the requirement. Auto-open Advanced so the base-URL field is visible the moment it matters.
  useEffect(() => {
    if (requiresUserBaseUrl(provider)) setAdv(true)
  }, [provider])

  // Auto-detect provider from the key as the user pastes/types.
  const onKeyChange = (value: string): void => {
    setKey(value)
    setTest({ status: 'idle' })
    if (locked) return
    const id = detectProvider(value)
    // MQA-095: honour the same org allowlist the tile grid and the Anthropic row enforce below. Without
    // it, pasting a key whose prefix belongs to a blocked vendor silently activates that vendor, and
    // every later ask is rejected from a state no tile in this panel represents.
    const allowed = settings.allowedProviders
    if (id && id !== provider && !CLI_PROVIDERS.has(id) && (!allowed || allowed.includes(id))) {
      skipClearRef.current = true // keep the key we just captured across the provider switch
      patch({ provider: id })
    }
  }

  const onSave = async (): Promise<void> => {
    const trimmed = key.trim()
    // Capture which provider this save/test run is for — the user can switch provider tiles while the
    // awaits below are in flight, and a stale resolve must never paint its result on the new tile.
    const testedProvider = provider
    if (!trimmed) {
      // Empty input must never delete the stored key; removal is the trash-can (onRemove) button only.
      setTest({ status: 'error', message: 'Paste a key above to save it.' })
      return
    }
    try {
      await saveKey(provider, trimmed)
    } catch (e) {
      // e.g. OS encryption unavailable — store.setApiKey throws; don't fail silently.
      const message = e instanceof Error ? e.message : 'Could not save the key.'
      if (providerRef.current === testedProvider) {
        setTest({ status: 'error', message })
        setRecoveryAvailable(isProfileUnlockError(message))
      }
      return
    }
    if (providerRef.current !== testedProvider) return // switched away mid-save; key still saved, just no stale UI update
    setRecoveryAvailable(false)
    setRecoveryMessage(null)
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
    // Auto-verify the key right after saving so the user immediately sees whether it actually works —
    // no separate "Test" click. The ✓/✗ status renders below.
    setTest({ status: 'loading' })
    try {
      const res = await testKey(provider, trimmed)
      if (providerRef.current !== testedProvider) return
      if (res.ok) setTest({ status: 'ok', message: 'Key is valid and working.' })
      else setTest({ status: 'error', message: res.error || 'Saved, but the key did not work. Check it and re-save.' })
    } catch (e) {
      if (providerRef.current === testedProvider) {
        setTest({ status: 'error', message: e instanceof Error ? e.message : 'Saved, but could not verify the key.' })
      }
      return
    }
    setKey('')
  }

  const recoverProfileAndRetry = async (): Promise<void> => {
    setRecoveryBusy(true)
    setRecoveryMessage(null)
    try {
      const result = await recoverEncryptedProfile()
      if (!result.ok) {
        setRecoveryMessage(result.canceled ? 'Recovery canceled. Your encrypted profile was not changed.' : result.error || 'Could not create a new local profile.')
        return
      }
      setRecoveryAvailable(false)
      setTest({ status: 'idle' })
      await onSave()
    } catch (e) {
      setRecoveryMessage(e instanceof Error ? e.message : 'Could not create a new local profile.')
    } finally {
      setRecoveryBusy(false)
    }
  }

  const onTest = async (): Promise<void> => {
    const trimmed = key.trim()
    const testedProvider = provider // see onSave — guards against a stale resolve after a provider switch
    // MQA-060: an empty box means "test the key I already saved" (main falls back to the stored key). Only
    // block when there is neither a pasted key NOR a saved one — otherwise the Test button was a dead end
    // for the exact case it exists for: checking whether the key already in use still works.
    if (!trimmed && !settings.hasKeys[provider]) {
      setTest({ status: 'error', message: 'Paste a key above, or save one first, to test it.' })
      return
    }
    setTest({ status: 'loading' })
    const res = await testKey(provider, trimmed)
    if (providerRef.current !== testedProvider) return
    if (res.ok) setTest({ status: 'ok', message: 'Key is valid.' })
    else setTest({ status: 'error', message: res.error || 'Key test failed.' })
  }

  const onRemove = async (): Promise<void> => {
    await clearKey(provider)
    setKey('')
    setTest({ status: 'idle' })
    // Removed the active provider's key — fall back to one that can still answer.
    await patch({
      provider: pickReadyProvider(
        provider,
        settings.hasKeys,
        settings.cliConnected ?? {},
        settings.dustWorkspaceId,
        settings.providerModels,
        settings.allowedProviders
      )
    })
  }

  // MQA-261: the key this build shipped with, put back. Offered only when the bundle exists AND no key
  // is stored — restoring over a key the user chose would be the overwrite the seed marker exists to stop.
  const canRestoreEmbedded =
    provider === 'cloudflare' && settings.embeddedCloudflareKeyAvailable && !settings.hasKeys.cloudflare
  const onRestoreEmbedded = async (): Promise<void> => {
    setRestoreMsg(null)
    const res = await window.toto.restoreEmbeddedCloudflareKey()
    if (!res.ok) {
      setRestoreMsg(res.error || 'Could not restore the key that shipped with this build.')
      return
    }
    setRestoreMsg('Restored. Cloudflare is ready again.')
    setTest({ status: 'idle' })
    await patch({ provider: 'cloudflare' })
  }

  const hint = detectHint(key, provider, settings.allowedProviders)
  const q = filter.trim().toLowerCase()
  // Dust + CLI providers have dedicated UI sections; Anthropic has its own always-visible card below;
  // Métis Local (kind === 'local') has its own dedicated LocalAiSection card, rendered separately below —
  // exclude all three from the generic tiles grid. The remainder splits by `tier`: 'featured' (GPT, Grok,
  // Kimi, Gemini) gets its own always-visible grid right under Anthropic's card, matching the CLI
  // cards' prominence; 'more' (Qwen, OpenRouter, Groq, Mistral, Grok, Gemini, Dust, custom) stays tucked
  // in the collapsed "Experience: more models" section. Cloudflare is 'featured' and is the default
  // provider: it is the one card most installs must touch, because the Worker URL ships preset and the
  // METIS_PROXY_KEY is the single string a user pastes.
  // When the org sets a data-residency allowlist, only approved providers are offered — mirroring what
  // the main process enforces at request time, so the UI can't offer a provider every ask would reject.
  const orgAllowed = settings.allowedProviders
  const selectable = PROVIDER_IDS.filter(
    (id) =>
      !CLI_PROVIDERS.has(id) &&
      id !== 'anthropic' &&
      PROVIDERS[id].kind !== 'local' &&
      (!orgAllowed || orgAllowed.includes(id))
  )
  const featured = selectable.filter((id) => PROVIDERS[id].tier === 'featured')
  const shown = selectable.filter(
    (id) => PROVIDERS[id].tier === 'more' && (!q || PROVIDERS[id].label.toLowerCase().includes(q))
  )
  // The always-visible Anthropic quick-select card below isn't covered by the `shown` filter above (it's
  // excluded from the grid on purpose) — gate it here too so an org allowlist that omits 'anthropic' can't
  // be bypassed via this separate control. Independent from `locked` (managedKeys.includes('provider')).
  const anthropicAllowed = !orgAllowed || orgAllowed.includes('anthropic')
  const recommended = recommendedProvider(settings)
  const isFeatured = featured.includes(provider)

  // The "{provider} key" card — shown for whichever raw provider is currently active. Rendered at the
  // top level when that's Anthropic or a featured provider (the primary flows), or inside "Experience:
  // more models" otherwise. null for CLI providers (Dust/Claude Code/Codex have their own dedicated
  // cards, no generic key box) and for Métis Local (keyless — its dedicated card never offers one either).
  // An env-var key always wins over an in-app one (getApiKey() resolves the env value first) — a pasted
  // key here would silently never be used until the env var is removed. Lock the field instead of letting
  // Save claim it's "valid and working" for a key that will never actually be read.
  const envKeyActive = settings.envKeys.includes(provider)
  const keyEntrySection = !CLI_PROVIDERS.has(provider) && PROVIDERS[provider].kind !== 'local' ? (
    <Section title={`${def.label} key`} desc="Stored encrypted on this device. Never sent anywhere except the provider." icon={Lock}>
      <div className="flex items-center gap-2">
        <label htmlFor={keyInputId} className="sr-only">
          {def.label} API key
        </label>
        <input
          id={keyInputId}
          type="password"
          value={key}
          disabled={envKeyActive}
          onChange={(e) => onKeyChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && test.status !== 'loading' && onSave()}
          placeholder={
            envKeyActive
              ? 'Set via environment variable, takes precedence over any in-app key'
              : settings.hasKeys[provider]
                ? '•••••• saved (paste to replace)'
                : `Paste your ${def.label} key`
          }
          className={'flex-1 ' + ctl + (envKeyActive ? ' opacity-60' : '')}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={test.status === 'loading' || envKeyActive}
          className="no-drag cl-focus flex items-center gap-1 rounded-[10px] bg-[var(--cl-primary)] px-4 py-2.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saved ? <Check size={14} /> : null}
          {saved ? 'Saved' : 'Save'}
        </button>
        {/* MQA-060: Test can only ever check the key in the box above — the stored secret is never sent
            back to the renderer, so with an empty box this button could only produce "Paste a key above
            to test it.". Disable it there and say why in the tooltip, instead of offering a "verify my
            key" affordance in the one state where it is guaranteed to fail. */}
        <button
          type="button"
          onClick={onTest}
          disabled={test.status === 'loading' || envKeyActive || !key.trim()}
          title={
            !key.trim() && !envKeyActive
              ? settings.hasKeys[provider]
                ? 'The saved key is never shown here, so it can’t be re-tested. Paste a key to test it.'
                : 'Paste a key above to test it.'
              : undefined
          }
          className="no-drag cl-focus flex items-center gap-1 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2.5 text-[13px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-50"
        >
          {test.status === 'loading' ? <InlineOrb kind="connecting" /> : null}
          Test
        </button>
        {envKeyActive ? (
          <span
            title="This key is set via an environment variable on this machine. Remove it where it was defined; the in-app Remove can't clear it."
            className="flex items-center rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2.5 text-[12px] text-[color:var(--cl-muted-foreground)]"
          >
            Set via environment variable
          </span>
        ) : settings.hasKeys[provider] ? (
          confirmRemove ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setConfirmRemove(false)
                  void onRemove()
                }}
                className="no-drag cl-focus flex items-center rounded-[10px] border border-[var(--cl-destructive)]/40 bg-[var(--cl-destructive)]/20 px-3 py-2.5 text-[12px] font-medium text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/30"
              >
                Remove key
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                className="no-drag cl-focus flex items-center rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2.5 text-[12px] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.08]"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              title="Remove saved key"
              className="no-drag cl-focus flex items-center justify-center rounded-[10px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-3 py-2.5 text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/20"
            >
              <Trash2 size={14} />
            </button>
          )
        ) : canRestoreEmbedded ? (
          <button
            type="button"
            onClick={() => void onRestoreEmbedded()}
            title="Put back the Cloudflare key that shipped with Metis"
            className="no-drag cl-focus flex items-center rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08]"
          >
            Restore shipped key
          </button>
        ) : null}
      </div>

      {/* MQA-261: a fresh install gets a working Cloudflare key nobody typed, so the user has no copy of
          it. Removing it is therefore not like removing a key they pasted — say so before, and offer the
          way back after. */}
      {confirmRemove && provider === 'cloudflare' && settings.embeddedCloudflareKeyAvailable && (
        <div className="mt-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
          This key came with Metis rather than from you, so you have no copy of it. You can put it back
          from this card afterwards.
        </div>
      )}
      {canRestoreEmbedded && (
        <div className="mt-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
          Metis shipped with a Cloudflare key. Restore it to keep Cloudflare answering — or add another
          provider&apos;s API key below.
        </div>
      )}
      {restoreMsg && (
        <div className="mt-2 text-[12px] text-[color:var(--cl-foreground)]">{restoreMsg}</div>
      )}

      {hint && (
        <div
          className={[
            'mt-2 flex items-start gap-1.5 text-[12px]',
            hint.kind === 'ok'
              ? 'text-[color:var(--cl-primary)]'
              : 'text-[color:var(--cl-muted-foreground)]'
          ].join(' ')}
        >
          <Sparkles size={13} /> {hint.text}
        </div>
      )}

      {test.status !== 'idle' && test.status !== 'loading' && (
        <div
          className={[
            'mt-2 flex items-start gap-1.5 text-[12px]',
            test.status === 'ok'
              ? 'text-[color:var(--cl-success)]'
              : 'text-[color:var(--cl-destructive)]'
          ].join(' ')}
        >
          {test.status === 'ok' ? <Check size={13} /> : <AlertCircle size={13} />}
          {test.message}
        </div>
      )}

      {recoveryAvailable && (
        <div className="mt-2 flex flex-col gap-2 rounded-[10px] border border-[var(--cl-primary)]/35 bg-[var(--cl-primary-soft)]/40 p-3 text-[12px]">
          <div className="flex items-start gap-1.5 text-[color:var(--cl-foreground)]">
            <ShieldCheck size={13} className="mt-0.5 shrink-0 text-[color:var(--cl-primary)]" />
            <span>
              This install cannot unlock the existing encrypted profile. You can restore {PROFILE_CREDENTIAL_STORE} access
              and try again, or create a fresh local profile while Métis preserves the old encrypted data.
            </span>
          </div>
          <button
            type="button"
            onClick={() => void recoverProfileAndRetry()}
            disabled={recoveryBusy}
            className="no-drag cl-focus inline-flex w-fit items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {recoveryBusy ? <InlineOrb kind="loading" /> : <RotateCcw size={13} />}
            {recoveryBusy ? 'Creating new profile…' : 'Create new local profile & retry'}
          </button>
          {recoveryMessage && <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">{recoveryMessage}</div>}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[12px]">
        <span className="text-[color:var(--cl-muted-foreground)]">
          {settings.hasEncryption
            ? 'Stored encrypted on this device.'
            : 'Stored locally (encryption unavailable).'}
        </span>
        {def.keyUrl && (
          <a
            href={def.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="no-drag inline-flex items-center gap-0.5 text-[color:var(--cl-primary)]"
          >
            Get a key <ExternalLink size={11} />
          </a>
        )}
      </div>

      <button
        type="button"
        onClick={() => setAdv((a) => !a)}
        className="no-drag mt-2 flex items-center gap-1 text-[12px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
      >
        <ChevronDown size={12} className={adv ? 'rotate-180 transition-transform' : 'transition-transform'} />
        Advanced
      </button>
      {adv && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={modelInputId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              Base model · fast, cheap
            </label>
            <div className="flex items-center gap-2">
              {/* MQA-069: debounced like customBaseUrl below. A plain controlled input here commits
                  through the settings IPC round-trip on every keystroke, and the re-render then resets
                  the DOM to the value of an already-resolved earlier patch — fast typing drops
                  characters and persists a garbled model id that every later request 400s on. */}
              <LazyInput
                id={modelInputId}
                list={`m-${provider}`}
                // Bind to the RAW stored value (not baseModelName, which resolves through the provider's
                // fallback default) — same pattern as the Thinking model field below. baseModelName's
                // fallback is right for DISPLAY text elsewhere on this page, but here it would make the
                // field re-populate with the default the instant it's cleared, so backspacing to empty
                // (→ "use default") was never actually possible.
                value={settings.providerModels[provider] ?? ''}
                disabled={provider === 'anthropic' || settings.managedKeys.includes('providerModels')}
                onCommit={(v) => patch({ providerModels: { ...settings.providerModels, [provider]: v } })}
                placeholder={def.fastModel || 'base model id'}
                className={[
                  'flex-1 min-w-0', ctl,
                  provider === 'anthropic' || settings.managedKeys.includes('providerModels') ? 'opacity-60' : ''
                ].join(' ')}
              />
              <ManagedChip keys={settings.managedKeys} k="providerModels" />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`think-${provider}`} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              Thinking model · hard, coding questions
            </label>
            {/* MQA-069: debounced for the same reason as the Base model field above. */}
            <LazyInput
              id={`think-${provider}`}
              list={`m-${provider}`}
              value={settings.providerModelsThinking[provider] ?? ''}
              disabled={provider === 'anthropic' || settings.managedKeys.includes('providerModelsThinking')}
              onCommit={(v) =>
                patch({
                  providerModelsThinking: { ...settings.providerModelsThinking, [provider]: v }
                })
              }
              placeholder={def.thinkModel || def.defaultModel || 'thinking model id'}
              className={[
                'w-full', ctl,
                provider === 'anthropic' || settings.managedKeys.includes('providerModelsThinking') ? 'opacity-60' : ''
              ].join(' ')}
            />
          </div>
          {provider === 'anthropic' && (
            <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              Locked: base always answers as Haiku, thinking as Sonnet, a cost guardrail. Hard/coding
              questions still escalate to Opus automatically; that tier isn't shown here.
            </p>
          )}
          <datalist id={`m-${provider}`}>
            {def.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {provider === 'custom' && (
            <div className="flex items-center gap-2">
              <label htmlFor={baseUrlInputId} className="sr-only">
                Custom endpoint URL
              </label>
              <LazyInput
                id={baseUrlInputId}
                value={settings.customBaseUrl}
                disabled={settings.managedKeys.includes('customBaseUrl')}
                onCommit={(v) => patch({ customBaseUrl: v })}
                placeholder="https://your-endpoint/v1"
                className={['flex-1 min-w-0', ctl, settings.managedKeys.includes('customBaseUrl') ? 'opacity-60' : ''].join(' ')}
              />
              <ManagedChip keys={settings.managedKeys} k="customBaseUrl" />
            </div>
          )}
          {provider === 'cloudflare' && (
            <div className="flex flex-col gap-1">
              <label htmlFor={baseUrlInputId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                Worker endpoint URL
              </label>
              <div className="flex items-center gap-2">
                {/* MQA-069: debounced for the same reason as the model fields above. The placeholder is
                    the hostname cloudflare-proxy/README.md's deploy step actually produces, and keeps the
                    /v1 suffix visible: the OpenAI client appends /chat/completions to whatever is here. */}
                <LazyInput
                  id={baseUrlInputId}
                  value={settings.cloudflareBaseUrl}
                  disabled={settings.managedKeys.includes('cloudflareBaseUrl')}
                  onCommit={(v) => patch({ cloudflareBaseUrl: v })}
                  placeholder="https://metis-cloudflare-proxy.your-subdomain.workers.dev/v1"
                  className={['flex-1 min-w-0', ctl, settings.managedKeys.includes('cloudflareBaseUrl') ? 'opacity-60' : ''].join(' ')}
                />
                <ManagedChip keys={settings.managedKeys} k="cloudflareBaseUrl" />
              </div>
              <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                Your team deploys a small Cloudflare Worker that holds the Cloudflare account token as a
                Wrangler secret; Métis never stores that token. Paste the Worker&rsquo;s URL here and your
                METIS_PROXY_KEY in the key field above.
              </p>
            </div>
          )}
          <label className="flex items-center justify-between gap-3 px-1 text-[12px] text-[color:var(--cl-muted-foreground)]">
            <span className="flex items-center gap-2">
              Creativity · {settings.temperature.toFixed(1)}
              <ManagedChip keys={settings.managedKeys} k="temperature" />
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={settings.temperature}
              disabled={settings.managedKeys.includes('temperature')}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
              className={['no-drag accent-[var(--cl-primary)]', settings.managedKeys.includes('temperature') ? 'opacity-60' : ''].join(' ')}
            />
          </label>
        </div>
      )}
    </Section>
  ) : null

  return (
    <div className="flex flex-col gap-5">
      {/* CLI Integration — Claude Code CLI and Codex CLI, first so auto-setup is the first thing offered */}
      <CliIntegration settings={settings} patch={patch} />

      {/* Dust — Métis's primary brain (your Second Brain agents). Always here, not a tile. This is the
          single, dedicated Dust section — CliIntegration above no longer duplicates it. */}
      <DustSetup
        settings={settings}
        patch={patch}
        saveKey={saveKey}
        recoverEncryptedProfile={recoverEncryptedProfile}
        clearKey={clearKey}
        active={provider === 'dust'}
      />

      {/* Anthropic — the primary, recommended provider. Always visible: a compact summary row here,
          plus its full key card below whenever it's the one currently answering questions. */}
      <div
        className={[
          'flex items-center justify-between gap-2 rounded-[10px] border p-3',
          provider === 'anthropic'
            ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]/40'
            : anthropicAllowed
              ? 'border-[var(--cl-border)] bg-white/[0.02]'
              : 'border-[var(--cl-border)] bg-white/[0.02] opacity-60'
        ].join(' ')}
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">{PROVIDERS.anthropic.label}</span>
          <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            {PROVIDERS.anthropic.blurb}
          </span>
        </div>
        {provider === 'anthropic' && anthropicAllowed ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-primary)]">
            <CircleCheck size={12} /> Active
          </span>
        ) : locked ? (
          <span className={managedChipCls}>Managed by your organization</span>
        ) : !anthropicAllowed ? (
          // Also fires when provider === 'anthropic': an allowlist that no longer includes anthropic
          // (e.g. org tightened it after this was the active default) must not still read "Active" —
          // the active provider was never reconciled against the allowlist (see store.ts getSettings).
          <span className={managedChipCls}>Restricted by your organization</span>
        ) : (
          <button
            type="button"
            onClick={() => patch({ provider: 'anthropic' })}
            className="no-drag cl-focus flex shrink-0 items-center gap-1.5 rounded-[8px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08]"
          >
            Use this
          </button>
        )}
      </div>

      {provider === 'anthropic' && keyEntrySection}

      {/* Métis Local — on-device, keyless, task-scoped (suggest/summary/vision only). Its own dedicated
          card, same prominence as Anthropic/CLI above; never appears in the generic tiles below. */}
      <LocalAiSection settings={settings} patch={patch} />

      {/* Backups & limits — what happens when a provider runs out of tokens/credit (the resilience layer). */}
      <ResilienceSection settings={settings} patch={patch} />

      {/* Featured API providers — same prominence as the CLI cards above, so picking GPT/Grok/Kimi/
          Gemini doesn't require digging into a collapsed section. */}
      <Section title="Other providers" desc="Bring your own key from another provider." icon={Network}>
        <div className="grid grid-cols-2 gap-2">
          {featured.map((id) => (
            <ProviderTile
              key={id}
              id={id}
              active={id === provider}
              recommended={id === recommended}
              hasKey={!!settings.hasKeys[id]}
              locked={locked}
              onSelect={() => patch({ provider: id })}
            />
          ))}
        </div>
        {locked && (
          <div className="mt-2">
            <span className={managedChipCls}>Managed by your organization</span>
          </div>
        )}
      </Section>

      {isFeatured && keyEntrySection}

      <ExpandableSection
        title="Experience: more models"
        desc="More providers, including a raw OpenAI-compatible endpoint. Closed by default; most people find what they need above."
      >
        <Section title="Model provider" desc="Prefer a raw model? Pick one, paste a key, and Métis detects the provider." icon={Cpu}>
          {orgAllowed && (
            <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-[var(--cl-primary-soft)] px-2.5 py-1.5 text-[11px] text-[color:var(--cl-muted-foreground)]">
              <ShieldCheck size={12} className="shrink-0 text-[color:var(--cl-primary)]" />
              Your organization restricts Métis to approved providers.
            </div>
          )}
          {shown.length + featured.length > 8 && (
            <div className="relative mb-2">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--cl-muted-foreground)]"
              />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter providers…"
                className={'w-full pl-7 ' + ctl}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            {shown.map((id) => (
              <ProviderTile
                key={id}
                id={id}
                active={id === provider}
                recommended={id === recommended}
                hasKey={!!settings.hasKeys[id]}
                locked={locked}
                onSelect={() =>
                  // Custom's SettingsSchema refine requires customBaseUrl to already be a valid https://
                  // URL whenever provider === 'custom' (shared/ipc.ts); a bare {provider:'custom'} patch
                  // fails that refine on the full-object re-parse and getSettings()'s repair path silently
                  // reverts provider back to the default. The Base URL field is itself only rendered once
                  // provider === 'custom' is already active, so there is no other way to set a valid URL
                  // first — seed a placeholder together with the provider switch so the write survives.
                  patch(
                    id === 'custom' && !/^https:\/\//i.test(settings.customBaseUrl)
                      ? { provider: id, customBaseUrl: 'https://your-endpoint/v1' }
                      : { provider: id }
                  )
                }
              />
            ))}
          </div>
          {locked && (
            <div className="mt-2">
              <span className={managedChipCls}>Managed by your organization</span>
            </div>
          )}
        </Section>

        {provider !== 'anthropic' && !isFeatured && keyEntrySection}
      </ExpandableSection>

      {/* Thinking mode — applies to whatever's active (raw model tiers, or your two Dust agents) */}
      <Section title="Thinking mode" desc="When to use a fast model vs. a deeper one for harder questions." icon={Lightbulb}>
        <div className="flex gap-1.5">
          {(
            [
              ['auto', 'Auto'],
              ['always', 'Always think'],
              ['never', 'Fast only']
            ] as const
          ).map(([m, label]) => {
            const on = settings.thinkingMode === m
            return (
              <button
                key={m}
                type="button"
                onClick={() => patch({ thinkingMode: m })}
                aria-pressed={on}
                className={[
                  'no-drag cl-focus flex-1 rounded-[8px] border px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                  on
                    ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)] text-[color:var(--cl-foreground)]'
                    : 'border-[var(--cl-border)] bg-white/[0.02] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.05]'
                ].join(' ')}
              >
                {label}
              </button>
            )
          })}
        </div>
        <span className="mt-1.5 block text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          {settings.thinkingMode === 'auto'
            ? // routeTier (shared/routing.ts) actually escalates in 3 steps — base → think ("heavy") → deep
              // ("hard"). Dust collapses think/deep into the same Thinking agent (see prettyModel), so its
              // caption only needs two clauses; raw providers have a real, distinct middle tier to name.
              provider === 'dust'
              ? `Auto: simple questions use ${prettyModel(guardedBaseModelName, provider, 'base')}; anything harder goes to ${prettyModel(guardedDeepModelName, provider, 'deep')}.`
              : `Auto: simple questions use ${prettyModel(guardedBaseModelName, provider, 'base')}; heavier ones use ${prettyModel(guardedThinkModelName, provider, 'think')}; coding, engineering & the hardest go to ${prettyModel(guardedDeepModelName, provider, 'deep')}.`
            : settings.thinkingMode === 'always'
              ? `Every answer uses ${prettyModel(guardedThinkModelName, provider, 'think')} (deep mode).`
              : `Every answer uses ${prettyModel(guardedBaseModelName, provider, 'base')} (fastest & cheapest).`}
        </span>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Métis Local is installer-owned. This card can read readiness and enable routing, but it cannot download,
// replace, or remove the model at runtime.
// ---------------------------------------------------------------------------

/** Human phrase for a currently-demoted provider, from its cooldown reason + reset instant. */
function providerLimitLabel(u: { reason: string; until: number }): string {
  const mins = Math.max(0, Math.round((u.until - Date.now()) / 60000))
  const when =
    mins >= 60
      ? formatResetPhrase(u.until)
      : mins >= 1
        ? `retry in ${mins}m`
        : 'retry shortly'
  switch (u.reason) {
    case 'rate-limit':
      return `rate-limited — ${when}`
    case 'quota-exhausted':
      return 'out of credit — add credit or switch providers'
    case 'usage-cap':
      return `usage limit reached — ${when}`
    default:
      return 'key rejected — re-enter it below'
  }
}

/**
 * Backups & limits — the resilience layer (main/llm/exhaustion.ts + provider-health.ts). Shows any provider
 * currently demoted because it ran out (rate limit / credit / usage-cap) with its reset, and exposes the two
 * routing policies. The on-device answer floor itself is governed by Local AI's "safety net" toggle above,
 * so it is described here but toggled there — one control, not two that can disagree.
 */
function ResilienceSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const limited = settings.unhealthyProviders ?? []
  return (
    <Section
      title="Backups & limits"
      desc="When a provider runs out of tokens or credit, Métis automatically falls back — to a free provider, then to the on-device model — so you are never stuck."
      icon={ShieldCheck}
    >
      <div className="flex flex-col gap-3">
        {/* Wave 2 (docs/PROVIDER-ROUTING-POLICY.md): the top-level policy, separate from Local AI's own
            "use for suggestions/summaries/screenshots" toggles above, which stay how 'auto' picks a mode. */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-[13px] text-[color:var(--cl-foreground)]">
            <Route size={14} className="shrink-0 text-[color:var(--cl-muted-foreground)]" />
            Routing mode
          </div>
          <div className="flex gap-1.5">
            {(
              [
                ['local', 'Local'],
                ['auto', 'Auto'],
                ['api', 'API']
              ] as const
            ).map(([m, label]) => {
              const on = settings.routingMode === m
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => patch({ routingMode: m })}
                  aria-pressed={on}
                  className={[
                    'no-drag cl-focus flex-1 rounded-[8px] border px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                    on
                      ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)] text-[color:var(--cl-foreground)]'
                      : 'border-[var(--cl-border)] bg-white/[0.02] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.05]'
                  ].join(' ')}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            {settings.routingMode === 'local'
              ? 'Prefer Métis Local for every eligible ask (live suggestions, summaries, screenshots) and escalate to your cloud provider only on a hard failure.'
              : settings.routingMode === 'api'
                ? "Use your configured provider / backup order below. The on-device model still answers as the last resort when it's enabled as a safety net and everything else is exhausted."
                : 'Auto (default): health, headroom, free-tier exhaustion and each task\u2019s Local AI toggle below decide, per ask.'}
          </span>
        </div>

        <div className="rounded-[10px] border border-[var(--cl-border)] bg-white/[0.02] p-3">
          {limited.length === 0 ? (
            <div className="flex items-center gap-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
              <CircleCheck size={13} className="shrink-0 text-[color:var(--cl-primary)]" />
              No provider limits hit right now.
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {limited.map((u) => (
                <li key={u.provider} className="flex items-baseline justify-between gap-3 text-[12px]">
                  <span className="text-[color:var(--cl-foreground)]">
                    {PROVIDERS[u.provider as ProviderId]?.label ?? u.provider}
                  </span>
                  <span className="text-[color:var(--cl-muted-foreground)]">{providerLimitLabel(u)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <FallbackOrderEditor settings={settings} patch={patch} />

        <ToggleRow
          label="Prefer a free backup when a paid provider runs out"
          desc="Route to a provider with a free tier (or the on-device model) before another paid one, once the paid primary is spent."
          on={settings.resilience.preferFreeOnExhaustion}
          onChange={(v) => patch({ resilience: { ...settings.resilience, preferFreeOnExhaustion: v } })}
        />

        <ToggleRow
          label="Switch before hitting a limit"
          desc="Read each provider's remaining allowance and move to a backup just before it would be rate-limited, instead of after."
          on={settings.resilience.budgetPreempt}
          onChange={(v) => patch({ resilience: { ...settings.resilience, budgetPreempt: v } })}
        />

        <ToggleRow
          label="Race a backup provider on a slow answer"
          desc="For a quick question, start a second provider if the first hasn't answered within 3 seconds — whichever answers first wins, the other is cancelled. Can occasionally use both."
          on={settings.resilience.hedge}
          onChange={(v) => patch({ resilience: { ...settings.resilience, hedge: v } })}
        />

        <div className="flex items-start gap-2 rounded-[8px] border border-[var(--cl-border)] bg-white/[0.02] px-3 py-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
          <Cpu size={13} className="mt-0.5 shrink-0" />
          <span>
            Worst case, the on-device model answers with no API at all — controlled by <b>Local AI → use as a
            safety net</b> above.
          </span>
        </div>
      </div>
    </Section>
  )
}

/**
 * MQA-269 — the failover order, authored by the user instead of guessed for them.
 *
 * Failover itself has always been automatic and silent on the wire; what did not exist was any way to
 * say WHICH provider gets tried next. providerPriority is a two-value cli/api preference, not an order.
 * This editor writes settings.providerFallbackOrder — and sets the active provider to the chain's head
 * in the same patch, so "first in my chain" and "the provider that answers me" can never disagree.
 *
 * Deliberately up/down buttons, not drag: drag targets in a 44px-row overlay are an accessibility debt
 * for zero gain at a list this size. Only CONFIGURED providers are offered (a chain naming a keyless
 * provider is a chain of dead hops), filtered by the org allowlist for the same reason the tile grid is.
 */
function FallbackOrderEditor({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element | null {
  const allowed = settings.allowedProviders
  const configured = (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => {
    if (allowed && !allowed.includes(p)) return false
    if (PROVIDERS[p].kind === 'cli') return !!settings.cliConnected?.[p]
    if (p === 'local') return settings.localReady
    return !!settings.hasKeys?.[p]
  })
  // A stale chain entry (key since removed, org policy tightened) is display-filtered the same way the
  // router filters it — the stored value is corrected on the next edit rather than silently rewritten.
  const chain = settings.providerFallbackOrder.filter((p) => configured.includes(p))
  const rest = configured.filter((p) => !chain.includes(p))

  if (configured.length < 2) return null // one provider has no order to author

  const commit = (next: ProviderId[]): void => {
    // The chain's head IS the primary — written together so they cannot drift apart. An empty chain
    // returns to automatic ordering and leaves the active provider as the user last set it.
    if (next.length) patch({ providerFallbackOrder: next, provider: next[0] })
    else patch({ providerFallbackOrder: [] })
  }
  const move = (i: number, delta: number): void => {
    const next = [...chain]
    const j = i + delta
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    commit(next)
  }

  return (
    <div className="rounded-[10px] border border-[var(--cl-border)] bg-white/[0.02] p-3">
      <div className="mb-1 text-[12.5px] font-medium text-[color:var(--cl-foreground)]">Failover order</div>
      <div className="mb-2 text-[11.5px] text-[color:var(--cl-muted-foreground)]">
        {chain.length
          ? 'Providers are tried top to bottom when one fails. Anything not listed stays available after the chain.'
          : 'Automatic — Métis picks the next provider itself. Set an order to decide it yourself.'}
      </div>
      {chain.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {chain.map((p, i) => (
            <li key={p} className="flex items-center gap-2 rounded-[8px] border border-[var(--cl-border)] bg-white/[0.02] px-2.5 py-1.5">
              <span className="w-4 text-[11px] tabular-nums text-[color:var(--cl-muted-foreground)]">{i + 1}</span>
              <span className="flex-1 text-[12px] text-[color:var(--cl-foreground)]">{PROVIDERS[p].label}</span>
              <button type="button" aria-label={`Move ${PROVIDERS[p].label} up`} disabled={i === 0} onClick={() => move(i, -1)}
                className="no-drag cl-focus grid h-6 w-6 place-items-center rounded-[6px] border border-[var(--cl-border)] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] disabled:opacity-30">
                <ChevronUp size={12} />
              </button>
              <button type="button" aria-label={`Move ${PROVIDERS[p].label} down`} disabled={i === chain.length - 1} onClick={() => move(i, 1)}
                className="no-drag cl-focus grid h-6 w-6 place-items-center rounded-[6px] border border-[var(--cl-border)] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] disabled:opacity-30">
                <ChevronDown size={12} />
              </button>
              <button type="button" aria-label={`Remove ${PROVIDERS[p].label} from the order`} onClick={() => commit(chain.filter((x) => x !== p))}
                className="no-drag cl-focus grid h-6 w-6 place-items-center rounded-[6px] border border-[var(--cl-border)] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06]">
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rest.map((p) => (
            <button key={p} type="button" onClick={() => commit([...chain, p])}
              className="no-drag cl-focus rounded-[8px] border border-[var(--cl-border)] px-2.5 py-1 text-[11.5px] text-[color:var(--cl-muted-foreground)] hover:border-[var(--cl-primary)] hover:text-[color:var(--cl-foreground)]">
              + {PROVIDERS[p].label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * MQA-247 — the high-accuracy transcription model, offered rather than assumed.
 *
 * The model cannot ship: 1.61 GB on top of a 0.77 GB installer breaches GitHub's 2 GiB per-asset limit.
 * So imports fall back to the bundled floor model, which is materially worse on non-English audio.
 * MQA-246 made that visible; this makes it fixable.
 *
 * The size is stated before the button, not after. Someone on a metered connection is agreeing to a
 * specific number of gigabytes, and a control that reveals the cost only once the transfer has started
 * is not consent.
 */
function AsrModelRow(): JSX.Element | null {
  const [state, setState] = useState<{ status: string; progress: number; error?: string; ready: boolean; bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setState(await window.toto.asrModelState())
    } catch {
      setState(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll only while a transfer is actually running — 1.61 GB takes minutes, and a progress bar that does
  // not move is worse than no progress bar.
  useEffect(() => {
    if (state?.status !== 'downloading') return
    const t = setInterval(() => void refresh(), 700)
    return () => clearInterval(t)
  }, [state?.status, refresh])

  if (!state) return null
  const gb = (state.bytes / 1e9).toFixed(2)

  return (
    <div className="-mt-1 flex items-start justify-between gap-3 pl-1 text-[12px] text-[color:var(--color-ink-3)]">
      <span>
        {state.ready
          ? `High-accuracy transcription model installed (${gb} GB). Imports use it instead of the compact model.`
          : state.status === 'downloading'
            ? `Downloading the high-accuracy transcription model — ${Math.round(state.progress * 100)}% of ${gb} GB.`
            : `Imports use the compact transcription model. The high-accuracy one is a ${gb} GB download — noticeably better, especially on non-English audio.`}
        {state.status === 'error' && state.error ? ` ${state.error}` : ''}
      </span>
      {state.status !== 'downloading' && (
        <TextButton
          onClick={async () => {
            setBusy(true)
            try {
              if (state.ready) await window.toto.asrModelRemove()
              else await window.toto.asrModelFetch()
            } finally {
              setBusy(false)
              void refresh()
            }
          }}
        >
          {busy ? 'Working…' : state.ready ? 'Remove' : `Download ${gb} GB`}
        </TextButton>
      )}
    </div>
  )
}

function LocalAiSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [models, setModels] = useState<LocalModelSummary[] | null>(null)
  const [retrying, setRetrying] = useState(false)
  // The weights are fetched on first run, not shipped, so this list is a moving target: a card opened
  // during onboarding is looking at a download in progress. Poll while one is running OR has not
  // started yet so a late boot fetch (or a fetch that failed before the first read) cannot freeze the
  // card on "Not downloaded yet" (MQA-187).
  useEffect(() => {
    let mounted = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (): void => {
      void window.toto.localModelsList().then(
        (list) => {
          if (!mounted) return
          setModels(list)
          const moving = list.some(
            (m) => m.unavailableReason === 'downloading' || m.unavailableReason === 'not-downloaded'
          )
          if (moving) timer = setTimeout(read, 1500)
        },
        () => {
          if (mounted) {
            setModels([])
            timer = setTimeout(read, 1500)
          }
        }
      )
    }
    read()
    return () => {
      mounted = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  const model =
    models?.find((m) => m.unavailableReason === 'downloading') ??
    models?.find((m) => m.unavailableReason === 'insufficient-disk' || m.unavailableReason === 'download-failed') ??
    models?.find((m) => m.id === settings.localLlm.modelId) ??
    models?.[0]
  const downloading = model?.unavailableReason === 'downloading'
  const canRetry =
    model?.unavailableReason === 'download-failed' ||
    model?.unavailableReason === 'not-downloaded' ||
    model?.unavailableReason === 'insufficient-disk' ||
    model?.unavailableReason === 'insufficient-ram'
  const percent = Math.round((model?.downloadProgress ?? 0) * 100)
  const retryFetch = (): void => {
    if (retrying) return
    setRetrying(true)
    void window.toto
      .localModelsEnsure()
      .catch(() => {})
      .finally(() => {
        setRetrying(false)
        void window.toto.localModelsList().then(setModels, () => {})
      })
  }
  // One wording for the blocked case, used by both the status strip and the card. It names the host that
  // has to be reachable and when Métis tries again. The old copy said the files were "missing or
  // incomplete" and told the user to reinstall Métis — an instruction the build gate guarantees cannot
  // work, because no installer contains the weights (MQA-188/191).
  const downloadFailedText =
    'Could not download the on-device model. Métis retries on the next launch — check that huggingface.co is reachable from this network.'
  const notDownloadedText =
    'Not downloaded yet. Métis fetches the on-device model automatically when the app opens (~730 MB).'

  return (
    <Section
      title="Local AI"
      desc="Optional on-device model. Off by default for answering — Cloudflare and any API keys you add stay primary. The model downloads in the background when Métis opens so enabling Local later is instant."
      icon={Cpu}
    >
      <div className="flex flex-col gap-3">
        <ToggleRow
          label="Enable Métis Local"
          desc="Use the on-device model for suggestions, summaries, and screenshot reads. The weights download automatically when Métis opens (not part of the installer). Cloudflare and your other API providers stay available."
          on={settings.localLlm.enabled}
          onChange={(v) =>
            patch({
              localLlm: {
                ...settings.localLlm,
                enabled: v,
                // Arm the safety net with the opt-in so a just-enabled Local install can still answer
                // when every cloud provider is exhausted.
                ...(v ? { fallback: true } : {})
              }
            })
          }
        />

        <div className="flex items-center gap-2 rounded-[8px] border border-[var(--cl-border)] bg-white/[0.02] px-3 py-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
          <Cpu size={13} className="shrink-0" />
          {models === null
            ? 'Checking the on-device model...'
            : model?.unavailableReason === 'insufficient-ram'
              ? `Unavailable: the on-device model needs at least ${model.minTotalRamGB} GB RAM.`
              : model?.unavailableReason === 'insufficient-disk'
                ? model.downloadError
                  ? `Could not download the on-device model: ${model.downloadError}`
                  : 'Unavailable: not enough free disk space for the on-device model. Free up space and tap Retry.'
              : model?.unavailableReason === 'downloading'
                ? `Downloading the on-device model... ${percent}%`
                : model?.unavailableReason === 'download-failed'
                  ? model.downloadError
                    ? `Could not download the on-device model: ${model.downloadError}`
                    : downloadFailedText
                  : model?.unavailableReason === 'not-downloaded'
                    ? notDownloadedText
                    : !model?.ready
                      ? 'Unavailable: Métis could not read the on-device model status.'
                      : settings.localRuntimeState === 'running'
                        ? `Running: ${model?.label ?? settings.localLlm.modelId}`
                        : settings.localRuntimeState === 'starting'
                          ? 'Starting the on-device model...'
                          : settings.localRuntimeState === 'unavailable'
                            ? 'Unavailable: the on-device model stopped responding this session. Restart Métis to re-enable it.'
                            : 'Ready: starts automatically on the next local request.'}
        </div>

        {models === null ? (
          <div className="flex items-center gap-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
            <AgentStatus kind="loading-model" size="inline" caption />
          </div>
        ) : model ? (
          <div
            className={[
              'flex flex-col gap-2 rounded-[10px] border p-3',
              model.ready
                ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]/40'
                : // A running first-run download is a normal state, not a fault: it must not be dressed
                  // as one while it is working (MQA-187).
                  downloading
                  ? 'border-[var(--cl-border)] bg-white/[0.02]'
                  : 'border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/5'
            ].join(' ')}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">{model.label}</span>
                <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                  Downloaded once on first run. Needs {model.minTotalRamGB} GB RAM.
                </span>
              </div>
              <span
                className={[
                  'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                  model.ready
                    ? 'bg-[var(--cl-primary-soft)] text-[color:var(--cl-primary)]'
                    : downloading
                      ? 'bg-white/[0.06] text-[color:var(--cl-muted-foreground)]'
                      : 'bg-[var(--cl-destructive)]/10 text-[color:var(--cl-destructive)]'
                ].join(' ')}
              >
                {model.ready ? <CircleCheck size={12} /> : downloading ? <InlineOrb kind="loading-model" /> : <AlertCircle size={12} />}
                {model.ready ? 'Ready' : downloading ? `Downloading ${percent}%` : 'Unavailable'}
              </span>
            </div>
            {downloading && (
              <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full rounded-full bg-[var(--cl-primary)] transition-[width] duration-500 ease-out"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
            {!model.ready && !downloading && (
              <p className="text-[11px] leading-snug text-[color:var(--cl-destructive)]">
                {model.unavailableReason === 'insufficient-ram'
                  ? `This model needs at least ${model.minTotalRamGB} GB RAM.`
                  : model.unavailableReason === 'insufficient-disk'
                    ? model.downloadError
                      ? `Could not download the on-device model: ${model.downloadError}`
                      : 'Not enough free disk space for the on-device model. Free up space and tap Retry.'
                  : model.unavailableReason === 'download-failed'
                    ? model.downloadError
                      ? `Could not download the on-device model: ${model.downloadError}`
                      : downloadFailedText
                    : notDownloadedText}
              </p>
            )}
            {canRetry && (
              <TextButton icon={RotateCcw} onClick={retryFetch} disabled={retrying}>
                {retrying ? 'Retrying…' : 'Retry'}
              </TextButton>
            )}
          </div>
        ) : (
          <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
            <AlertCircle size={13} className="mt-px shrink-0" />
            <span>Unavailable: Métis could not read the on-device model status. Restart Métis if this persists.</span>
          </div>
        )}

        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">Use for</span>
          <ToggleRow
            label="Live suggestions"
            desc="What-to-say-next suggestions during a meeting."
            on={settings.localLlm.useFor.suggest}
            onChange={(v) =>
              patch({ localLlm: { ...settings.localLlm, useFor: { ...settings.localLlm.useFor, suggest: v } } })
            }
          />
          <ToggleRow
            label="Summaries"
            desc="Mid-meeting summaries and Mantu Intelligence extraction."
            on={settings.localLlm.useFor.summary}
            onChange={(v) =>
              patch({ localLlm: { ...settings.localLlm, useFor: { ...settings.localLlm.useFor, summary: v } } })
            }
          />
          <ToggleRow
            label="Screenshots"
            desc="Reading what's on your screen."
            on={settings.localLlm.useFor.vision}
            onChange={(v) =>
              patch({ localLlm: { ...settings.localLlm, useFor: { ...settings.localLlm.useFor, vision: v } } })
            }
          />
        </div>

        <div className="flex flex-col gap-0.5 pt-1">
          <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">Fallback</span>
          <ToggleRow
            label="Use as a fallback when cloud AI is unavailable"
            desc="If every configured cloud provider is unreachable or none is set up, run meeting indexing, live suggestions, summaries and screenshot analysis on-device as a last resort — instead of failing. Cloud providers are always preferred when they work."
            on={settings.localLlm.fallback}
            onChange={(v) => patch({ localLlm: { ...settings.localLlm, fallback: v } })}
          />
        </div>

        <div className="flex flex-col gap-0.5">
          <ToggleRow
            label="Speaker identification (beta)"
            desc="Label who's speaking in meetings using on-device voice recognition. Voice data never leaves this device."
            on={settings.speakerId.enabled}
            onChange={(v) => patch({ speakerId: { enabled: v } })}
          />
        </div>
      </div>
    </Section>
  )
}

function StepBadge({ n, done }: { n: number; done?: boolean }): JSX.Element {
  return (
    <span
      className={[
        'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
        done
          ? 'bg-[var(--cl-success)]/20 text-[color:var(--cl-success)]'
          : 'bg-[var(--cl-primary-soft)] text-[color:var(--cl-primary)]'
      ].join(' ')}
    >
      {done ? <CircleCheck size={14} /> : n}
    </span>
  )
}

// ---------------------------------------------------------------------------
// CLI Integration section
// ---------------------------------------------------------------------------

type CliCardState = {
  phase: 'idle' | 'confirming' | 'installing' | 'setup-opened' | 'connecting' | 'done' | 'error' | 'install-error'
  msg: string | null
  version: string | null
}

function CliIntegration({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const provider = settings.provider
  const cliConnected = settings.cliConnected ?? {}
  const locked = settings.managedKeys.includes('provider')
  // Latest `settings.provider`, readable from inside runInstall/connect's async continuations — mirrors
  // AiSection's providerRef guard. Captures the provider when an install/connect starts, then compares
  // once the awaited call resolves, so a completed CLI install/connect can't silently revert an
  // in-panel provider switch the user made on the AiSection grid while it was running.
  const providerRef = useRef(provider)
  providerRef.current = provider
  // Independent of `locked`: an org can restrict the data-residency allowlist (settings.allowedProviders)
  // without also locking the 'provider' managed key. Gate the CLI quick-select cards the same way the
  // provider tiles are gated, so a disallowed provider can't be activated from here either.
  const orgAllowed = settings.allowedProviders
  const isAllowed = (id: ProviderId): boolean => !orgAllowed || orgAllowed.includes(id)

  // Guards every setState below against firing after this component unmounts (e.g. the user closes
  // Settings while runInstall's cliInstall/cliTest awaits are still in flight — those IPC calls keep
  // running to completion in the main process regardless of whether this card is still on screen).
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  // MQA-062: live session check on open, the same rule dust-live-check.ts states for this credential
  // class — "Persisted state can lie: the user may have run `dust logout` … so opening Settings must
  // verify the real session instead of taking 'already connected' for granted." `cliConnected` is
  // written when the user connects and, until the ask path learned to retire it on a rejection, never
  // written back; a `claude logout` in a terminal leaves these cards reading Connected/Active forever.
  // Main does the work (zero-token status probe, throttled, retires only on an explicit negative) and
  // returns the refreshed snapshot, which `patch`-free `onSettings` polling would otherwise deliver late.
  const sessionCheckedRef = useRef(false)
  useEffect(() => {
    if (sessionCheckedRef.current) return
    if (!cliConnected['claude-cli'] && !cliConnected['codex-cli']) return
    sessionCheckedRef.current = true
    void window.toto.cliVerifySessions()
    // Once per mount, for the already-connected case only — connect/disconnect handle the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Per-CLI card state
  const [claudeState, setClaudeState] = useState<CliCardState>({ phase: 'idle', msg: null, version: null })
  const [codexState, setCodexState] = useState<CliCardState>({ phase: 'idle', msg: null, version: null })

  // One-time notice: show when cliNoticeAck is false and any CLI was just connected
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const showNotice =
    !settings.cliNoticeAck &&
    !noticeDismissed &&
    (!!cliConnected['claude-cli'] || !!cliConnected['codex-cli'])

  const dismissNotice = (): void => {
    setNoticeDismissed(true)
    patch({ cliNoticeAck: true })
  }

  const getState = (id: 'claude-cli' | 'codex-cli'): CliCardState =>
    id === 'claude-cli' ? claudeState : codexState
  // Single choke point for all card-state writes — guarding here covers every setState call in
  // runInstall/connect/cancel/disconnectCli without needing a check at each await site.
  const setState = (id: 'claude-cli' | 'codex-cli', s: CliCardState): void => {
    if (!mountedRef.current) return
    id === 'claude-cli' ? setClaudeState(s) : setCodexState(s)
  }

  // Step 1: show inline confirm prompt
  const startSetup = (id: 'claude-cli' | 'codex-cli'): void => {
    setState(id, { phase: 'confirming', msg: null, version: null })
  }

  // Step 2: user clicks Continue → install silently, then connect
  const runInstall = async (id: 'claude-cli' | 'codex-cli'): Promise<void> => {
    // Capture which provider was active when this install run started — see the patch() call below.
    const startProvider = providerRef.current
    setState(id, { phase: 'installing', msg: 'Installing…', version: null })

    const installResult = await window.toto.cliInstall(id, (line) => {
      setState(id, { phase: 'installing', msg: line, version: null })
    })

    if (installResult.needsTerminal) {
      // Needs sudo / elevated perms — fall back to Terminal
      window.toto.cliSetup(id)
      setState(id, {
        phase: 'setup-opened',
        msg: 'Finish the login in the window that opened, then come back and press Connect.',
        version: null
      })
      return
    }

    if (!installResult.ok) {
      setState(id, { phase: 'install-error', msg: installResult.error || 'Installation failed.', version: null })
      return
    }

    // Install succeeded — test connection
    setState(id, { phase: 'connecting', msg: 'Connecting…', version: null })
    const testResult = await window.toto.cliTest(id)

    if (testResult.ok) {
      // Guard against a stale in-flight install/test resolving after the user switched tabs (unmounting
      // this card) — without this, a late resolution here can re-activate a provider the user already
      // disconnected in the meantime (see disconnectCli). Mirrors setState's own mountedRef guard. Also
      // skip the patch if the user switched to a different provider tile on the AiSection grid while
      // this install was running — a finished install must never silently revert that in-panel pick.
      if (mountedRef.current && providerRef.current === startProvider) patch({ provider: id })
      setState(id, {
        phase: 'done',
        msg:
          testResult.session === 'weekly-limit'
            ? testResult.error || 'Signed in. Weekly usage limit reached — not disconnected.'
            : null,
        version: testResult.version ?? null
      })
      return
    }

    // Not logged in — open login flow
    window.toto.cliLogin(id)
    setState(id, {
      phase: 'setup-opened',
      msg: 'Installed. Sign in through the window that opened, then come back and press Connect.',
      version: null
    })
  }

  // Connect button (setup-opened / error): re-run test only
  const connect = async (id: 'claude-cli' | 'codex-cli'): Promise<void> => {
    // Capture which provider was active when this connect attempt started — see the patch() call below.
    const startProvider = providerRef.current
    setState(id, { phase: 'connecting', msg: 'Connecting…', version: null })
    const r = await window.toto.cliTest(id)
    if (r.ok) {
      // Same stale-resolution + provider-switch guard as runInstall above.
      // Weekly-limit is signed-in: Connect succeeds and we say so, instead of looking disconnected.
      if (mountedRef.current && providerRef.current === startProvider) patch({ provider: id })
      setState(id, {
        phase: 'done',
        msg:
          r.session === 'weekly-limit'
            ? r.error || 'Signed in. Weekly usage limit reached — not disconnected.'
            : null,
        version: r.version ?? null
      })
    } else {
      setState(id, {
        phase: 'error',
        msg: r.error || 'Could not connect. Finish signing in, then try again.',
        version: null
      })
    }
  }

  const cancel = (id: 'claude-cli' | 'codex-cli'): void => {
    setState(id, { phase: 'idle', msg: null, version: null })
  }

  // Disconnect Métis from a CLI provider. Clears the connected flag (the global CLI itself is left
  // installed — it's the user's own tool) and, if it was the active provider, switches to a ready one.
  const disconnectCli = (id: 'claude-cli' | 'codex-cli'): void => {
    const nextConnected = { ...cliConnected, [id]: false }
    const next: Partial<PublicSettings> = { cliConnected: nextConnected }
    if (provider === id)
      next.provider = pickReadyProvider(
        id,
        settings.hasKeys,
        nextConnected,
        settings.dustWorkspaceId,
        settings.providerModels,
        settings.allowedProviders
      )
    patch(next)
    setState(id, { phase: 'idle', msg: null, version: null })
  }

  const primaryBtn =
    'no-drag cl-focus flex items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50'
  const secondaryBtn =
    'no-drag cl-focus flex items-center gap-1.5 rounded-[8px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-50'
  const activePill =
    'flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-primary)]'

  const renderCliCard = (id: 'claude-cli' | 'codex-cli'): JSX.Element => {
    const def = PROVIDERS[id]
    const st = getState(id)
    const isActive = provider === id
    const isConnected = !!cliConnected[id]
    const allowed = isAllowed(id)
    const cardLocked = locked || !allowed
    const desc =
      id === 'claude-cli'
        ? 'Routes questions through your local Claude Code install. Uses your Pro or Max subscription.'
        : 'Routes questions through your local OpenAI Codex CLI install. Uses your ChatGPT or API account.'
    const confirmMsg =
      id === 'claude-cli'
        ? 'Make sure you are signed in to your Claude (Pro or Max) account on this device before continuing.'
        : 'Make sure you are signed in to your ChatGPT or OpenAI account on this device before continuing.'

    return (
      <div
        key={id}
        className={[
          'flex flex-col gap-2 rounded-[10px] border p-3',
          isActive
            ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]/40'
            : 'border-[var(--cl-border)] bg-white/[0.02]'
        ].join(' ')}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">{def.label}</span>
            <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{desc}</span>
          </div>
          {isActive ? (
            <span className={activePill}>
              <CircleCheck size={12} /> Active
            </span>
          ) : locked ? (
            <span className={managedChipCls}>Managed by your organization</span>
          ) : (
            !allowed && <span className={managedChipCls}>Restricted by your organization</span>
          )}
        </div>

        {/* Confirm step */}
        {st.phase === 'confirming' && (
          <div className="flex flex-col gap-2 rounded-[8px] border border-[var(--cl-border)] bg-white/[0.04] p-2.5">
            <span className="text-[11px] leading-snug text-[color:var(--cl-foreground)]">{confirmMsg}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => void runInstall(id)} className={primaryBtn}>
                Continue
              </button>
              <button type="button" onClick={() => cancel(id)} className={secondaryBtn}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Installing — live progress */}
        {st.phase === 'installing' && (
          <div className="flex items-center gap-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
            <InlineOrb kind="loading" />
            <span className="min-w-0 flex-1 truncate">{st.msg ?? 'Installing…'}</span>
          </div>
        )}

        {/* After setup opened in Terminal */}
        {st.phase === 'setup-opened' && st.msg && (
          <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">{st.msg}</span>
        )}

        {/* Error */}
        {(st.phase === 'error' || st.phase === 'install-error') && st.msg && (
          <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
            <AlertCircle size={13} className="mt-px shrink-0" />
            <span>{st.msg}</span>
          </div>
        )}

        {/* Connecting spinner */}
        {st.phase === 'connecting' && (
          <AgentStatus kind="connecting" size="inline" caption />
        )}

        {/* Connected version info */}
        {st.phase === 'done' && (st.version || st.msg) && (
          <span className="text-[11px] text-[color:var(--cl-success)]">
            <CircleCheck size={12} className="mr-1 inline" />
            {st.msg || st.version}
          </span>
        )}

        {/* Primary action button — idle state only */}
        {st.phase === 'idle' && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => startSetup(id)}
              disabled={cardLocked}
              className={primaryBtn}
            >
              <Link2 size={12} />
              {isConnected ? 'Reconnect' : 'Set up automatically'}
            </button>
            {isConnected && (
              <button
                type="button"
                onClick={() => disconnectCli(id)}
                disabled={locked && isActive}
                className={secondaryBtn}
                title={`Disconnect ${def.label}`}
              >
                <X size={12} />
                Disconnect
              </button>
            )}
          </div>
        )}

        {/* Connect button — visible in setup-opened or error phases */}
        {(st.phase === 'setup-opened' || st.phase === 'error') && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void connect(id)}
              disabled={cardLocked}
              className={primaryBtn}
            >
              <Link2 size={12} />
              Connect
            </button>
            <button type="button" onClick={() => cancel(id)} className={secondaryBtn}>
              Cancel
            </button>
          </div>
        )}

        {/* Retry button — visible when the install itself failed (never got as far as a connect test) */}
        {st.phase === 'install-error' && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void runInstall(id)}
              disabled={cardLocked}
              className={primaryBtn}
            >
              <Link2 size={12} />
              Retry install
            </button>
            <button type="button" onClick={() => cancel(id)} className={secondaryBtn}>
              Cancel
            </button>
          </div>
        )}

        {/* Reconnect / Disconnect links — shown after a successful connect */}
        {st.phase === 'done' && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => startSetup(id)}
              disabled={cardLocked}
              className="no-drag cl-focus text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)] disabled:opacity-50"
            >
              Reconnect
            </button>
            <button
              type="button"
              onClick={() => disconnectCli(id)}
              disabled={locked && isActive}
              className="no-drag cl-focus text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-destructive)] disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <Section
      title="CLI Integration"
      desc="Claude Code and Codex route through your own local install of that tool. It has to be on this device. Set up automatically installs it (via npm i -g) if it's missing, or connects straight away if it's already there."
      icon={Link2}
    >
      <div className="flex flex-col gap-3">

        {/* One-time notice */}
        {showNotice && (
          <div className="flex items-start justify-between gap-2 rounded-[8px] border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)]/50 px-3 py-2.5">
            <span className="text-[11px] leading-snug text-[color:var(--cl-foreground)]">
              This uses your local CLI login. Depending on the tool, answers may use your subscription or API credits.
            </span>
            <button
              type="button"
              onClick={dismissNotice}
              aria-label="Dismiss notice"
              className="no-drag cl-focus shrink-0 rounded text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Claude Code CLI card */}
        {renderCliCard('claude-cli')}

        {/* Codex CLI card */}
        {renderCliCard('codex-cli')}

        {/* CLI-vs-API priority — only meaningful once a CLI is connected alongside an API provider. */}
        {(!!cliConnected['claude-cli'] || !!cliConnected['codex-cli']) && (
          <div className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--cl-border)] bg-white/[0.02] p-3">
            <div className="flex flex-col gap-0.5 pr-2">
              <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">Priority</span>
              <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                {settings.providerPriority === 'cli'
                  ? 'Use a connected CLI first (your subscription), fall back to your API key.'
                  : 'Use your chosen API provider first, fall back to a CLI.'}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="Provider priority"
              className="flex shrink-0 items-center rounded-[8px] border border-[var(--cl-border)] bg-white/[0.03] p-0.5"
            >
              {(['cli', 'api'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={settings.providerPriority === opt}
                  onClick={() => patch({ providerPriority: opt })}
                  className={[
                    'no-drag cl-focus rounded-[6px] px-3 py-1 text-[12px] font-medium transition-colors',
                    settings.providerPriority === opt
                      ? 'bg-[var(--cl-primary)] text-white'
                      : 'text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]'
                  ].join(' ')}
                >
                  {opt === 'cli' ? 'CLI' : 'API'}
                </button>
              ))}
            </div>
          </div>
        )}

      </div>
    </Section>
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
  extraFields
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  kind: 'clickup' | 'plane'
  title: string
  desc: string
  waitingLabel: string
  mark: JSX.Element
  connect: () => Promise<{ ok: boolean; error?: string; tools?: string[] }>
  pinnedEndpoint: string
  apiKeyHint: string
  extraFields?: { key: string; label: string; placeholder: string }[]
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
            extraHeaders: extraHeaders()
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
            extraHeaders: extraHeaders()
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
              ? `${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'} available`
              : 'Connected — no tools reported for this account.'}
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
      apiKeyHint="ClickUp API token (power option — Connect is the usual path)"
    />
  )
}

function PlaneCard({ settings, patch }: { settings: PublicSettings; patch: (p: Partial<PublicSettings>) => void }): JSX.Element {
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
    />
  )
}

/**
 * Scrollable, searchable popup for picking a Dust agent — replaces a native <select> so a long agent
 * list (with descriptions) is actually browsable instead of squeezed into the OS's own dropdown chrome.
 * Falls back to a bare text input whenever `agents` hasn't loaded yet (or failed), so an sId can still
 * be pasted by hand — same escape hatch the old <select>/<input> pair offered. Shared by DustSetup's
 * base- and thinking-agent controls below: `emptyOption` adds a top "clear" row for the thinking
 * picker's "same as base" state, `defaultId` tags one row " (default)" for the base picker's Métis
 * agent. Dismiss-on-outside-click/Escape mirrors the "Mode options" overflow menu elsewhere in this file.
 */
function AgentPicker({
  id,
  label,
  value,
  agents,
  loading,
  err,
  onSelect,
  placeholder,
  disabled,
  emptyOption,
  defaultId,
  onEmptyBlur
}: {
  id?: string
  label: string
  value: string
  agents: DustAgent[] | null
  loading: boolean
  err: string | null
  onSelect: (sId: string) => void
  placeholder: string
  disabled?: boolean
  /** Label for an extra sId:'' row at the top of the list (e.g. "Same as base agent"). Omit to require
   *  a real selection (the base-agent picker never offers an empty option). */
  emptyOption?: string
  /** sId to annotate with " (default)" in its row + trigger label (e.g. the Métis base agent). */
  defaultId?: string
  /** Fired when the pre-load fallback text input is blurred while empty (only reachable path to a blank
   *  value, since the popup itself never offers one unless `emptyOption` is set) — lets a caller like the
   *  base-agent picker restore its default instead of persisting a blank sId. */
  onEmptyBlur?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Stop this Escape from reaching any window-level handler while just closing this popup.
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Reset the filter and focus it fresh on every open, so re-opening never shows a stale search.
  useEffect(() => {
    if (!open) return
    setQuery('')
    const f = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(f)
  }, [open])

  // No agents loaded yet: loading spinner, or (failed/empty) the same bare-sId input the old code
  // fell back to, plus the error so the user knows why they're typing an id instead of picking one.
  if (!agents || agents.length === 0) {
    if (loading) {
      return (
        <div className={['flex w-full items-center gap-2 opacity-70', ctl].join(' ')}>
          <AgentStatus kind="searching" size="inline" caption />
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1">
        <input
          id={id}
          value={value}
          onChange={(e) => onSelect(e.target.value)}
          onBlur={(e) => {
            if (!e.target.value.trim()) onEmptyBlur?.()
          }}
          placeholder={placeholder}
          aria-label={label}
          disabled={disabled}
          className={['w-full', ctl, disabled ? 'opacity-60' : ''].join(' ')}
        />
        {err && (
          <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
            <AlertCircle size={12} /> {err}
          </div>
        )}
      </div>
    )
  }

  // A previously-saved sId that no longer exists in this workspace must stay visible + selectable
  // (not silently vanish into a blank trigger) — same stale-id guard the old <select> had.
  const stale = !!value && !agents.some((a) => a.sId === value)
  const rows: { sId: string; name: string; description: string }[] = [
    ...(emptyOption !== undefined ? [{ sId: '', name: emptyOption, description: '' }] : []),
    ...(stale ? [{ sId: value, name: value, description: 'Not in your workspace' }] : []),
    ...agents.map((a) => ({
      sId: a.sId,
      name: a.name + (defaultId && a.sId === defaultId ? ' (default)' : ''),
      description: a.description || ''
    }))
  ]
  const q = query.trim().toLowerCase()
  const filtered = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
    : rows
  const selectedRow = rows.find((r) => r.sId === value)
  const triggerLabel = selectedRow ? selectedRow.name : value || placeholder

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={[
          'flex w-full items-center justify-between gap-2 text-left',
          ctl,
          disabled ? 'opacity-60' : 'hover:bg-white/[0.06]'
        ].join(' ')}
      >
        <span className={['truncate', selectedRow || value ? '' : 'text-[color:var(--cl-muted-foreground)]'].join(' ')}>
          {triggerLabel}
        </span>
        <ChevronDown
          size={14}
          className={[
            'shrink-0 text-[color:var(--cl-muted-foreground)] transition-transform',
            open ? 'rotate-180' : ''
          ].join(' ')}
        />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 flex flex-col overflow-hidden rounded-[10px] border border-[var(--cl-border)] bg-[var(--cl-bg,#1a1a2e)] shadow-lg">
          <div className="relative border-b border-[var(--cl-border)] p-1.5">
            <Search
              size={12}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[color:var(--cl-muted-foreground)]"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  // Stop this Escape from reaching any window-level handler while just closing the popup.
                  e.stopPropagation()
                  setOpen(false)
                }
                if (e.key === 'Enter' && filtered[0]) {
                  onSelect(filtered[0].sId)
                  setOpen(false)
                }
              }}
              placeholder="Filter agents…"
              className={'w-full pl-7 text-[12px] ' + ctl}
            />
          </div>
          <div className="scroll-thin flex max-h-[280px] flex-col gap-0.5 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-center text-[11px] text-[color:var(--cl-muted-foreground)]">
                No matching agents.
              </div>
            )}
            {filtered.map((r) => {
              const isSel = r.sId === value
              return (
                <button
                  key={r.sId || '__empty__'}
                  type="button"
                  onClick={() => {
                    onSelect(r.sId)
                    setOpen(false)
                  }}
                  className={[
                    'no-drag cl-focus flex items-center gap-2 rounded-[8px] border px-2.5 py-1.5 text-left transition-colors',
                    isSel
                      ? 'border-[var(--cl-primary)]/40 bg-[var(--cl-primary-soft)]'
                      : 'border-transparent hover:bg-white/[0.06]'
                  ].join(' ')}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-[color:var(--cl-foreground)]">{r.name}</div>
                    {r.description && (
                      <div className="truncate text-[11px] text-[color:var(--cl-muted-foreground)]">
                        {r.description}
                      </div>
                    )}
                  </div>
                  {isSel && <Check size={13} className="shrink-0 text-[color:var(--cl-primary)]" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function DustSetup({
  settings,
  patch,
  saveKey,
  recoverEncryptedProfile,
  clearKey,
  active
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  saveKey: (provider: ProviderId, k: string) => Promise<void>
  recoverEncryptedProfile: () => Promise<ProfileRecoveryResult>
  clearKey: (provider: ProviderId) => Promise<void>
  active: boolean
}): JSX.Element {
  const [link, setLink] = useState('')
  const [dustKey, setDustKey] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [recoveryAvailable, setRecoveryAvailable] = useState(false)
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null)
  const [agents, setAgents] = useState<DustAgent[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [cli, setCli] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({
    busy: false,
    msg: null,
    ok: false
  })
  // Native OAuth sign-in after the managed Dust CLI is installed. 'starting' covers CLI install +
  // device-code mint. 'waiting' polls dustLoginPoll until the browser consent finishes.
  type DustOAuthPhase = 'idle' | 'starting' | 'waiting' | 'picking' | 'finishing' | 'error'
  const [oauth, setOauth] = useState<{
    phase: DustOAuthPhase
    userCode: string | null
    verificationUri: string | null
    intervalSec: number
    expiresAt: number
    workspaces: Array<{ sId: string; name: string; role?: string }> | null
    error: string | null
  }>({
    phase: 'idle',
    userCode: null,
    verificationUri: null,
    intervalSec: 5,
    expiresAt: 0,
    workspaces: null,
    error: null
  })
  const linkId = useId()
  const wsId = useId()
  const thinkSel = useId()
  // The manual API-key path is collapsed by default so the one-click "Set up Dust automatically" button
  // is the obvious choice; users who already hold an admin key expand it.
  const [showKeyPath, setShowKeyPath] = useState(false)

  const isEu = /eu\.dust\.tt/i.test(settings.dustBaseUrl)
  // The one-click CLI setup (dustImportCli/dustSetupCli) is cross-platform now (dust-secret-store reads
  // the session on macOS/Windows/Linux), so it's the primary path on every OS — no per-platform gating.
  const locked = settings.managedKeys.includes('provider')
  // Same independent-key gap as the provider tiles: allowedProviders can restrict Dust without also
  // locking the 'provider' managed key — badge those controls "Restricted" rather than letting a save
  // activate a provider every ask would then reject.
  const orgAllowed = settings.allowedProviders
  const dustAllowed = !orgAllowed || orgAllowed.includes('dust')
  // Base agent is user-editable (picker below, defaults to the Métis agent, one-click reset) —
  // gated by the same 'providerModels' managed-key as the Advanced base-model field in AiSection, not
  // by the CLI-connection lock above. Spotlight Ref stays hard-locked (DUST_SPOTLIGHT_REF_AGENT_ID in
  // ipc.ts) — read-only display. The base agent also drafts meeting follow-ups directly — there is no
  // separate follow-up agent.
  const agentsLocked = settings.managedKeys.includes('providerModels')
  const agent = settings.providerModels['dust'] ?? ''
  const thinkAgent = settings.providerModelsThinking['dust'] ?? ''
  const spotlightAgent = settings.providerModelsSpotlightRef['dust'] ?? ''
  const keySaved = !!settings.hasKeys['dust']
  const hasWs = !!settings.dustWorkspaceId.trim()
  // Credentials on disk are not a live proof — green Connected / Use Dust wait for a non-empty agent list.
  const listProved = !!agents && agents.length > 0 && !err
  const connected = keySaved && hasWs && !!agent && listProved
  const selectedAgentName = agents?.find((a) => a.sId === agent)?.name
  const selectedAgent = agents?.find((a) => a.sId === agent)
  // Loaded the workspace's agents but the saved base agent isn't among them — the root cause of the
  // "Failed to retrieve agent message" ask failure. Warn + guide a one-click re-pick right at the picker.
  const storedAgentMissing = dustStoredAgentMissing(agent, agents)
  const spotlightAgentMissing = dustStoredAgentMissing(spotlightAgent, agents)
  const selectedAgentRunsSonnet = !!selectedAgent && selectedAgent.modelProviderId === 'anthropic' && /sonnet/i.test(selectedAgent.modelId || '')

  const applyDustValidate = (verdict: DustInstantValidateResult): void => {
    if (verdict.ok) {
      setCli({ busy: false, ok: true, msg: verdict.message })
      setErr(null)
      return
    }
    setCli({ busy: false, ok: false, msg: verdict.message })
    setErr(verdict.message)
  }

  // Live-ping after OAuth finish / CLI import (key already persisted in main). testApiKey + listDustAgents
  // (view:'list'); empty/restricted/401/dead session is not Connected. Never auto-sends a chat.
  const proveAfterConnect = async (workspaceId: string, selectedAgentId = agent): Promise<DustInstantValidateResult> => {
    const verdict = await proveDustConnection({
      workspaceId,
      selectedAgentId,
      testApiKey: () => window.toto.testApiKey('dust', ''),
      listAgents: () => loadAgents()
    })
    applyDustValidate(verdict)
    return verdict
  }

  // Import an existing `dust login` CLI session (token + workspace + region) from the keychain — the
  // migration path for a user who already has the CLI installed. The primary path is startDustOAuth below,
  // which installs the managed Dust CLI then signs in (native OAuth). No system Node.js.
  const connectCli = async (): Promise<void> => {
    setCli({ busy: true, msg: null, ok: false })
    const r = await window.toto.dustImportCli()
    if (!r.ok) {
      // Blocked Keychain read, not a missing session — ask to allow access, same as the mount-time live
      // check below (decideDustLiveCheck), instead of misdirecting into a needless re-login.
      if (r.accessDenied) {
        setCli({
          busy: false,
          ok: false,
          msg: r.error || `Allow Métis to access your Dust CLI session in ${DUST_CREDENTIAL_STORE}, then try again.`
        })
        return
      }
      if (r.incomplete) {
        // `dust login`'s browser OAuth step finished but its separate interactive terminal
        // workspace-picker step never did — point back at that terminal instead of retrying blind.
        setCli({
          busy: false,
          ok: false,
          msg: 'Almost there. Finish picking your workspace in the terminal from `dust login` (arrow keys, then Enter). Then click Import again.'
        })
        return
      }
      setCli({
        busy: false,
        ok: false,
        msg: r.error || 'No Dust CLI session found. Run `dust login` in a terminal first, or use the automatic sign-in above.'
      })
      return
    }
    // Import set key/workspace/region in main; make Dust active + refresh. If the CLI session belongs
    // to a DIFFERENT workspace than before, a previously-picked base/thinking agent sId is meaningless
    // there — reset both to the defaults instead of carrying a foreign workspace's agent across.
    const wsChanged = !!settings.dustWorkspaceId && !!r.workspaceId && settings.dustWorkspaceId !== r.workspaceId
    if (wsChanged) {
      const nextThinking = { ...settings.providerModelsThinking }
      delete nextThinking.dust
      await patch({
        provider: 'dust',
        providerModels: { ...settings.providerModels, dust: DUST_BASE_AGENT_ID },
        providerModelsThinking: nextThinking
      })
    } else {
      await patch({ provider: 'dust' })
    }
    setCli({ busy: false, ok: false, msg: 'Checking Dust connection…' })
    await proveAfterConnect(r.workspaceId || settings.dustWorkspaceId, wsChanged ? DUST_BASE_AGENT_ID : agent)
  }

  const oauthIdle = { phase: 'idle' as const, userCode: null, verificationUri: null, intervalSec: 5, expiresAt: 0, workspaces: null, error: null }

  // Step 1: mint a device code, open the browser consent page. Step 2 (polling) is the effect below.
  const startDustOAuth = async (): Promise<void> => {
    setOauth({ ...oauthIdle, phase: 'starting' })
    const installed = await window.toto.dustInstallCli()
    if (!installed.ok) {
      setOauth({
        ...oauthIdle,
        phase: 'error',
        error: installed.error || 'Could not install the Dust CLI.'
      })
      return
    }
    const r = await window.toto.dustLoginBegin()
    // The device code deliberately never reaches the renderer — main keeps it and polls with its own
    // copy (see the dustLoginBegin handler). The user code is what this screen actually needs.
    if (!r.ok || !r.userCode) {
      setOauth({ ...oauthIdle, phase: 'error', error: r.error || 'Could not start Dust sign-in.' })
      return
    }
    setOauth({
      phase: 'waiting',
      userCode: r.userCode ?? null,
      verificationUri: r.verificationUri ?? null,
      intervalSec: r.intervalSec || 5,
      expiresAt: Date.now() + (r.expiresInSec || 300) * 1000,
      workspaces: null,
      error: null
    })
  }

  // Poll at the server-given cadence while waiting for the user to finish the browser step. RFC 8628:
  // 'pending' keeps the same interval, 'slow_down' adds 5s, anything else ends the loop.
  useEffect(() => {
    if (oauth.phase !== 'waiting') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async (intervalSec: number): Promise<void> => {
      if (cancelled) return
      if (Date.now() > oauth.expiresAt) {
        setOauth((o) => (o.phase === 'waiting' ? { ...o, phase: 'error', error: 'Sign-in expired — try again.' } : o))
        return
      }
      const r = await window.toto.dustLoginPoll()
      if (cancelled) return
      if (r.status === 'pending') {
        timer = setTimeout(() => void tick(intervalSec), intervalSec * 1000)
      } else if (r.status === 'slow_down') {
        timer = setTimeout(() => void tick(intervalSec), (intervalSec + 5) * 1000)
      } else if (r.status === 'ok') {
        setOauth((o) => (o.phase === 'waiting' ? { ...o, phase: 'picking', workspaces: r.workspaces ?? [] } : o))
      } else {
        setOauth((o) => (o.phase === 'waiting' ? { ...o, phase: 'error', error: r.error || 'Dust sign-in failed.' } : o))
      }
    }
    timer = setTimeout(() => void tick(oauth.intervalSec), oauth.intervalSec * 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // Re-armed only when the phase enters 'waiting' — not on every render. (The device code that used to
    // key this lives in main now and never reaches the renderer.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauth.phase])

  // Step 3: the user picked a workspace — finish the login and load its agents.
  const pickDustWorkspace = async (sId: string): Promise<void> => {
    setOauth((o) => ({ ...o, phase: 'finishing' }))
    const r = await window.toto.dustLoginPickWorkspace(sId)
    if (!r.ok) {
      setOauth((o) => ({ ...o, phase: 'error', error: r.error || 'Could not finish sign-in.' }))
      return
    }
    setOauth(oauthIdle)
    await patch({ provider: 'dust' })
    const verdict = await proveAfterConnect(sId)
    if (!verdict.ok) {
      setOauth({ ...oauthIdle, phase: 'error', error: verdict.message })
    }
  }

  // Save a Dust API key (manual alternative to the CLI). Dust keeps its own key, independent of the
  // raw-provider key field — so Dust stays self-contained whatever the active provider is.
  const saveDustKey = async (): Promise<void> => {
    const k = dustKey.trim()
    if (!k) return
    const workspaceId = settings.dustWorkspaceId.trim()
    setKeySaving(true)
    setErr(null)
    setRecoveryMessage(null)
    try {
      if (!workspaceId) {
        applyDustValidate({
          ok: false,
          reason: 'workspace-missing',
          message: DUST_WORKSPACE_MISSING_SETUP_ERROR
        })
        return
      }
      // Prove the pasted key before persisting it — a bad key must fail in this card, not look Saved.
      const test = await window.toto.testApiKey('dust', k)
      if (!test.ok) {
        applyDustValidate(decideDustInstantValidate({ workspaceId, test, list: test }, agent))
        return
      }
      await saveKey('dust', k)
      await patch({ provider: 'dust' }) // activate Dust so this key is used + the add-key CTA hides
      setDustKey('')
      setRecoveryAvailable(false)
      const list = await loadAgents()
      applyDustValidate(decideDustInstantValidate({ workspaceId, test, list }, agent))
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save the Dust API key.'
      setErr(message)
      setRecoveryAvailable(isProfileUnlockError(message))
    } finally {
      setKeySaving(false)
    }
  }

  const recoverProfileAndRetryDustKey = async (): Promise<void> => {
    setRecoveryBusy(true)
    setRecoveryMessage(null)
    try {
      const result = await recoverEncryptedProfile()
      if (!result.ok) {
        setRecoveryMessage(result.canceled ? 'Recovery canceled. Your encrypted profile was not changed.' : result.error || 'Could not create a new local profile.')
        return
      }
      setRecoveryAvailable(false)
      setErr(null)
      await saveDustKey()
    } catch (e) {
      setRecoveryMessage(e instanceof Error ? e.message : 'Could not create a new local profile.')
    } finally {
      setRecoveryBusy(false)
    }
  }
  // Fully disconnect Dust: clear the saved token/key, drop the workspace + region + the (user-editable)
  // thinking agent, reset the (also user-editable) base agent back to the Métis default, switch off
  // Dust if it's active, and reset the local CLI/agents UI so the card returns to its "connect" state.
  // Used by the CLI card's Disconnect button only — the manual key's Remove uses the narrower
  // removeDustKey below, which doesn't touch workspace/region/base/thinking agent.
  const disconnectDust = async (): Promise<void> => {
    await clearKey('dust')
    const nextThinking = { ...settings.providerModelsThinking }
    delete nextThinking.dust
    // Base is now user-changeable, so disconnect restores it to the Métis default rather than leaving
    // a stale custom agent id pointing at a workspace you just disconnected from. Spotlight Ref is left
    // untouched — it's a hard-locked app default, not user data.
    const next: Partial<PublicSettings> = {
      dustWorkspaceId: '',
      dustBaseUrl: 'https://dust.tt',
      providerModels: { ...settings.providerModels, dust: DUST_BASE_AGENT_ID },
      providerModelsThinking: nextThinking,
      // Reset to the "never CLI-connected" default (0) — otherwise a stale CLI-origin timestamp survives
      // into a later manual-API-key connect and wrongly gates the live-check effect into probing a real
      // Dust CLI session that was never used for that connection (see the effect's own gating comment).
      dustTokenMintedAt: 0
    }
    if (settings.provider === 'dust')
      next.provider = pickReadyProvider(
        'dust',
        settings.hasKeys,
        settings.cliConnected ?? {},
        settings.dustWorkspaceId,
        settings.providerModels,
        settings.allowedProviders
      )
    await patch(next)
    setAgents(null)
    setErr(null)
    setCli({ busy: false, msg: null, ok: false })
  }
  // Remove just the saved Dust API key (Step 3's "Remove") — mirrors AiSection.onRemove. Leaves the
  // workspace, region, and thinking-agent choice untouched, unlike the full disconnectDust reset above.
  const removeDustKey = async (): Promise<void> => {
    await clearKey('dust')
    if (settings.provider === 'dust')
      await patch({
        provider: pickReadyProvider(
          'dust',
          settings.hasKeys,
          settings.cliConnected ?? {},
          settings.dustWorkspaceId,
          settings.providerModels,
          settings.allowedProviders
        )
      })
    // Mirror disconnectDust's reset: a cleared key means any previously loaded agent list/error is stale.
    setAgents(null)
    setErr(null)
  }
  const useDust = (): void => void patch({ provider: 'dust' })

  // Paste any Dust link → auto-fill workspace + region, and — since the base agent is user-editable —
  // an assistant link's agent id also becomes the base agent (the most direct "use THIS agent" gesture).
  const onLink = (v: string): void => {
    setLink(v)
    const p = parseDustUrl(v)
    const next: Partial<PublicSettings> = {}
    if (p.workspaceId) next.dustWorkspaceId = p.workspaceId
    if (p.baseUrl) next.dustBaseUrl = p.baseUrl
    if (p.agentId) next.providerModels = { ...settings.providerModels, dust: p.agentId }
    if (Object.keys(next).length) patch(next)
  }

  const loadAgents = async (): Promise<{ ok: boolean; agents?: DustAgent[]; error?: string }> => {
    setLoading(true)
    setErr(null)
    const r = await window.toto.dustListAgents()
    setLoading(false)
    if (r.ok && r.agents && r.agents.length > 0) {
      setAgents(r.agents)
      return r
    }
    const error = r.error || (r.ok ? DUST_EMPTY_AGENTS_ERROR : 'Could not load your agents. Check the key + workspace, then retry.')
    setAgents(r.ok && r.agents ? r.agents : null)
    setErr(error)
    return { ok: false, error, agents: r.agents }
  }

  // When Dust was already connected in a prior session (key + workspace saved), load the agent list on
  // mount — otherwise reopening Settings shows raw agent sIds instead of names and the Thinking-agent
  // control degrades from a dropdown to a bare text input until a manual refresh.
  useEffect(() => {
    if (keySaved && hasWs && agents === null && !loading) void loadAgents()
    // loadAgents is stable enough for this mount-on-connect check; re-run only when connection state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySaved, hasWs])

  // Live session probe on open. When the settings look connected VIA THE CLI, don't take that at face
  // value — the underlying Dust CLI session can be gone (the user ran `dust logout`, the keychain was
  // cleared, or the token is unrecoverable). Probe once per mount with the READ-ONLY dustProbeSession —
  // NOT dustImportCli, which runs `dust status` and would rotate the OAuth token in a race with the
  // concurrent loadAgents() above, 401-ing the agent list. Then act on decideDustLiveCheck:
  //   • connected             → nothing to do.
  //   • needs-access          → the keychain read was blocked; ask to allow it, DON'T relaunch setup.
  //   • finish-workspace-pick → the browser OAuth step finished but the separate terminal
  //                             workspace-picker step didn't; point back at that Terminal, DON'T relaunch.
  //   • run-setup             → no live session behind the saved connection → auto-run install +
  //                             `dust login` (Terminal), so the user is prompted to reconnect instead of
  //                             silently assuming done.
  // Gated to CLI-origin connections (dustSessionOrigin, set only by the CLI import/refresh — the OAuth
  // login sets 'oauth'): a MANUAL API-key or native-OAuth connection legitimately has NO `dust-cli`
  // keychain item, so probing it would misread as "dead" for no reason. The OAuth path's own on-401
  // self-heal (main/index.ts's makeRefreshDustAuth) covers its equivalent case on next use.
  const liveCheckedRef = useRef(false)
  useEffect(() => {
    if (liveCheckedRef.current || !keySaved || !hasWs || !settings.dustTokenMintedAt || settings.dustSessionOrigin !== 'cli') return
    liveCheckedRef.current = true
    void (async () => {
      const decision = decideDustLiveCheck(await window.toto.dustProbeSession())
      if (decision === 'connected') return
      if (decision === 'needs-access') {
        const msg = `Allow Métis to read your Dust CLI session in ${DUST_CREDENTIAL_STORE}, then Reconnect.`
        setCli({ busy: false, ok: false, msg })
        setErr(msg)
        return
      }
      if (decision === 'finish-workspace-pick') {
        const msg = 'Almost there. Finish picking your workspace in the terminal from `dust login` (arrow keys, then Enter), then Reconnect.'
        setCli({ busy: false, ok: false, msg })
        setErr(msg)
        return
      }
      // decision === 'run-setup' — the saved CLI session is dead. Nudge toward a fix rather than silently
      // relaunching anything: there is no more in-app installer/terminal step for the CLI path to reopen.
      const msg = 'Your Dust CLI session ended. Run `dust login` again and Reconnect — or use the automatic sign-in above.'
      setCli({ busy: false, ok: false, msg })
      setErr(msg)
    })()
    // Probe once on mount for the already-connected case only; connectCli / disconnect handle the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Editing the workspace ID string doesn't flip keySaved/hasWs (both stay true switching workspace A → B),
  // so the effect above never re-fires — without this, the Thinking-agent dropdown keeps showing workspace
  // A's stale agents. Invalidate on every edit; the button above ("Load my agents"/"Refresh") reloads.
  useEffect(() => {
    setAgents(null)
    setErr(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.dustWorkspaceId])

  const setThinkAgent = (sId: string): void =>
    patch({ providerModelsThinking: { ...settings.providerModelsThinking, dust: sId.trim() } })

  // Commits directly on every change, same as setThinkAgent — the select never offers an empty option,
  // and the text-input fallback's onBlur (below) catches a still-blank field and restores the default
  // there instead of fighting the user's edit on every keystroke. The base agent must never persist
  // blank: isDustReady() (and every task that cascades into Dust) requires providerModels.dust to be set.
  const setBaseAgent = (sId: string): void =>
    patch({ providerModels: { ...settings.providerModels, dust: sId.trim() } })

  const regionBtn = (eu: boolean): string =>
    [
      'no-drag cl-focus flex-1 rounded-[8px] border px-3 py-2 text-[12px] font-medium transition-colors',
      isEu === eu
        ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)] text-[color:var(--cl-foreground)]'
        : 'border-[var(--cl-border)] bg-white/[0.02] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.05]'
    ].join(' ')

  return (
    <Section
      title={active ? 'Dust CLI · Your agents (active)' : 'Dust CLI · Your agents'}
      desc="Your Dust agents (Second Brain retrieval + tools) power Métis. Connect with the Dust CLI, then pick a thinking agent for hard questions."
      icon={Link2}
    >
      <div className="flex flex-col gap-4">
        {/* PRIMARY — install the managed Dust CLI, then native OAuth (main/dust-oauth.ts). One
            click installs @dust-tt/dust-cli into userData and opens the browser for consent. */}
        <div className="flex flex-col gap-2 rounded-[12px] border border-[var(--cl-primary)]/40 bg-[var(--cl-primary-soft)]/50 p-3.5">
          {keySaved && hasWs ? (
            // Credentials exist → Reconnect / Disconnect. Green Connected only after a live agent list.
            <div className="flex items-center justify-between gap-2">
              <span
                className={[
                  'flex items-center gap-1.5 text-[12px] font-medium',
                  err || (agents && agents.length === 0)
                    ? 'text-[color:var(--cl-destructive)]'
                    : listProved
                      ? 'text-[color:var(--cl-success)]'
                      : 'text-[color:var(--cl-muted-foreground)]'
                ].join(' ')}
              >
                {err || (agents && agents.length === 0) ? (
                  <>
                    <AlertCircle size={14} />
                    {err || DUST_EMPTY_AGENTS_ERROR}
                  </>
                ) : listProved && agents ? (
                  <>
                    <CircleCheck size={14} />
                    {formatDustConnectedMessage({
                      agentCount: agents.length,
                      selectedName: selectedAgentName,
                      selectedId: agent,
                      workspaceId: settings.dustWorkspaceId
                    })}
                  </>
                ) : loading ? (
                  <>
                    <InlineOrb kind="connecting" />
                    Checking Dust connection…
                  </>
                ) : (
                  <>
                    <Info size={14} />
                    Workspace saved. Load agents to verify the connection.
                  </>
                )}
              </span>
              <div className="flex items-center gap-2">
                {locked && <span className={managedChipCls}>Managed by your organization</span>}
                <button
                  type="button"
                  onClick={() => void startDustOAuth()}
                  disabled={oauth.phase !== 'idle' || locked}
                  title="Sign in again to Dust"
                  className="no-drag cl-focus flex items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {oauth.phase !== 'idle' ? <InlineOrb kind="connecting" /> : <RefreshCw size={13} />}
                  Reconnect
                </button>
                <button
                  type="button"
                  onClick={disconnectDust}
                  disabled={oauth.phase !== 'idle' || (locked && active)}
                  title="Disconnect Dust from Métis"
                  className="no-drag cl-focus flex items-center gap-1.5 rounded-[8px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-3 py-1.5 text-[12px] font-medium text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/20 disabled:opacity-50"
                >
                  <X size={13} />
                  Disconnect
                </button>
              </div>
            </div>
          ) : oauth.phase === 'waiting' ? (
            // Waiting on the browser consent step — show the code in case the browser needs it re-typed,
            // and a way out in case the user closed the tab or the browser never opened.
            <div className="flex flex-col items-center gap-2 text-center">
              <AgentStatus kind="connecting" size="hero" />
              <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Waiting for you to finish in your browser…</span>
              {oauth.userCode && (
                <span className="rounded-[8px] bg-black/20 px-3 py-1 font-mono text-[15px] tracking-widest text-[color:var(--cl-foreground)]">
                  {oauth.userCode}
                </span>
              )}
              {oauth.verificationUri && (
                <a
                  href={oauth.verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[color:var(--cl-primary)] underline"
                >
                  Browser didn&apos;t open? Click here
                </a>
              )}
              <button
                type="button"
                onClick={() => setOauth(oauthIdle)}
                className="no-drag cl-focus text-[11px] text-[color:var(--cl-muted-foreground)] underline"
              >
                Cancel
              </button>
            </div>
          ) : oauth.phase === 'picking' ? (
            // Workspace list from the just-finished sign-in — Métis's own picker replaces dust-cli's
            // arrow-key terminal UI.
            <div className="flex flex-col gap-2">
              <span className="text-center text-[12px] font-medium text-[color:var(--cl-foreground)]">Pick your workspace</span>
              {(oauth.workspaces ?? []).map((w) => (
                <button
                  key={w.sId}
                  type="button"
                  onClick={() => void pickDustWorkspace(w.sId)}
                  className="no-drag cl-focus flex items-center justify-between rounded-[8px] border border-[var(--cl-border)] bg-black/10 px-3 py-2 text-left text-[13px] text-[color:var(--cl-foreground)] hover:border-[var(--cl-primary)]"
                >
                  <span>{w.name}</span>
                  {w.role && <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">{w.role}</span>}
                </button>
              ))}
            </div>
          ) : oauth.phase === 'finishing' ? (
            <div className="flex items-center justify-center gap-2 py-2 text-[13px] text-[color:var(--cl-muted-foreground)]">
              <AgentStatus kind="connecting" size="inline" caption />
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void startDustOAuth()}
                disabled={oauth.phase === 'starting' || locked}
                className="no-drag cl-focus flex w-full items-center justify-center gap-2 rounded-[10px] bg-[var(--cl-primary)] px-4 py-3 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {oauth.phase === 'starting' ? <InlineOrb kind="connecting" /> : <Wand2 size={16} />}
                {oauth.phase === 'starting' ? 'Installing Dust CLI…' : 'Set up Dust automatically'}
              </button>
              <span className="text-center text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                Installs the Dust CLI, then opens your browser to sign in and pick your workspace.
                {locked && <span className={'ml-1 ' + managedChipCls}>Managed by your organization</span>}
              </span>
              <button
                type="button"
                onClick={() => void connectCli()}
                disabled={cli.busy || locked}
                className="no-drag cl-focus mx-auto flex items-center gap-1.5 text-[11px] text-[color:var(--cl-muted-foreground)] underline disabled:opacity-50"
              >
                {cli.busy && <InlineOrb kind="connecting" />}
                Already signed in with the Dust CLI? Import that session
              </button>
            </>
          )}
          {oauth.error && (
            <span className="text-center text-[11px] text-[color:var(--cl-destructive)]">{oauth.error}</span>
          )}
          {cli.msg && (
            <span
              className={[
                'text-center text-[11px]',
                cli.ok ? 'text-[color:var(--cl-success)]' : 'text-[color:var(--cl-destructive)]'
              ].join(' ')}
            >
              {cli.msg}
            </span>
          )}
        </div>

        {recoveryAvailable && (
          <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--cl-primary)]/35 bg-[var(--cl-primary-soft)]/40 p-3 text-[12px]">
            <div className="flex items-start gap-1.5 text-[color:var(--cl-foreground)]">
              <ShieldCheck size={13} className="mt-0.5 shrink-0 text-[color:var(--cl-primary)]" />
              <span>
                Métis cannot unlock the existing encrypted profile. Restore {PROFILE_CREDENTIAL_STORE} access and
                retry, or create a fresh local profile while the old encrypted data is preserved.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void recoverProfileAndRetryDustKey()}
              disabled={recoveryBusy}
              className="no-drag cl-focus inline-flex w-fit items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {recoveryBusy ? <InlineOrb kind="loading" /> : <RotateCcw size={13} />}
              {recoveryBusy ? 'Creating new profile…' : 'Create new local profile & retry'}
            </button>
            {recoveryMessage && <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">{recoveryMessage}</div>}
          </div>
        )}

        {/* Manual alternative — collapsed by default. Everything the automatic setup does, by hand:
            paste a Dust link (auto-fills workspace + region) or an admin API key. */}
        <button
          type="button"
          onClick={() => setShowKeyPath((v) => !v)}
          aria-expanded={showKeyPath}
          className="no-drag cl-focus flex items-center gap-1.5 self-start text-[12px] font-medium text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
        >
          <ChevronDown size={13} className={showKeyPath ? 'transition-transform' : '-rotate-90 transition-transform'} />
          I already have an API key
        </button>
        {showKeyPath && (
        <div className="flex flex-col gap-4">
        {/* Step 1 — paste a link, everything auto-fills */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--cl-foreground)]">
            <StepBadge n={1} done={hasWs} /> Paste any Dust link
          </div>
          <div className="relative">
            <Link2
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--cl-muted-foreground)]"
            />
            <input
              id={linkId}
              value={link}
              onChange={(e) => onLink(e.target.value)}
              placeholder="Paste your Dust workspace or agent URL (fills the fields below)"
              className={'w-full pl-7 ' + ctl}
            />
          </div>
          <span className="pl-7 text-[11px] text-[color:var(--cl-muted-foreground)]">
            e.g. https://dust.tt/w/<b>abc123</b>/builder/agents/<b>myAgent</b>, or fill the fields below.
          </span>
        </div>

        {/* Step 2 — workspace + region (auto, but editable) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--cl-foreground)]">
            <StepBadge n={2} done={hasWs} /> Workspace &amp; region
          </div>
          <label htmlFor={wsId} className="sr-only">
            Workspace ID
          </label>
          <div className="flex items-center gap-2">
            <input
              id={wsId}
              value={settings.dustWorkspaceId}
              onChange={(e) => patch({ dustWorkspaceId: e.target.value })}
              placeholder="Workspace ID (e.g. abc123)"
              disabled={settings.managedKeys.includes('dustWorkspaceId')}
              className={
                'flex-1 min-w-0 ' + ctl + (settings.managedKeys.includes('dustWorkspaceId') ? ' opacity-60' : '')
              }
            />
            <ManagedChip keys={settings.managedKeys} k="dustWorkspaceId" />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => patch({ dustBaseUrl: 'https://dust.tt' })}
              disabled={settings.managedKeys.includes('dustBaseUrl')}
              className={regionBtn(false) + (settings.managedKeys.includes('dustBaseUrl') ? ' opacity-60 cursor-not-allowed' : '')}
            >
              US · dust.tt
            </button>
            <button
              type="button"
              onClick={() => patch({ dustBaseUrl: 'https://eu.dust.tt' })}
              disabled={settings.managedKeys.includes('dustBaseUrl')}
              className={regionBtn(true) + (settings.managedKeys.includes('dustBaseUrl') ? ' opacity-60 cursor-not-allowed' : '')}
            >
              EU · eu.dust.tt
            </button>
          </div>
          <ManagedChip keys={settings.managedKeys} k="dustBaseUrl" />
        </div>

        {/* Step 3 — Dust API key (self-contained — only needed if you didn't use the CLI above) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--cl-foreground)]">
            <StepBadge n={3} done={keySaved} /> Dust API key
          </div>
          {keySaved ? (
            <div className="flex items-center justify-between gap-2 pl-7">
              <span className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-success)]">
                <CircleCheck size={13} /> Saved on this device.
              </span>
              <button
                type="button"
                onClick={removeDustKey}
                disabled={locked && active}
                className="no-drag cl-focus rounded-[8px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-2.5 py-1 text-[11px] text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/20 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 pl-7">
              <input
                type="password"
                value={dustKey}
                onChange={(e) => setDustKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveDustKey()}
                placeholder="Paste your Dust API key (sk-…)"
                className={'flex-1 ' + ctl}
              />
              <button
                type="button"
                onClick={saveDustKey}
                disabled={keySaving || !dustKey.trim() || (locked && active)}
                className="no-drag cl-focus flex items-center gap-1 rounded-[10px] bg-[var(--cl-primary)] px-3 py-2.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {keySaving ? <InlineOrb kind="loading" /> : null} Save
              </button>
              {locked ? (
                <span className={managedChipCls}>Managed by your organization</span>
              ) : (
                !dustAllowed && <span className={managedChipCls}>Restricted by your organization</span>
              )}
            </div>
          )}
          <span className="pl-7 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Get one at dust.tt → Settings → API Keys (admin). Or use “Set up Dust automatically” above,
            no key needed.
          </span>
        </div>
        </div>
        )}

        {/* Step 4 — pick the agent from a live list (no ids to copy) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--cl-foreground)]">
              <StepBadge n={4} done={!!agent} /> Pick your agents
            </div>
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  const list = await loadAgents()
                  const test = await window.toto.testApiKey('dust', '')
                  applyDustValidate(decideDustInstantValidate({ workspaceId: settings.dustWorkspaceId, test, list }, agent))
                })()
              }
              disabled={loading || !keySaved || !hasWs}
              title={!keySaved || !hasWs ? 'Save your key + workspace first' : 'Load your Dust agents'}
              className="no-drag cl-focus flex items-center gap-1 rounded-[8px] border border-[var(--cl-input)] bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-40"
            >
              {loading ? <InlineOrb kind="searching" /> : <RefreshCw size={13} />}
              {agents ? 'Refresh' : 'Load my agents'}
            </button>
          </div>

          {/* Base agent — answers everyday questions and drafts meeting follow-ups directly (no separate
              follow-up agent). User-editable via the AgentPicker popup below (keeping the current sId
              selectable even if it's not in the workspace), a bare sId input before the list loads, and
              a one-click reset back to the Métis default whenever it's been changed. The picker never
              offers an empty option, so the base agent can never persist empty. Locked by the same
              'providerModels' managed-key as the Advanced base-model field in AiSection above. */}
          <div className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              <span className="flex items-center gap-1.5">
                Base agent · answers everyday questions &amp; drafts follow-ups
                <ManagedChip keys={settings.managedKeys} k="providerModels" />
              </span>
              {agent && agent !== DUST_BASE_AGENT_ID && (
                <button
                  type="button"
                  onClick={() => setBaseAgent(DUST_BASE_AGENT_ID)}
                  disabled={agentsLocked}
                  className="no-drag cl-focus rounded px-1 text-[11px] text-[color:var(--cl-primary)] hover:underline disabled:opacity-50"
                >
                  Reset to Métis default
                </button>
              )}
            </span>
            {storedAgentMissing && (
              <div className="flex items-start gap-1.5 rounded-[8px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-2.5 py-1.5 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
                <Info size={13} className="mt-0.5 shrink-0" />
                <span>Your saved agent is not in this workspace anymore. Pick one below so asks and Spotlight Ref work again.</span>
              </div>
            )}
            <AgentPicker
              label="Base agent"
              value={agent}
              agents={agents}
              loading={loading}
              err={err}
              onSelect={setBaseAgent}
              placeholder="Base agent id (defaults to Métis)"
              disabled={agentsLocked}
              defaultId={DUST_BASE_AGENT_ID}
              onEmptyBlur={() => setBaseAgent(DUST_BASE_AGENT_ID)}
            />
            {selectedAgent && (
              <div className={selectedAgentRunsSonnet ? 'text-[11px] text-[var(--cl-success)]' : 'text-[11px] text-[color:var(--cl-muted-foreground)]'}>
                {selectedAgentRunsSonnet
                  ? `Agent reports model: Anthropic ${selectedAgent.modelId}`
                  : `This agent reports ${selectedAgent.modelProviderId || 'an unknown provider'} ${selectedAgent.modelId || 'with no model id'}, not Anthropic Sonnet. It will still work, replies may just differ in tone or quality.`}
              </div>
            )}
          </div>

          {/* Thinking agent — used for hard/coding questions & Think mode. Still yours to pick. */}
          <label htmlFor={thinkSel} className="mt-1 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
            Thinking agent · hard, coding questions · optional
          </label>
          <AgentPicker
            id={thinkSel}
            label="Thinking agent"
            value={thinkAgent}
            agents={agents}
            loading={loading}
            err={err}
            onSelect={setThinkAgent}
            placeholder="Thinking agent id (optional, defaults to base)"
            emptyOption="Same as base agent"
          />

          {/* Spotlight Ref agent is also hard-locked — not a picker. Same read-only pattern as base. */}
          <div className="mt-1 flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              Spotlight Ref agent · finds sales references for the live use case
              <span className={managedChipCls}>Managed by your organization</span>
            </span>
            {spotlightAgentMissing && (
              <div className="flex items-start gap-1.5 rounded-[8px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-2.5 py-1.5 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
                <Info size={13} className="mt-0.5 shrink-0" />
                <span>The Spotlight Ref agent is not in this workspace.</span>
              </div>
            )}
            <div className={'w-full opacity-60 ' + ctl}>
              {spotlightAgent ? agents?.find((a) => a.sId === spotlightAgent)?.name ?? spotlightAgent : 'Not configured yet'}
            </div>
          </div>
        </div>

        {/* Live status + activation */}
        <div
          className={[
            'cl-card flex items-center justify-between gap-2 px-3 py-2.5 text-[12px]',
            storedAgentMissing || (err && keySaved && hasWs)
              ? 'text-[color:var(--cl-destructive)]'
              : connected
                ? 'text-[color:var(--cl-success)]'
                : 'text-[color:var(--cl-muted-foreground)]'
          ].join(' ')}
        >
          <span className="flex items-center gap-2">
            {storedAgentMissing || (err && keySaved && hasWs) ? (
              <AlertCircle size={15} />
            ) : connected ? (
              <CircleCheck size={15} />
            ) : (
              <Info size={15} />
            )}
            {storedAgentMissing
              ? "The managed base agent isn't available in this workspace/region. Answers will fail. Check the pasted workspace and US/EU region."
              : err && keySaved && hasWs
                ? err
                : connected
                  ? `Workspace ${settings.dustWorkspaceId}. Base: ${selectedAgentName || agent}${
                      thinkAgent ? `, Thinking: ${agents?.find((a) => a.sId === thinkAgent)?.name || thinkAgent}` : ' (thinking → same as base)'
                    }.`
                  : loading && keySaved && hasWs
                    ? 'Checking Dust connection…'
                    : 'Connect from the Dust CLI above, or finish steps 1–4.'}
          </span>
          {storedAgentMissing ? null : active ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-primary)]">
              <CircleCheck size={12} /> Active
            </span>
          ) : locked ? (
            <span className={managedChipCls}>Managed by your organization</span>
          ) : !dustAllowed ? (
            <span className={managedChipCls}>Restricted by your organization</span>
          ) : (
            connected && (
              <button
                type="button"
                onClick={useDust}
                className="no-drag cl-focus shrink-0 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90"
              >
                Use Dust
              </button>
            )
          )}
        </div>
      </div>
    </Section>
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
    <div className="grid grid-cols-3 gap-2">
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
              'no-drag cl-focus flex flex-col items-center gap-1 rounded-[var(--cl-radius)] border px-2 py-3 transition-colors',
              active
                ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]'
                : 'border-[var(--cl-border)] bg-white/[0.02] hover:bg-white/[0.05]',
              locked ? 'opacity-60 cursor-not-allowed' : ''
            ].join(' ')}
          >
            <c.icon size={16} className={active ? 'text-[color:var(--cl-primary)]' : 'text-[color:var(--cl-muted-foreground)]'} />
            <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">{c.label}</span>
            <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">{c.desc}</span>
            <span className="text-[10px] text-[color:var(--cl-muted-foreground)]">{c.perm}</span>
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
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[12px] text-[color:var(--cl-muted-foreground)]">Microphone</span>
        <select
          value={settings.micDeviceId}
          disabled={locked}
          onChange={(e) => patch({ micDeviceId: e.target.value })}
          aria-label="Microphone"
          className={'no-drag flex-1 ' + ctl + (locked ? ' opacity-60' : '')}
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
    <Section title="Updates" desc="Métis installs updates automatically where the platform allows. Check, download, and install here any time." icon={RefreshCw}>
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
          edited, deleted, or overridden here.
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
      'cloudflare', 'worker', 'ai gateway', 'workers ai', 'metis_proxy_key',
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
      'transcription', 'asr', 'parakeet', 'whisper', 'apple speech', 'speaker identification'
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
      'batch index (1–2× / day)', 'prefer on-device model for consolidation'
    ]
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: ShieldCheck,
    desc: 'What Métis can see, record, and send.',
    keywords: [
      'screen capture', 'screen access', 'conversation memory', 'follow-up', 'memory',
      'recording consent', 'sensitive data', 'redact', 'permissions', 'usage'
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
  onOpenIntelligence,
  onOpenHistory,
  onOpenMeeting
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
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
  const searchMatches = useMemo(() => searchSettingsTabs(query), [query])
  const jumpTo = (id: TabId): void => {
    setTab(id)
    setQuery('')
  }
  // openMeetingsFolder resolves a non-empty string on failure (e.g. the folder was deleted/unmounted) —
  // surface it instead of silently discarding it (was `void window.toto.openMeetingsFolder()`).
  const [meetingsFolderErr, setMeetingsFolderErr] = useState<string | null>(null)
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
  // Standard installers only bundle the compact WASM model (see whisper.worker.ts) — the GPU-accelerated
  // large model is never shipped, so "Best transcription quality" is a no-op there. Default to the
  // no-op copy until the main process confirms otherwise, so a bundled build never overclaims.
  const [asrBundled, setAsrBundled] = useState(true)
  useEffect(() => {
    void window.toto.asrBundled().then(setAsrBundled)
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
    <div className="cl-root panel-enter flex w-full flex-col overflow-hidden rounded-2xl shadow-[var(--shadow-panel)] text-[color:var(--cl-foreground)]">
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
        <div className="no-drag border-b border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] px-3.5 py-2 text-[12px] leading-snug text-[color:var(--cl-foreground)]">
          {notice}
        </div>
      )}

      {/* TOP tab bar (Tony: "setting bar at the top") — horizontal, scrolls if narrow */}
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
        <p className="m-0 border-b border-[var(--cl-border)] px-3.5 py-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          {TABS.find((t) => t.id === tab)?.desc}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 border-b border-[var(--cl-border)] px-2 py-1.5">
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
        className="cl-content scroll-thin max-h-[480px] overflow-y-auto"
      >
        <TabIconContext.Provider value={TABS.find((t) => t.id === tab)?.icon}>
        <div className="flex flex-col gap-6 px-5 pt-5 pb-16">
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
                    <p className="m-0 text-[12px] font-medium text-[color:var(--cl-foreground)]">Overlay chrome</p>
                    <p className="mt-0.5 mb-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                      How Métis sits on the desktop. Changes apply now — no reinstall.
                    </p>
                    <OverlayChromePicker
                      value={settings.overlayLayout}
                      locked={settings.managedKeys.includes('overlayLayout')}
                      onChange={(id) =>
                        patch({
                          overlayLayout: id,
                          autoHideOverlay: autoHideOverlayForLayout(id)
                        })
                      }
                    />
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
              <div className="flex flex-col gap-6">
                <Section title="Listen to" desc="Whose audio Métis transcribes during a meeting." icon={Mic}>
                  <div className="mb-2"><ManagedChip keys={settings.managedKeys} k="audioSource" /></div>
                  <AudioChoices settings={settings} patch={patch} />
                  <MicPicker settings={settings} patch={patch} />
                  {/* Mic-only capture trace — same after-the-fact contract as asrLastFallbackAt in the
                      Speech tab: a meeting that requested system audio ran with the microphone only, so
                      the other side's speech is missing from the transcript. Persists until dismissed. */}
                  {settings.micOnlyFallbackAt != null && (
                    <div className="mt-1 flex items-center justify-between gap-2 pl-1 text-[12px] text-[color:var(--color-ink-3)]">
                      <span>
                        A recent meeting captured your microphone only — the other side&apos;s audio was not
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
                  <ToggleRow
                    label="Best transcription quality"
                    desc={
                      asrBundled
                        ? 'Default is Best. Fast is a power option. This installer ships the compact model — if Best cannot load, Métis runs Fast and says so below (never a silent Fast with a Best label). Download the high-accuracy model to restore Best.'
                        : 'Default is Best (Whisper large multilingual, 60+ languages). Fast is a Settings power option for constrained machines.'
                    }
                    on={settings.asrQuality === 'best'}
                    onChange={(v) => patch({ asrQuality: v ? 'best' : 'fast' })}
                    disabled={settings.managedKeys.includes('asrQuality')}
                  />
                  <div className="flex flex-col gap-1.5 px-1 py-1">
                    <label className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
                      Transcription engine
                      <FieldHint text="Parakeet: bundled NVIDIA Parakeet v3, very fast + accurate for 25 European languages. Whisper: bundled, handles ~99 languages, use it for non-European speech. Apple Speech: Apple's own on-device engine (SFSpeechRecognizer); no extra download, macOS 13+ only.">
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
                      <option value="parakeet">Parakeet · fastest, European languages</option>
                      <option value="whisper">Whisper · ~99 languages</option>
                      <option value="apple">Apple Speech · on-device{isWindows ? ' (macOS only)' : ''}</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5 px-1 py-1">
                    <label className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
                      Spoken language
                      <FieldHint text="The language your meetings usually start in. Whisper decodes in this language and follows automatically if the conversation switches mid-meeting; Apple Speech uses it as its recognizer language; Parakeet always auto-detects. Applies immediately, even during a live meeting. Auto = detect from speech.">
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
                    <div className="-mt-1 flex items-center justify-between gap-2 pl-1 text-[12px] text-[color:var(--color-ink-3)]">
                      <span>
                        Parakeet failed and auto-switched to Whisper for the rest of a recent meeting.{' '}
                        {new Date(settings.asrLastFallbackAt).toLocaleString()}.
                      </span>
                      <TextButton onClick={() => patch({ asrLastFallbackAt: null })}>Dismiss</TextButton>
                    </div>
                  )}
                  <AsrModelRow />
                  {settings.asrImportTierFallbackAt != null && (
                    <div className="-mt-1 flex items-center justify-between gap-2 pl-1 text-[12px] text-[color:var(--color-ink-3)]">
                      <span>
                        An imported recording was transcribed with the compact model — the
                        higher-accuracy one is not installed. Accuracy is lower, especially on
                        non-English audio. {new Date(settings.asrImportTierFallbackAt).toLocaleString()}.
                      </span>
                      <TextButton onClick={() => patch({ asrImportTierFallbackAt: null })}>Dismiss</TextButton>
                    </div>
                  )}
                  {(settings as SettingsWithAsrWebgpuFallback).asrWebgpuFallbackAt != null && (
                    <div className="-mt-1 flex items-center justify-between gap-2 pl-1 text-[12px] text-[color:var(--color-ink-3)]">
                      <span>
                        Best was requested but is not running on this device — Fast is active. Download
                        the high-accuracy model below, or keep Fast as a power option.
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
                              "Not running on this machine — Métis can't tell when you switch windows, so screen asks capture live instead."
                            : // On macOS there is a second way to be off: the reader is gated on Screen
                              // Recording already being granted, because its own capture would otherwise be
                              // what raises the system prompt (MQA-209). The renderer can't tell the two
                              // apart, so name the actionable one first rather than guess wrong.
                              'Not running on this machine — check Screen Recording under Permissions below (a new grant needs a restart). Screen asks capture live instead.'
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
                    desc="Governs the explicit screen asks — the Capture button, its shortcut, quick actions, and pressing Enter with an empty box. Typed questions never capture your screen."
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
                    desc="When on, the next question can refer back to the last few answers (expires after 10 idle minutes). When off (default), every question outside a meeting starts completely fresh — nothing from the previous question leaks into the next answer. During a live meeting, Copilot always keeps the meeting's context either way."
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
                <IdentitySection />
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
                    purpose (Tony, 2026-07-05). */}
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
                    <span aria-hidden>·</span>
                    <a
                      href="mailto:twalteur@amaris.com"
                      className="transition-colors hover:text-[color:var(--cl-foreground)]"
                    >
                      Support
                    </a>
                    <span aria-hidden>·</span>
                    <a
                      href="mailto:twalteur@amaris.com?subject=M%C3%A9tis%20feedback"
                      className="transition-colors hover:text-[color:var(--cl-foreground)]"
                    >
                      Send feedback
                    </a>
                    <span aria-hidden>·</span>
                    <a
                      href="https://www.linkedin.com/in/tonywalteur/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="transition-colors hover:text-[color:var(--cl-foreground)]"
                    >
                      LinkedIn
                    </a>
                  </div>
                  <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                    Built at Mantu · Built by{' '}
                    <a
                      href="https://www.linkedin.com/in/tonywalteur/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-[color:var(--cl-primary)] transition-colors hover:underline"
                    >
                      Tony Walteur
                    </a>
                  </div>
                </div>
              </div>
            )}
        </div>
        </TabIconContext.Provider>
      </main>

      {/* Footer — secondary actions left, Done right */}
      <footer className="cl-footer flex h-14 shrink-0 items-center gap-2 rounded-b-2xl px-4">
        <button
          type="button"
          // Act 6 (Ready, MQA-283): "Replay onboarding" — re-arms the SAME gate App.tsx checks
          // (`!settings.onboardingDone`), so the very next render remounts the six-act experience fresh
          // from hero, exactly like a first run. Nothing else is touched: no other setting is cleared.
          // App.tsx's onboarding gate special-cases `view === 'settings'` to keep showing THIS panel
          // over the gate (so the Ready scene's "Add your own AI provider" link can open Settings
          // without the gate stealing focus back) — so without closing Settings here too, the user
          // would click Replay and see nothing change until they also hit Done. Call onClose so the
          // gate is what they land on immediately, matching what "Replay" promises.
          onClick={() => {
            if (window.confirm("Replay onboarding from the start? Your settings won't change.")) {
              patch({ onboardingDone: false })
              onClose?.()
            }
          }}
          className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-border)] bg-white/[0.03] px-3 py-2 text-[12px] text-[color:var(--cl-foreground)] transition-colors hover:border-[var(--cl-input)] hover:bg-white/[0.08]"
        >
          <RotateCcw size={13} className="shrink-0 text-[color:var(--cl-muted-foreground)]" />
          Replay onboarding
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Log out of Métis? You'll need to sign in again to use Dust and your Mantu Microsoft account.")) {
              onLogout ? onLogout() : void window.toto.signOut()
            }
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

// Last metrics fetched this session — reusing this on remount lets a tab revisit show the previous
// numbers instantly instead of flashing "Loading…" again, while the effect below still refreshes it.
let lastMetrics: EvalMetrics | null = null

/** Usage panel from the local audit log. Computed on-device; never sent anywhere. */
function DiagnosticsSection(): JSX.Element {
  const [m, setM] = useState<EvalMetrics | null>(lastMetrics)
  // Distinguish a genuine load FAILURE from the still-loading state — previously a failed readMetrics()
  // set m back to null, leaving "Loading…" on screen forever with no way to recover.
  const [loadErr, setLoadErr] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoadErr(false)
    void window.toto
      .readMetrics()
      .then((v) => {
        if (!cancelled) {
          setM(v)
          lastMetrics = v
        }
      })
      .catch(() => {
        if (!cancelled) setLoadErr(true)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const ms = (v: number | null): string =>
    v == null ? 'N/A' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`
  const pct = (r: number | null): string => (r == null ? 'N/A' : `${Math.round(r * 100)}%`)
  const n = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))

  if (loadErr) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
        <span>Couldn’t load usage metrics.</span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="no-drag focus-ring rounded-full bg-[var(--cl-card)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--cl-foreground)] hover:bg-white/10"
        >
          Retry
        </button>
      </div>
    )
  }
  if (!m) {
    return <AgentStatus kind="searching" size="inline" caption />
  }
  if (m.answers === 0 && m.acceptance.up + m.acceptance.down === 0) {
    return (
      <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
        No data yet. Ask a few questions and rate some answers, then check back.
      </div>
    )
  }

  const card = (label: string, value: string, sub?: string): JSX.Element => (
    <div key={label} className="flex flex-col gap-0.5 rounded-[10px] bg-[var(--cl-card)] px-3 py-2">
      <span className="text-[10px] uppercase tracking-wide text-[color:var(--cl-muted-foreground)]">{label}</span>
      <span className="text-[16px] font-semibold tabular-nums text-[color:var(--cl-foreground)]">{value}</span>
      {sub && <span className="text-[10px] text-[color:var(--cl-muted-foreground)]">{sub}</span>}
    </div>
  )

  const byProviderEntries = Object.entries(m.byProvider).filter(([, v]) => v > 0)

  return (
    <div className="flex flex-col gap-4">
      {/* Volume */}
      <div className="grid grid-cols-3 gap-2">
        {card('Answers', String(m.answers))}
        {card('Tokens in', n(m.tokensIn))}
        {card('Tokens out', n(m.tokensOut))}
      </div>

      {/* Latency */}
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">Latency</div>
        <div className="grid grid-cols-4 gap-2">
          {card('First token p50', ms(m.ttftP50Ms))}
          {card('First token p95', ms(m.ttftP95Ms))}
          {card('Full answer p50', ms(m.answerP50Ms))}
          {card('Full answer p95', ms(m.answerP95Ms))}
        </div>
      </div>

      {/* Quality */}
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">Quality</div>
        <div className="grid grid-cols-4 gap-2">
          {card('Acceptance', pct(m.acceptance.rate))}
          {card('Rated up', String(m.acceptance.up))}
          {card('Rated down', String(m.acceptance.down))}
          {card('Fallbacks', String(m.fallbacks))}
        </div>
      </div>

      {/* By provider */}
      {byProviderEntries.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">By provider</div>
          <div className="flex flex-wrap gap-2">
            {byProviderEntries.map(([provider, count]) => (
              <div key={provider} className="flex flex-col gap-0.5 rounded-[10px] bg-[var(--cl-card)] px-3 py-2 min-w-[80px]">
                <span className="text-[10px] uppercase tracking-wide text-[color:var(--cl-muted-foreground)]">{provider}</span>
                <span className="text-[16px] font-semibold tabular-nums text-[color:var(--cl-foreground)]">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {m.failures > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
          <AlertCircle size={12} /> {m.failures} answer{m.failures !== 1 ? 's' : ''} failed
        </div>
      )}
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
        desc="Index meetings in at most a few LLM passes per day instead of one extract per save — keeps the second brain token-efficient. Manual Index now still runs immediately."
        icon={Cpu}
      >
        <ToggleRow
          label="Batch index (1–2× / day)"
          desc={
            settings.brainConsolidation.enabled
              ? `Up to ${settings.brainConsolidation.maxPassesPerDay} consolidation pass${settings.brainConsolidation.maxPassesPerDay === 1 ? '' : 'es'} per day. New meetings wait in a durable queue until the next pass.`
              : 'Off: each saved meeting is indexed with an LLM extract as soon as it lands (higher token use).'
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
        desc="Push meeting action items to Plane as work items — see Review → Book next steps. Manual and review-first: nothing sends automatically."
      >
        <PlaneCard settings={settings} patch={patch} />
      </Section>

      <Section
        title="ClickUp"
        desc="Push meeting action items to ClickUp as tasks — see Review → Book next steps. Manual and review-first: nothing sends automatically."
      >
        <ClickupCard settings={settings} patch={patch} />
      </Section>
    </div>
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

const RETENTION_OPTIONS: { days: number; label: string }[] = [
  { days: 0, label: 'Keep forever (default)' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' }
]

/** GDPR/CCPA-facing controls: auto-retention window + a real "delete everything" action. Meeting
 *  recordings capture OTHER people's speech, not just the operator's — this is the one place in
 *  Settings that lets that be bounded or fully erased on demand, not just left to manual per-file cleanup. */
function DangerZoneSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; deleted: number; error?: string } | null>(null)

  const deleteAll = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    const r = await window.toto.recallDeleteAll()
    setResult(r)
    setBusy(false)
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

// ---------------------------------------------------------------------------
// Calendar tab
// ---------------------------------------------------------------------------

// Last Outlook auth status fetched this session — reused on remount so revisiting the Calendar tab
// shows the prior connection state instantly instead of flashing a loading spinner again.
let lastOutlookAuthStatus: AuthStatus | null = null

/**
 * Calendar tab: Microsoft / Outlook (Entra SSO) calendar connection plus the meeting notification toggle.
 */
function CalendarTab({
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

function PermissionDot({ status }: { status: string }): JSX.Element {
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

function PermissionsSection(): JSX.Element {
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
          otherwise the active API (including Dust when that is the provider). The result stays here — it
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

const SHORTCUT_LABELS: Record<HotkeyAction, string> = {
  ask: 'Ask (global)',
  hide: 'Show / hide',
  capture: 'Capture screen',
  factcheck: 'Fact-check',
  'toggle-listen': 'Toggle Listen',
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
              registered — either another app already owns the combo, or it is a navigation key Métis will
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
