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
import { CliIntegration } from './CliIntegration'
import { DustSetup } from './DustSetup'
import { LocalAiSection, ResilienceSection } from './LocalResilience'
export function AiSection({
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
  // in the collapsed "Experience: more models" section. Cloudflare is 'featured'. Happy path is
  // Operator OAuth (tile click → default browser `/cloudflare/connect`), not Worker URL + METIS_PROXY_KEY paste.
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
  const connectCloudflare = (): void => {
    void patch({ provider: 'cloudflare' })
    void window.toto.cloudflareConnect()
  }

  const keyEntrySection =
    !CLI_PROVIDERS.has(provider) && provider !== 'cloudflare' && PROVIDERS[provider].kind !== 'local' ? (
    <Section title={`${def.label} key`} desc="Stored encrypted on this device. Never sent anywhere except the provider." icon={Lock}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
          className={'min-w-0 flex-1 ' + ctl + (envKeyActive ? ' opacity-60' : '')}
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
        ) : null}
      </div>
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
    <div className="flex min-w-0 max-w-full flex-col gap-5">
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
          'flex min-w-0 items-center justify-between gap-2 rounded-[10px] border p-3',
          provider === 'anthropic'
            ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]/40'
            : anthropicAllowed
              ? 'border-[var(--cl-border)] bg-white/[0.02]'
              : 'border-[var(--cl-border)] bg-white/[0.02] opacity-60'
        ].join(' ')}
      >
        <div className="min-w-0 flex flex-col gap-0.5">
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
        <div className="grid min-w-0 grid-cols-2 gap-2">
          {featured.map((id) => (
            <ProviderTile
              key={id}
              id={id}
              active={id === provider}
              recommended={id === recommended}
              hasKey={!!settings.hasKeys[id]}
              locked={locked}
              onSelect={() => (id === 'cloudflare' ? connectCloudflare() : patch({ provider: id }))}
            />
          ))}
        </div>
        {locked && (
          <div className="mt-2">
            <span className={managedChipCls}>Managed by your organization</span>
          </div>
        )}
      </Section>

      {provider === 'cloudflare' && (
        <Section
          title="Cloudflare · AI Gateway"
          desc="Log in to Cloudflare. Operator adds the AI Gateway key. Paste is not the happy path."
          icon={ExternalLink}
        >
          <button
            type="button"
            data-cf-aig-connect
            disabled={locked}
            onClick={() => connectCloudflare()}
            className="no-drag cl-focus flex items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <ExternalLink size={13} />
            Log in to Cloudflare
          </button>
          <p className="mt-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Finish in your default browser. Then this seat uses Operator platform keys. No Worker URL
            or METIS_PROXY_KEY paste.
          </p>
          {/* MQA-261 lives on this card now. The generic key box is `provider !== 'cloudflare'`, so a
              `provider === 'cloudflare'` compare there is TS2367 (no overlap) and the restore never
              rendered. Provenance + restore stay here, where Cloudflare is the active provider. */}
          {canRestoreEmbedded ? (
            <>
              <button
                type="button"
                onClick={() => void onRestoreEmbedded()}
                title="Put back the Cloudflare key that shipped with Metis"
                className="no-drag cl-focus mt-2 flex items-center rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08]"
              >
                Restore shipped key
              </button>
              <div className="mt-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
                Metis shipped with a Cloudflare key. Restore it to keep Cloudflare answering, or add another
                provider&apos;s API key below.
              </div>
            </>
          ) : settings.embeddedCloudflareKeyAvailable ? (
            <div className="mt-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
              This key came with Metis rather than from you, so you have no copy of it. You can put it back
              from this card afterwards.
            </div>
          ) : null}
          {restoreMsg && (
            <div className="mt-2 text-[12px] text-[color:var(--cl-foreground)]">{restoreMsg}</div>
          )}
          <div className="mt-3 flex flex-col gap-2 border-t border-[var(--cl-input)] pt-3">
            <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              Nova live speech uses the same vault shape as Operator Keys: a Cloudflare account API token
              (seated above or via Operator), an account id, and an optional AI Gateway id. Blank gateway
              uses default (same as Operator verifyDefaultGatewayPrivacy).
            </p>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              Cloudflare account id
              <ManagedChip keys={settings.managedKeys} k="cloudflareAccountId" />
              <LazyInput
                value={settings.cloudflareAccountId ?? ''}
                disabled={settings.managedKeys.includes('cloudflareAccountId')}
                onCommit={(v) => patch({ cloudflareAccountId: v.trim() })}
                placeholder="32 hex characters"
                aria-label="Cloudflare account id"
                className={['w-full', ctl, settings.managedKeys.includes('cloudflareAccountId') ? 'opacity-60' : ''].join(' ')}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              CF AI Gateway id
              <ManagedChip keys={settings.managedKeys} k="cfAiGatewayId" />
              <LazyInput
                value={settings.cfAiGatewayId ?? ''}
                disabled={settings.managedKeys.includes('cfAiGatewayId')}
                onCommit={(v) => patch({ cfAiGatewayId: v.trim() })}
                placeholder="default"
                aria-label="CF AI Gateway id"
                className={['w-full', ctl, settings.managedKeys.includes('cfAiGatewayId') ? 'opacity-60' : ''].join(' ')}
              />
            </label>
            <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              Account-scoped base URL (.../accounts/&lt;id&gt;/ai/v1) also works; when the Worker proxy URL has
              no account path, set the account id here.
            </p>
          </div>
        </Section>
      )}

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
          <div className="grid min-w-0 grid-cols-2 gap-2">
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
        <div className="flex min-w-0 flex-wrap gap-1.5">
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
                  'no-drag cl-focus min-w-0 flex-1 rounded-[8px] border px-2.5 py-1.5 text-[12px] font-medium transition-colors',
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
