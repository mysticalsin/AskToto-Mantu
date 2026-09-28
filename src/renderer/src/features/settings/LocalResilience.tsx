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
import { OFFICIAL_METIS_INSTALLER_URL } from './SettingsSupport'
// ---------------------------------------------------------------------------
// Métis Local is installer-owned. This card can read readiness and enable routing, but it cannot download,
// replace, or remove the model at runtime.
// ---------------------------------------------------------------------------

/** Human phrase for a currently-demoted provider, from its cooldown reason + reset instant. */
export function providerLimitLabel(u: { reason: string; until: number }): string {
  const mins = Math.max(0, Math.round((u.until - Date.now()) / 60000))
  const when =
    mins >= 60
      ? formatResetPhrase(u.until)
      : mins >= 1
        ? `retry in ${mins}m`
        : 'retry shortly'
  switch (u.reason) {
    case 'rate-limit':
      return `rate-limited, ${when}`
    case 'quota-exhausted':
      return 'out of credit. Add credit or switch providers'
    case 'usage-cap':
      return `usage limit reached, ${when}`
    default:
      return 'key rejected. Re-enter it below'
  }
}

/**
 * Backups & limits — the resilience layer (main/llm/exhaustion.ts + provider-health.ts). Shows any provider
 * currently demoted because it ran out (rate limit / credit / usage-cap) with its reset, and exposes the two
 * routing policies. The on-device answer floor itself is governed by Local AI's "safety net" toggle above,
 * so it is described here but toggled there — one control, not two that can disagree.
 */
export function ResilienceSection({
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
      desc="When a provider runs out of tokens or credit, Métis automatically falls back, first to a free provider, then to the on-device model, so you are never stuck."
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
          desc="For a quick question, start a second provider if the first hasn't answered within 3 seconds. Whichever answers first wins, the other is cancelled. Can occasionally use both."
          on={settings.resilience.hedge}
          onChange={(v) => patch({ resilience: { ...settings.resilience, hedge: v } })}
        />

        <div className="flex items-start gap-2 rounded-[8px] border border-[var(--cl-border)] bg-white/[0.02] px-3 py-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
          <Cpu size={13} className="mt-0.5 shrink-0" />
          <span>
            Worst case, the on-device model answers with no API at all, controlled by <b>Local AI → use as a
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
export function FallbackOrderEditor({
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
          : 'Automatic. Métis picks the next provider itself. Set an order to decide it yourself.'}
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

/** The packaged live worker cannot select the larger import model (MQA-311). */
export function WhisperQualityRow({
  bundled,
  settings,
  patch
}: {
  bundled: boolean | null | undefined
  settings: Pick<PublicSettings, 'asrEngine' | 'asrQuality' | 'managedKeys'>
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element | null {
  if (settings.asrEngine !== 'whisper') return null
  if (!shouldUseBundledAsr(import.meta.env.PROD, bundled)) {
    return (
      <ToggleRow
        label="Prefer large live Whisper (development)"
        desc="Development preference: try GPU-accelerated Whisper large-v3-turbo when available; otherwise use Whisper base. This does not change import models."
        on={settings.asrQuality === 'best'}
        onChange={(v) => patch({ asrQuality: v ? 'best' : 'fast' })}
        disabled={settings.managedKeys.includes('asrQuality')}
      />
    )
  }
  return (
    <p className="m-0 px-1 py-2 text-[12px] leading-snug text-[color:var(--cl-muted-foreground)]">
      Live Whisper uses the compact Whisper base model in this build. The optional larger model
      applies to imported recordings, not live transcription.
    </p>
  )
}

type AsrImportModelState = { status: string; progress: number; ready: boolean; bytes: number }

/** Availability and the selected import engine are separate, so an installed model is not called active. */
export function asrImportModelDescription(state: AsrImportModelState, engine: PublicSettings['asrEngine']): string {
  const gb = (state.bytes / 1e9).toFixed(2)
  if (state.status === 'downloading') {
    return `Downloading Whisper large-v3-turbo for imported recordings: ${Math.round(state.progress * 100)}% of ${gb} GB.`
  }
  const availability = state.ready
    ? `Whisper large-v3-turbo import model installed (${gb} GB).`
    : `Optional Whisper large-v3-turbo import model: ${gb} GB download. Whisper imports use the compact base model until it is available.`
  const selection = engine === 'parakeet'
    ? ' Parakeet is selected, so imports still use Parakeet. Select Whisper to use this model for imports.'
    : ' Available larger models are used for Whisper imports.'
  return `${availability}${selection} This does not upgrade live transcription.`
}

/** Optional import-only model; state its download size before the user starts the transfer. */
export function AsrModelRow({ engine }: { engine: PublicSettings['asrEngine'] }): JSX.Element | null {
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
        {asrImportModelDescription(state, engine)}
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

export type CoreAsrAssetsView = {
  state: 'checking' | 'ready' | 'downloading' | 'retry' | 'repair' | 'error'
  detail: string
  progress?: number
}

/** Settings must never remain on “Checking” when an IPC renderer round-trip is lost. */
export const CORE_ASR_STATUS_TIMEOUT_MS = 5_000

/**
 * Core Parakeet + Whisper-floor assets are distinct from the optional import-only Whisper model.
 * This derives the only honest recovery action for the immutable packaged payload versus a retryable
 * development/download failure.
 */
export function coreAsrAssetsView(status: AsrAssetsStatus | null | undefined): CoreAsrAssetsView {
  if (!status) return { state: 'checking', detail: 'Checking transcription files…' }
  if (status.ready || status.status === 'ready') return { state: 'ready', detail: 'Transcription files ready.' }

  const detail = bundleFailureUserMessage(status.error || status.label)
  if (isRepairRequiredBundleMessage(detail)) return { state: 'repair', detail }
  if (status.status === 'downloading') {
    return { state: 'downloading', detail: status.label || 'Getting transcription files…', progress: status.progress }
  }
  if (status.status === 'idle') {
    return {
      state: 'retry',
      detail: 'Transcription files are not ready. Select Try again to finish setup on this device.'
    }
  }
  if (status.status === 'error' && isRetryableBundleMessage(detail)) return { state: 'retry', detail }
  return { state: 'error', detail: detail || 'Métis could not read transcription-file status. Check again.' }
}

export function coreAsrAssetsFailureStatus(error: unknown): AsrAssetsStatus {
  const message = bundleFailureUserMessage(error)
  return { ready: false, status: 'error', progress: 0, label: message, error: message }
}

/** Bound an IPC status read so Settings always reaches an actionable state. */
export async function readCoreAsrAssetsStatus(
  read: () => Promise<AsrAssetsStatus>,
  timeoutMs = CORE_ASR_STATUS_TIMEOUT_MS
): Promise<AsrAssetsStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<AsrAssetsStatus>((resolve) => {
        timer = setTimeout(
          () => resolve(coreAsrAssetsFailureStatus(new Error('Transcription-file status timeout. Try again.'))),
          timeoutMs
        )
      })
    ])
  } catch (error) {
    return coreAsrAssetsFailureStatus(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Kept separate for a focused retry test and so the UI never swallows a failed ensure into a spinner. */
export async function retryCoreAsrAssets(
  ensure: () => Promise<AsrAssetsStatus>
): Promise<AsrAssetsStatus> {
  try {
    return await ensure()
  } catch (error) {
    return coreAsrAssetsFailureStatus(error)
  }
}

/**
 * Settings-side recovery route for the required transcription assets. The onboarding view can safely
 * finish while these are deferred only because this route remains available afterwards.
 */
export function CoreAsrAssetsRow({ initialStatus }: { initialStatus?: AsrAssetsStatus | null } = {}): JSX.Element {
  const [status, setStatus] = useState<AsrAssetsStatus | null>(initialStatus ?? null)
  const [retrying, setRetrying] = useState(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const next = await readCoreAsrAssetsStatus(() => window.toto.asrAssetsStatus())
    if (live.current) setStatus(next)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A transfer may have begun during onboarding before Settings opened. Observe its progress here as
  // well, and poll only while active so a dropped event cannot leave a static percentage behind.
  useEffect(() => {
    if (status?.status !== 'downloading') return
    const unsubscribe = window.toto.onImportAssetsProgress?.((progress) => {
      if (live.current) setStatus({ ...progress, ready: progress.status === 'ready' })
    })
    const timer = window.setInterval(() => void refresh(), 1_000)
    return () => {
      unsubscribe?.()
      window.clearInterval(timer)
    }
  }, [refresh, status?.status])

  const retry = (): void => {
    if (retrying) return
    setRetrying(true)
    void retryCoreAsrAssets(window.toto.asrAssetsEnsure)
      .then((next) => {
        if (live.current) setStatus(next)
      })
      .finally(() => {
        if (live.current) setRetrying(false)
      })
  }

  const view = coreAsrAssetsView(status)
  const percent = Math.round(Math.max(0, Math.min(1, view.progress ?? 0)) * 100)

  return (
    <div className="flex flex-col gap-1.5 px-1 py-1" aria-live="polite">
      <div className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
        <span>Transcription files</span>
        {view.state === 'ready' && <Check size={13} className="text-[var(--cl-primary)]" aria-label="Ready" />}
        {view.state === 'checking' || view.state === 'downloading' ? <InlineOrb kind="loading" /> : null}
      </div>
      <p className="m-0 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{view.detail}</p>
      {view.state === 'downloading' && (
        <div
          role="progressbar"
          aria-label="Transcription file download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--cl-border)]"
        >
          <div className="h-full rounded-full bg-[color:var(--cl-primary)] transition-[width] duration-300 ease-out" style={{ width: `${percent}%` }} />
        </div>
      )}
      {view.state === 'retry' && (
        <TextButton icon={RotateCcw} onClick={retry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Try again'}
        </TextButton>
      )}
      {view.state === 'error' && <TextButton icon={RefreshCw} onClick={() => void refresh()}>Check again</TextButton>}
      {view.state === 'repair' && (
        <a
          href={OFFICIAL_METIS_INSTALLER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="no-drag focus-ring inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
        >
          <ExternalLink size={11} />
          Open official installer
        </a>
      )}
    </div>
  )
}

export function LocalAiSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [models, setModels] = useState<LocalModelSummary[] | null>(null)
  const [retrying, setRetrying] = useState(false)
  // Optional models may still be downloading when this card opens. Poll while one is running OR has not
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
    models?.find((m) => m.id === settings.localLlm.modelId) ??
    models?.find((m) => m.unavailableReason === 'downloading') ??
    models?.find((m) => m.unavailableReason === 'insufficient-disk' || m.unavailableReason === 'download-failed') ??
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
  // Download failures and damaged installed resources need different recovery actions. Neither one
  // should direct a user to write into the signed app bundle.
  const downloadFailedText =
    'Could not download the on-device model. Select Retry, or Métis retries on the next launch while Local AI is enabled. Check that huggingface.co is reachable from this network.'
  const notDownloadedText =
    'Not downloaded yet. Enable Local AI to start, or select Retry to download without enabling it.'
  const invalidBundleText = model?.downloadError ??
    'The included local model is missing or damaged. Repair or reinstall Métis from the latest official installer.'

  return (
    <Section
      title="Local AI"
      desc="Optional on-device AI. Off by default. The installer includes Qwen3.5 0.8B and its screenshot projector. The optional 4B model downloads only after selecting it and enabling Local AI or choosing Retry. Cloudflare and any API keys you add stay primary."
      icon={Cpu}
    >
      <div className="flex flex-col gap-3">
        <ToggleRow
          label="Enable Métis Local"
          desc="Use the on-device model for suggestions, summaries, and screenshot reads. The included compact model needs no separate download. An optional model that is not included downloads after you enable it or select Retry. Cloudflare and your other API providers stay available."
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
            : model?.unavailableReason === 'invalid-bundle'
              ? invalidBundleText
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
                      : !settings.localLlm.enabled
                        ? 'Available on this device. Local AI is off. Enable it to use this model.'
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
                : // A running download is a normal state, not a fault: it must not be dressed
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
                  {model.source === 'bundled' ? 'Included with Métis.' : 'Optional download after enabling Local AI or selecting Retry.'} Needs {model.minTotalRamGB} GB RAM.
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
                {model.unavailableReason === 'invalid-bundle'
                  ? invalidBundleText
                  : model.unavailableReason === 'insufficient-ram'
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
            desc="If every configured cloud provider is unreachable or none is set up, run meeting indexing, live suggestions, summaries and screenshot analysis on-device as a last resort instead of failing. Cloud providers are always preferred when they work."
            on={settings.localLlm.fallback}
            onChange={(v) => patch({ localLlm: { ...settings.localLlm, fallback: v } })}
          />
        </div>

        <div className="flex flex-col gap-0.5">
          <ToggleRow
            label="Speaker identification (beta)"
            desc="Label who's speaking in meetings using on-device voice recognition. Voice data never leaves this device."
            on={settings.speakerId.enabled}
            onChange={(v) => patch({ speakerId: { ...settings.speakerId, enabled: v } })}
          />
          {settings.speakerId.enabled && (
            <ToggleRow
              label="Save voiceprints"
              desc="Keep voiceprints on this device so Métis can name people in later meetings. Voiceprints saved by earlier versions are kept and still used."
              on={settings.speakerId.saveVoiceprints}
              onChange={(v) => patch({ speakerId: { ...settings.speakerId, saveVoiceprints: v } })}
            />
          )}
        </div>
      </div>
    </Section>
  )
}
