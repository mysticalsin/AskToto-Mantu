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
export function StepBadge({ n, done }: { n: number; done?: boolean }): JSX.Element {
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
  phase:
    | 'idle'
    | 'confirming'
    | 'installing'
    | 'waiting-for-login'
    | 'setup-opened'
    | 'connecting'
    | 'done'
    | 'error'
    | 'install-error'
  msg: string | null
  version: string | null
  binaryPresent?: boolean
  testOk?: boolean
}

export function CliIntegration({
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

  // Step 2: user clicks Continue → install if missing, open login, honest chip.
  const runInstall = async (id: 'claude-cli' | 'codex-cli'): Promise<void> => {
    const startProvider = providerRef.current
    let binaryPresent = false
    let installAttempted = false
    let installOk: boolean | null = null
    let loginAttempted = false
    let testOk = false

    const markConnected = (version: string | null, msg: string | null): void => {
      if (!canShowConnected({ binaryPresent, testOk })) return
      if (mountedRef.current && providerRef.current === startProvider) {
        patch({ provider: id, lastClickedCli: id })
      }
      setState(id, { phase: 'done', msg, version, binaryPresent, testOk: true })
    }

    setState(id, { phase: 'installing', msg: 'Installing', version: null, binaryPresent: false, testOk: false })

    const detected = await window.toto.cliDetect(id)
    binaryPresent = !!detected.ok

    let decision = nextCliSetupStep({
      binaryPresent,
      testOk,
      installAttempted,
      installOk,
      loginAttempted
    })

    if (decision.action === 'install') {
      installAttempted = true
      const installResult = await window.toto.cliInstall(id, (line) => {
        setState(id, { phase: 'installing', msg: line || 'Installing', version: null, binaryPresent, testOk: false })
      })
      if (installResult.needsTerminal) {
        window.toto.cliSetup(id)
        loginAttempted = true
        setState(id, {
          phase: 'waiting-for-login',
          msg: 'Waiting for login',
          version: null,
          binaryPresent,
          testOk: false
        })
        return
      }
      installOk = !!installResult.ok
      if (!installResult.ok) {
        setState(id, {
          phase: 'install-error',
          msg: installResult.error || 'Installation failed.',
          version: null,
          binaryPresent: false,
          testOk: false
        })
        return
      }
      const again = await window.toto.cliDetect(id)
      binaryPresent = !!again.ok
      decision = nextCliSetupStep({
        binaryPresent,
        testOk,
        installAttempted,
        installOk,
        loginAttempted
      })
      if (decision.action === 'fail') {
        setState(id, {
          phase: 'install-error',
          msg: installResult.error || 'Installation finished but the CLI binary is still missing.',
          version: null,
          binaryPresent: false,
          testOk: false
        })
        return
      }
    }

    if (!binaryPresent) {
      setState(id, {
        phase: 'install-error',
        msg: 'CLI binary is not installed.',
        version: null,
        binaryPresent: false,
        testOk: false
      })
      return
    }

    setState(id, { phase: 'connecting', msg: 'Connecting…', version: null, binaryPresent, testOk: false })
    const testResult = await window.toto.cliTest(id)
    testOk = !!testResult.ok && !!binaryPresent
    if (testOk) {
      markConnected(
        testResult.version ?? null,
        testResult.session === 'weekly-limit'
          ? testResult.error || 'Signed in. Weekly usage limit reached, not disconnected.'
          : 'Connected'
      )
      return
    }

    loginAttempted = true
    window.toto.cliLogin(id)
    setState(id, {
      phase: 'waiting-for-login',
      msg: 'Waiting for login',
      version: null,
      binaryPresent,
      testOk: false
    })
    const deadline = Date.now() + 5 * 60 * 1000
    while (mountedRef.current && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2000)
      })
      if (!mountedRef.current) return
      const again = await window.toto.cliTest(id)
      testOk = !!again.ok && binaryPresent
      if (canShowConnected({ binaryPresent, testOk })) {
        markConnected(
          again.version ?? null,
          again.session === 'weekly-limit'
            ? again.error || 'Signed in. Weekly usage limit reached, not disconnected.'
            : 'Connected'
        )
        return
      }
    }
    if (mountedRef.current) {
      setState(id, {
        phase: 'error',
        msg: 'Still waiting for login. Finish signing in, then press Connect.',
        version: null,
        binaryPresent,
        testOk: false
      })
    }
  }

  // Connect: install in-flow if the CLI is missing, then prove a live session. Never mark Connected
  // from this handler — main writes cliConnected only after connectCliSession returns ok.
  const connect = async (id: 'claude-cli' | 'codex-cli'): Promise<void> => {
    // Capture which provider was active when this connect attempt started — see the patch() call below.
    const startProvider = providerRef.current
    setState(id, { phase: 'connecting', msg: 'Connecting…', version: null })
    let r = await window.toto.cliTest(id)
    if (!r.ok && r.session === 'missing') {
      setState(id, { phase: 'installing', msg: 'Installing…', version: null })
      const installResult = await window.toto.cliInstall(id, (line) => {
        setState(id, { phase: 'installing', msg: line, version: null })
      })
      if (installResult.needsTerminal) {
        window.toto.cliSetup(id)
        setState(id, {
          phase: 'setup-opened',
          msg: 'Finish the login in the window that opened, then come back and press Connect.',
          version: null
        })
        return
      }
      if (!installResult.ok) {
        setState(id, {
          phase: 'install-error',
          msg: installResult.error || 'Installation failed.',
          version: null
        })
        return
      }
      setState(id, { phase: 'connecting', msg: 'Connecting…', version: null })
      r = await window.toto.cliTest(id)
    }
    const binaryPresent = r.ok || r.session !== 'missing'
    const testOk = !!r.ok && r.session !== 'missing'
    if (canShowConnected({ binaryPresent, testOk })) {
      // Same stale-resolution + provider-switch guard as runInstall above.
      // Weekly-limit is signed-in: Connect succeeds and we say so, instead of looking disconnected.
      if (mountedRef.current && providerRef.current === startProvider) {
        patch({ provider: id, lastClickedCli: id })
      }
      setState(id, {
        phase: 'done',
        msg:
          r.session === 'weekly-limit'
            ? r.error || 'Signed in. Weekly usage limit reached, not disconnected.'
            : 'Connected',
        version: r.version ?? null,
        binaryPresent: true,
        testOk: true
      })
    } else if (r.session === 'signed-out') {
      window.toto.cliLogin(id)
      setState(id, {
        phase: 'setup-opened',
        msg: 'Installed. Sign in through the window that opened, then come back and press Connect.',
        version: null
      })
    } else {
      setState(id, {
        phase: 'error',
        msg: r.error || 'Could not connect. Finish signing in, then try again.',
        version: null,
        binaryPresent: r.session !== 'missing',
        testOk: false
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
    if (settings.lastClickedCli === id) {
      const other = id === 'claude-cli' ? 'codex-cli' : 'claude-cli'
      next.lastClickedCli = nextConnected[other] ? other : null
    }
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
    const chip = cliSetupChip({
      binaryPresent: !!st.binaryPresent || (st.phase === 'idle' && isConnected),
      testOk: !!st.testOk || (st.phase === 'done' && isConnected) || (st.phase === 'idle' && isConnected),
      installing: st.phase === 'installing',
      loginOpened: st.phase === 'waiting-for-login' || st.phase === 'setup-opened',
      error: st.phase === 'error' || st.phase === 'install-error' ? st.msg : null
    })
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
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0 flex flex-col gap-0.5">
            <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">{def.label}</span>
            <span className="min-w-0 break-words text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{desc}</span>
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

        {chip.kind !== 'idle' && (chip.kind !== 'failed' || !st.msg) && (
          <span
            data-cli-setup-chip={chip.kind}
            className={
              chip.kind === 'connected'
                ? 'inline-flex w-fit items-center gap-1 rounded-full bg-[var(--cl-success)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-success)]'
                : chip.kind === 'failed'
                  ? 'inline-flex w-fit items-center gap-1 rounded-full bg-[var(--cl-destructive)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-destructive)]'
                  : 'inline-flex w-fit items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-primary)]'
            }
          >
            {chip.kind === 'connected' && <CircleCheck size={12} />}
            {chip.kind === 'installing' && <InlineOrb kind="loading" />}
            {chip.kind === 'waiting-for-login' && <InlineOrb kind="loading" />}
            {chip.label}
          </span>
        )}

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
        {(st.phase === 'setup-opened' || st.phase === 'waiting-for-login') && st.msg && chip.kind !== 'waiting-for-login' && (
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

        {/* Connect button — visible in setup-opened, waiting-for-login, or error phases */}
        {(st.phase === 'setup-opened' || st.phase === 'waiting-for-login' || st.phase === 'error') && (
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
      desc="Claude Code and Codex route through your own local install of that tool. It has to be on this device. Set up automatically installs a managed copy if the CLI is missing, or reuses a Claude or Codex login already on this machine. Connected only after a live session check."
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

