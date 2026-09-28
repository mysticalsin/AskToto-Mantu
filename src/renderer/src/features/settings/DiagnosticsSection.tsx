import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import appPackage from '../../../../../package.json'
import type { NavigationGuardService } from '../../lib/navigation-guard'
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
// Last metrics fetched this session — reusing this on remount lets a tab revisit show the previous
// numbers instantly instead of flashing "Loading…" again, while the effect below still refreshes it.
export let lastMetrics: EvalMetrics | null = null

/** Usage panel from the local audit log. Computed on-device; never sent anywhere. */
export function DiagnosticsSection(): JSX.Element {
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
