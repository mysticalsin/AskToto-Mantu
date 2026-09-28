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
import { CLI_PROVIDERS, DUST_CREDENTIAL_STORE, PROFILE_CREDENTIAL_STORE, LICENSE_UI_ENABLED, LazyInput, LazyTextarea, VocabCorrectionsTextarea, ManagedChip, ProviderTile, ExpandableSection, VocabSuggestions, detectHint, isProfileUnlockError, SonioxKeySeat, pickReadyProvider, recommendedProvider, prettyModel, type SettingsWithAsrWebgpuFallback } from './SettingsSupport'
import { AiSection } from './AiSection'
import { AudioChoices, MicPicker } from './AudioSection'
import { CalendarTab, DangerZoneSection, LicenseSection, PermissionsSection } from './PrivacyMeetingsSection'
import { DiagnosticsSection } from './DiagnosticsSection'
import { IntelligenceTab } from './IntelligenceSection'
import { OperatorLicenseCard, primaryBtnStyle } from './Integrations'
import { AsrModelRow, CoreAsrAssetsRow, WhisperQualityRow } from './LocalResilience'
import { PersonalizeModes, SupportBundleSection, UpdatesSection } from './PersonalizationSection'
import { ProfileEditor, Shortcuts } from './ProfileShortcutsSection'
import { METIS_FEEDBACK_EMAIL } from './SettingsSupport'

export { AgentPicker, DustSetup } from './DustSetup'
export { licenseErrorMessage, screenRecordingJustGranted } from './PrivacyMeetingsSection'
export {
  CORE_ASR_STATUS_TIMEOUT_MS,
  CoreAsrAssetsRow,
  LocalAiSection,
  WhisperQualityRow,
  asrImportModelDescription,
  coreAsrAssetsFailureStatus,
  coreAsrAssetsView,
  readCoreAsrAssetsStatus,
  retryCoreAsrAssets
} from './LocalResilience'
export {
  METIS_FEEDBACK_EMAIL,
  OFFICIAL_METIS_INSTALLER_URL,
  detectHint,
  parseAsrCorrections,
  pickReadyProvider,
  sameAsrCorrections,
  serializeAsrCorrections
} from './SettingsSupport'
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
