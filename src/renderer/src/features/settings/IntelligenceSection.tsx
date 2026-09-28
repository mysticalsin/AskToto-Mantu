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
import { activePillStyle, ClickupCard, McpConnectionCard, PlaneCard } from './Integrations'

let lastMeetings: MeetingSummary[] | null = null
export function TimeSavedSettings({
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

export function IntelligenceTab({
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
export function OperatorMcpServersSection(): JSX.Element | null {
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

export function GraphSection({
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
