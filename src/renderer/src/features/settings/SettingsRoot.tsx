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
import { confirmAction, type NavigationGuardService } from '../../lib/navigation-guard'
import { TapControlCard } from '../../components/TapCalibration'
import { PersonalizeModes } from './PersonalizeModes'
import { IntelligenceTab } from './IntelligenceTab'
import { OperatorLicenseCard } from './OperatorLicenseCard'
import { SupportBundleSection } from './SupportBundleSection'
import { Shortcuts } from './Shortcuts'
import { ProfileEditor } from './ProfileEditor'
import { LicenseSection } from './LicenseSection'
import {
  AlignLeft,
  Calendar,
  Camera,
  Cpu,
  Eye,
  FileSearch,
  FolderOpen,
  IdCard,
  Info,
  MessageSquare,
  Mic,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  User,
  Wand2,
  X,
  Search,
  type LucideIcon
} from 'lucide-react'
import { autoHideOverlayForLayout, overlayLayoutCopy } from '@shared/overlay-chrome'
import { overlayShowsBarRestPicker } from '@shared/overlay-orb'
import type { OverlayPlacement } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'
import { OverlayChromePicker } from '../../components/OverlayChromePicker'
import { OverlayPlacementPicker } from '../../components/OverlayPlacementPicker'
import { OverlayOrbPicker } from '../../components/OverlayOrbPicker'
import { persistOverlayPlacement } from '../../lib/overlay-placement-save'
import { overlayOpacityStatus, reportingPatch } from '../../lib/report-settings-patch'
import { formatResetPhrase } from '@shared/reset-time'
import {
  type PublicSettings,
  type TestKeyResponse,
  type ProfileRecoveryResult,
  type ConversationMode
} from '@shared/ipc'
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
import { LANGUAGE_OPTIONS } from '@shared/lang-id'
import { MantuMark } from '../../components/MantuMark'
import { MetisMark } from '../../components/MetisMark'
import { ExpandableSection, Section, TabIconContext } from '../../ui/Section'
import { ToggleRow } from '../../ui/Toggle'
import { LazyTextarea } from '../../ui/LazyText'
import { ManagedChip } from '../../ui/ManagedChip'
import { ctl } from '../../ui/ctl'
import { DustSetup } from './DustSetup'
import { PrivacyObservationSections } from './PrivacyObservationSections'
import { SensitiveDataSection } from './SensitiveDataSection'
import { UserMemorySection } from './UserMemorySection'
import { OperatorReportingSection, OperatorSourceLine } from './OperatorReportingSection'
import { ReplayHint, SaveErrorLine } from './SettingsNotices'
import { CalendarTab } from './CalendarTab'
import { AboutTab } from './AboutTab'
import { MeetingsTab } from './MeetingsTab'
import { LOG_OUT_CONFIRMATION, REPLAY_ONBOARDING_CONFIRMATION } from './settings-confirmations'
import { PermissionsSection, screenRecordingJustGranted } from './PermissionsSection'
import { AudioTab } from './AudioTab'
import { AUDIO_TAB_KEYWORDS } from './audio-tab-keywords'
import { AiSection } from './AiSection'
import { PROFILE_CREDENTIAL_STORE, isProfileUnlockError } from './credential-store'
import { pickReadyProvider } from './provider-readiness'
import { haltAllOnboardingAudio, unlockOnboardingAudio } from '../../lib/onboarding-music'
import { readLastSettingsPane, writeLastSettingsPane } from '../../lib/settings-last-pane'

// Kept importable from here: its focused tests and callers predate the move to features/settings.
export { pickReadyProvider, screenRecordingJustGranted }
export {
  AppleEngineNotice,
  LocalAiSection,
  asrImportModelDescription,
  detectHint,
  WhisperQualityRow
} from './AiSection'
export {
  CoreAsrAssetsRow,
  OFFICIAL_METIS_INSTALLER_URL,
  coreAsrAssetsView,
  readCoreAsrAssetsStatus,
  retryCoreAsrAssets
} from './CoreAsrAssetsRow'
export { parseAsrCorrections, sameAsrCorrections, serializeAsrCorrections } from './AudioTab'

export { licenseErrorMessage } from './LicenseSection'
export { METIS_FEEDBACK_EMAIL } from './AboutTab'

/**
 * Settings tabpanel scroll classes. Vertical scroll only — overflow-x must stay hidden/clip.
 * overflow-y-auto alone computes overflow-x: auto (CSS overflow pairing), which is the Win
 * Settings sideways-pan bug on Audio / AI.
 */
export const SETTINGS_CONTENT_SCROLL_CLASS = 'cl-content scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden'

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

type TabId = 'ai' | 'personalize' | 'audio' | 'privacy' | 'meetings' | 'intelligence' | 'about' | 'calendar' | 'profile'

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
    keywords: [
      'appearance',
      'transparency',
      'opacity',
      'glass',
      'modes',
      'language',
      'custom instructions',
      'prompt',
      'operator skill'
    ]
  },
  {
    id: 'ai',
    label: 'AI',
    icon: Cpu,
    desc: 'Provider, API keys, local model, and thinking mode.',
    keywords: [
      'provider',
      'api key',
      'anthropic',
      'openai',
      'dust',
      'claude code',
      'codex',
      'local ai',
      'thinking mode',
      'model',
      'other providers',
      'model provider',
      'cli integration',
      'fallback',
      'indexing fallback',
      'offline indexing',
      'backups & limits',
      'nvidia',
      'nim',
      'race a backup provider',
      'hedge',
      'cloudflare',
      'worker',
      'ai gateway',
      'workers ai',
      'metis_proxy_key',
      'oauth',
      'connect',
      'cloudflare account id',
      'cf ai gateway id',
      'routing mode',
      'routing',
      'local',
      'api',
      'auto'
    ]
  },
  {
    // Wave 5 Settings IA: user-facing label "Speech" (plan: AI · Speech · Brain · Integrations · Privacy).
    // Tab id stays 'audio' so persisted deep-links / managed-config and every `tab === 'audio'` guard keep working.
    id: 'audio',
    label: 'Speech',
    icon: Mic,
    desc: 'What Métis listens to, and how it hears you.',
    keywords: AUDIO_TAB_KEYWORDS
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
    keywords: ['meetings & transcripts', 'folder', 'retention', 'danger zone', 'your data', 'delete', 'ingest']
  },
  {
    // Wave 5: label "Brain" — CRM/MCP push lives here as Integrations content under the same tab
    // (overlay width cannot afford a tenth tab). Keywords keep old "Intelligence" / CRM search hits.
    id: 'intelligence',
    label: 'Brain',
    icon: MantuMark,
    desc: 'Your second brain: meetings, wiki, CRM push, knowledge graph.',
    keywords: [
      'mantu intelligence',
      'intelligence',
      'brain',
      'meetings & follow-up',
      'published wiki',
      'polo pre-sales',
      'crm',
      'integrations',
      'knowledge graph',
      'plane',
      'clickup',
      'task management',
      'book next steps',
      'action items',
      'time saved',
      'estimate',
      'consolidation',
      'token',
      'batch index',
      'brain consolidation',
      'batch index (1–2× / day)',
      'prefer on-device model for consolidation',
      '06:00',
      '12:00',
      '18:00',
      'America/Toronto',
      'intelligence index'
    ]
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: ShieldCheck,
    desc: 'What Métis can see, record, and send.',
    keywords: [
      'screen capture',
      'screen access',
      'conversation memory',
      'follow-up',
      'memory',
      'recording consent',
      'sensitive data',
      'redact',
      'permissions',
      'usage',
      'organisation reporting',
      'Organisation reporting',
      'operator',
      'Operator',
      'operator url',
      'skill improvement',
      'ingest secret'
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
  const norm = (s: string): string =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
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
  return TABS.filter((t) => fuzzyIncludes(t.label, q) || t.keywords.some((k) => fuzzyIncludes(k, q))).map((t) => ({
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
  listening = false,
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
  // True while Listen is live: Replay onboarding would swap the window and end the capture, so it is dimmed.
  listening?: boolean
}): JSX.Element {
  // HIG: Settings reopens on the most recently viewed pane unless a caller targets one.
  const [tab, setTab] = useState<TabId>(
    () => initialTab ?? readLastSettingsPane(TABS.map((t) => t.id)) ?? 'personalize'
  )
  // Guided search — jumps between sections instead of the old dig-through-nine-tabs pattern. Matches the
  // tab label plus its real card keywords (see TABS above), so a hit always points at something that
  // actually exists on that tab.
  const [query, setQuery] = useState('')
  // Tabs get `reportedPatch`; fields that explain a failure themselves use the raw `patch`.
  const [saveError, setSaveError] = useState<string | null>(null)
  const reportedPatch = useMemo(() => reportingPatch(patch, setSaveError), [patch])
  const replayHintId = useId()
  const opacityStatus = overlayOpacityStatus(settings.overlayOpacity)
  const [replayState, setReplayState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const [overlayPlacementSave, setOverlayPlacementSave] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null
  })
  const overlayPlacementSaveInFlight = useRef(false)
  const searchMatches = useMemo(() => searchSettingsTabs(query), [query])
  const jumpTo = (id: TabId): void => {
    setTab(id)
    setQuery('')
  }
  const replayOnboarding = async (): Promise<void> => {
    if (replayState.busy || listening) return
    // A deliberately chosen, reversible action: two buttons (Cancel, Replay), Replay is the default.
    const replay = await confirmAction(navigationGuard, REPLAY_ONBOARDING_CONFIRMATION)
    if (!replay) return
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
    writeLastSettingsPane(tab)
  }, [tab])

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
          <Search
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--cl-muted-foreground)]"
          />
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

      {saveError ? <SaveErrorLine message={saveError} /> : null}

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
                patch={reportedPatch}
                saveKey={saveKey}
                recoverEncryptedProfile={recoverEncryptedProfile}
                clearKey={clearKey}
                testKey={testKey}
              />
            )}

            {tab === 'personalize' && (
              <div className="flex flex-col gap-6">
                <Section
                  title="Modes"
                  desc="Edit each mode's prompt and the files it can see, then set the one you want active."
                  icon={Wand2}
                >
                  <PersonalizeModes settings={settings} patch={reportedPatch} />
                </Section>
                <Section
                  title="Appearance"
                  desc="How see-through the overlay's background is. Default matches what you see today."
                  icon={Sparkles}
                >
                  <label className="flex items-center justify-between gap-3 px-1 py-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
                    <span className="flex items-center gap-2">
                      {opacityStatus}
                      <ManagedChip keys={settings.managedKeys} k="overlayOpacity" />
                    </span>
                    <input
                      type="range"
                      aria-label="Overlay transparency"
                      aria-valuetext={opacityStatus}
                      min={0.3}
                      max={1.5}
                      step={0.05}
                      value={settings.overlayOpacity}
                      disabled={settings.managedKeys.includes('overlayOpacity')}
                      onChange={(e) => reportedPatch({ overlayOpacity: Number(e.target.value) })}
                      className={[
                        'no-drag accent-[var(--cl-primary)]',
                        settings.managedKeys.includes('overlayOpacity') ? 'opacity-60' : ''
                      ].join(' ')}
                    />
                  </label>
                  {/* Live preview: --overlay-opacity-scale is set on <html> by App.tsx the instant patch()
                      round-trips, and .glass-strong already reads that var — so this swatch reflects the
                      slider with zero extra plumbing, not a simulated approximation. */}
                  <div className="glass-strong mt-1 flex items-center gap-2 rounded-[12px] px-3 py-2.5">
                    <MetisMark size={16} />
                    <span className="text-[12px] text-[color:var(--color-ink)]">
                      This is how the overlay bar will look.
                    </span>
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
                    <p className="mt-3 mb-0 text-[12px] font-medium text-[color:var(--cl-foreground)]">
                      Overlay chrome
                    </p>
                    <p className="mt-0.5 mb-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                      How Métis sits on the desktop. Changes apply now, no reinstall.
                    </p>
                    <OverlayChromePicker
                      value={settings.overlayLayout}
                      placement={settings.overlayPlacement}
                      copy={overlayLayoutCopy(settings.overlayPlacement)}
                      locked={settings.managedKeys.includes('overlayLayout')}
                      onChange={(id) =>
                        reportedPatch({
                          overlayLayout: id,
                          autoHideOverlay: autoHideOverlayForLayout(id)
                        })
                      }
                    />
                    {overlayShowsBarRestPicker(
                      resolveOverlayPresentation({
                        layout: settings.overlayLayout,
                        placement: settings.overlayPlacement
                      }).layout
                    ) ? (
                      <>
                        <p className="mt-3 mb-0 text-[12px] font-medium text-[color:var(--cl-foreground)]">Bar rest</p>
                        <p className="mt-0.5 mb-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                          Applies when Overlay chrome is Bar.
                        </p>
                        <OverlayOrbPicker
                          value={settings.overlayOrbStyle}
                          locked={settings.managedKeys.includes('overlayOrbStyle')}
                          onChange={(id) => reportedPatch({ overlayOrbStyle: id })}
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
                    onChange={(e) => reportedPatch({ outputLanguage: e.target.value })}
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
                    onChange={(e) => reportedPatch({ summaryLanguage: e.target.value })}
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
                <Section
                  title="Custom instructions"
                  desc="Added to every mode's prompt. Leave blank to use the defaults."
                  icon={AlignLeft}
                >
                  <LazyTextarea
                    value={settings.systemPrompt}
                    onCommit={(v) => reportedPatch({ systemPrompt: v })}
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
              <AudioTab
                settings={settings}
                patch={reportedPatch}
                refreshSettings={refreshSettings}
                tapControl={<TapControlCard settings={settings} patch={reportedPatch} />}
              />
            )}

            {tab === 'privacy' && (
              <div className="flex flex-col gap-6">
                <Section
                  title="Screen capture"
                  desc="Two separate switches: what others can see of Métis, and what Métis can see of your screen."
                  icon={Camera}
                >
                  <ToggleRow
                    label="Hide from screen capture"
                    desc="Hide the Métis window from screen capture & sharing, so people you share with never see it. Doesn't affect screen questions."
                    on={settings.contentProtection}
                    onChange={(v) => reportedPatch({ contentProtection: v })}
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
                    onChange={(v) => reportedPatch({ privateView: v })}
                    disabled={settings.managedKeys.includes('privateView')}
                  />
                </Section>
                <Section
                  title="Screen access"
                  desc="Whether Métis can see your own screen to answer what's in front of you."
                  icon={Eye}
                >
                  <ToggleRow
                    label="Let Métis see your screen on request"
                    desc="Governs the explicit screen asks: the Capture button, its shortcut, quick actions, and pressing Enter with an empty box. Typed questions never capture your screen."
                    on={settings.screenAsk}
                    onChange={(v) => reportedPatch({ screenAsk: v })}
                    disabled={settings.managedKeys.includes('screenAsk')}
                    icon={Eye}
                  />
                </Section>
                <PrivacyObservationSections />
                <Section
                  title="Conversation memory"
                  desc="Whether a new question you type remembers the previous questions and answers."
                  icon={MessageSquare}
                >
                  <ToggleRow
                    label="Carry context into follow-up questions"
                    desc="When on, the next question can refer back to the last few answers (expires after 10 idle minutes). When off (default), every question outside a meeting starts completely fresh. Nothing from the previous question leaks into the next answer. During a live meeting, Copilot always keeps the meeting's context either way."
                    on={settings.askFollowUpMemory}
                    onChange={(v) => reportedPatch({ askFollowUpMemory: v })}
                    disabled={settings.managedKeys.includes('askFollowUpMemory')}
                  />
                  <UserMemorySection />
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
                    onChange={(v) => reportedPatch({ recordingConsent: v })}
                    disabled={settings.managedKeys.includes('recordingConsent')}
                  />
                  <ToggleRow
                    label="Require consent reminder"
                    desc='Show the "other participants are being recorded" reminder every time Listen starts, instead of a one-time-per-day toast. On by default.'
                    on={settings.requireConsentIndicator}
                    onChange={(v) => reportedPatch({ requireConsentIndicator: v })}
                    disabled={settings.managedKeys.includes('requireConsentIndicator')}
                  >
                    <div className="mt-1.5 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                      Useful for regulated environments or when local law requires explicit notice. Note: this also does
                      not distinguish or flag sensitive topics (health, legal, financial) that come up in a recorded
                      call; everything spoken is transcribed and treated the same way.
                    </div>
                  </ToggleRow>
                </Section>
                <SensitiveDataSection settings={settings} patch={reportedPatch} />
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
                  title="Organisation reporting"
                  desc="What this device reports to your organisation."
                  icon={Settings2}
                >
                  <OperatorReportingSection
                    settings={settings}
                    patch={patch}
                    reportedPatch={reportedPatch}
                    refreshSettings={refreshSettings}
                  />
                </Section>
              </div>
            )}

            {tab === 'meetings' && <MeetingsTab settings={settings} patch={reportedPatch} />}

            {tab === 'intelligence' && (
              <IntelligenceTab
                settings={settings}
                patch={reportedPatch}
                onOpenIntelligence={onOpenIntelligence}
                onOpenHistory={onOpenHistory}
                onOpenMeeting={onOpenMeeting}
              />
            )}

            {tab === 'calendar' && <CalendarTab settings={settings} patch={reportedPatch} onSignOut={onLogout} />}

            {tab === 'profile' && (
              <div className="flex flex-col gap-6">
                <OperatorLicenseCard refreshSettings={refreshSettings} showIdentity />
                <OperatorSourceLine />
                <Section
                  title="About you"
                  desc="Used for interview and sales modes. The more detail, the better the answers."
                  icon={User}
                >
                  <ProfileEditor
                    profile={settings.profile}
                    onChange={(p) => reportedPatch({ profile: p })}
                    disabled={settings.managedKeys.includes('profile')}
                  />
                </Section>
                {/* License activation follows the profile — the last setup step once you're set up as you.
                    OFF for phase 1 (LICENSE_UI_ENABLED); the section + LicenseSection component stay in
                    source and reappear here the moment the flag flips. */}
                {LICENSE_UI_ENABLED && (
                  <Section
                    title="License"
                    desc="Activate Métis against your organization's license server."
                    icon={ShieldCheck}
                  >
                    <LicenseSection settings={settings} patch={reportedPatch} />
                  </Section>
                )}
                {/* Keybinds live with Profile: both are "how Métis is set up for you". */}
                <Section title="Keyboard shortcuts" desc="Click any keybind below to edit it." icon={Settings2}>
                  <Shortcuts settings={settings} patch={reportedPatch} />
                </Section>
              </div>
            )}

            {tab === 'about' && <AboutTab />}
          </div>
        </TabIconContext.Provider>
      </main>

      {/* Footer — secondary actions left, Done right */}
      <footer className="cl-footer flex h-14 shrink-0 items-center gap-2 rounded-b-2xl px-4">
        {listening ? <ReplayHint id={replayHintId} /> : null}
        {replayState.error ? (
          <p
            role="alert"
            className="m-0 mr-1 max-w-[250px] text-[11px] leading-snug text-[color:var(--cl-destructive)]"
          >
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
          disabled={replayState.busy || listening}
          aria-describedby={listening ? replayHintId : undefined}
          className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-border)] bg-white/[0.03] px-3 py-2 text-[12px] text-[color:var(--cl-foreground)] transition-colors hover:border-[var(--cl-input)] hover:bg-white/[0.08] disabled:opacity-60"
        >
          <RotateCcw size={13} className="shrink-0 text-[color:var(--cl-muted-foreground)]" />
          {replayState.busy ? 'Starting setup…' : 'Replay onboarding'}
        </button>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              // Deliberately chosen: Log Out is the default (Return), Cancel leads; no destructive styling.
              const logOut = await confirmAction(navigationGuard, LOG_OUT_CONFIRMATION)
              if (logOut) onLogout ? onLogout() : void window.toto.signOut()
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
