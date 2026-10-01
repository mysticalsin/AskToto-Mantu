import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState
} from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Cpu,
  ExternalLink,
  Link2,
  Lightbulb,
  Lock,
  Network,
  RefreshCw,
  RotateCcw,
  Route,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import type {
  AsrAssetsStatus,
  AppleEngineStatus,
  LocalModelSummary,
  ProfileRecoveryResult,
  PublicSettings,
  TestKeyResponse
} from '@shared/ipc'
import { formatResetPhrase } from '@shared/reset-time'
import { bundleFailureUserMessage, isRepairRequiredBundleMessage, isRetryableBundleMessage } from '@shared/bundle-response'
import { MODEL_POLICY_CAPABILITY_LABELS } from '@shared/model-policy'
import {
  PROVIDERS,
  PROVIDER_IDS,
  applyInteractiveGuardrail,
  detectProvider,
  isDustReady,
  requiresUserBaseUrl,
  resolveModelTier,
  type ProviderId
} from '@shared/providers'
import { shouldUseBundledAsr } from '../../lib/asr-offline'
import { canShowConnected, cliSetupChip, nextCliSetupStep } from '@shared/cli-setup-status'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { TextButton } from '../../components/ui'
import { ctl } from '../../ui/ctl'
import { LazyInput } from '../../ui/LazyText'
import { ManagedChip, managedChipCls } from '../../ui/ManagedChip'
import { ExpandableSection, Section } from '../../ui/Section'
import { ToggleRow } from '../../ui/Toggle'
import { DustSetup } from './DustSetup'
import { PROFILE_CREDENTIAL_STORE, isProfileUnlockError } from './credential-store'
import { pickReadyProvider } from './provider-readiness'

// Providers excluded from the generic provider tiles grid + generic "key" Section because they have
// their OWN dedicated setup card instead (dust → DustSetup, claude-cli/codex-cli → CliIntegration).
// Gemini used to be listed here too by mistake — it has no dedicated card, so that made it
// unselectable ANYWHERE in Settings. It's a normal API-key provider like GPT/Grok; removed.
// Métis Local (kind === 'local') is excluded the same way, below, wherever `selectable`/`keyEntrySection`
// is computed — it has its own dedicated LocalAiSection card and is keyless, so it must never render a
// key row or test-key CTA.
const CLI_PROVIDERS = new Set<ProviderId>(['dust', 'claude-cli', 'codex-cli'])


/** Public release page used only when a signed package reports damaged built-in transcription assets. */
export const OFFICIAL_METIS_INSTALLER_URL = 'https://github.com/mysticalsin/Metis-Releases/releases/latest'


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

// End CLI Integration section.


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
  // M2-0412: the fleet model policy's effective askChat provider/model is computed in main from the
  // verified Operator policy. While present, local provider/model choices are informational only.
  const askChatPolicy = settings.modelPolicyCapabilities.askChat
  const modelPolicyLocked = !!askChatPolicy
  const providerLocked = locked || modelPolicyLocked

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
    if (providerLocked) return
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
                disabled={provider === 'anthropic' || modelPolicyLocked || settings.managedKeys.includes('providerModels')}
                onCommit={(v) => patch({ providerModels: { ...settings.providerModels, [provider]: v } })}
                placeholder={def.fastModel || 'base model id'}
                className={[
                  'flex-1 min-w-0', ctl,
                  provider === 'anthropic' || modelPolicyLocked || settings.managedKeys.includes('providerModels') ? 'opacity-60' : ''
                ].join(' ')}
              />
              <ManagedChip keys={settings.managedKeys} k="providerModels" />
              {modelPolicyLocked && <span className={managedChipCls}>Managed by the Operator portal</span>}
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
              disabled={provider === 'anthropic' || modelPolicyLocked || settings.managedKeys.includes('providerModelsThinking')}
              onCommit={(v) =>
                patch({
                  providerModelsThinking: { ...settings.providerModelsThinking, [provider]: v }
                })
              }
              placeholder={def.thinkModel || def.defaultModel || 'thinking model id'}
              className={[
                'w-full', ctl,
                provider === 'anthropic' || modelPolicyLocked || settings.managedKeys.includes('providerModelsThinking') ? 'opacity-60' : ''
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

  const localModelPolicy = settings.modelPolicyCapabilities.localModel

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-5">
      {Object.keys(settings.modelPolicyCapabilities).length === 0 && (
        <div className="flex items-center gap-2 rounded-[10px] border border-[var(--cl-border)] bg-white/[0.02] p-3 text-[12px] text-[color:var(--cl-muted-foreground)]">
          <ShieldCheck size={14} className="shrink-0" />
          <span>Models: not managed. This device uses its own model settings until the owner sets a policy on the Operator portal.</span>
        </div>
      )}
      {askChatPolicy && (
        <div className="flex items-center gap-2 rounded-[10px] border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] p-3 text-[12px] text-[color:var(--cl-foreground)]">
          <ShieldCheck size={14} className="shrink-0 text-[color:var(--cl-primary)]" />
          <span>
            Managed by your organization: Ask/chat uses{' '}
            <strong>{PROVIDERS[askChatPolicy.provider as ProviderId]?.label ?? askChatPolicy.provider}</strong> ({askChatPolicy.model}
            ), set on the Operator portal.
          </span>
        </div>
      )}
      {localModelPolicy && (
        <div className="flex items-center gap-2 rounded-[10px] border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] p-3 text-[12px] text-[color:var(--cl-foreground)]">
          <ShieldCheck size={14} className="shrink-0 text-[color:var(--cl-primary)]" />
          <span>
            Managed by your organization: {MODEL_POLICY_CAPABILITY_LABELS.localModel} uses <strong>{localModelPolicy.provider}</strong>{' '}
            ({localModelPolicy.model}), set on the Operator portal.
          </span>
        </div>
      )}

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
        ) : providerLocked ? (
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
          disabled={providerLocked}
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
              locked={providerLocked}
              onSelect={() => (id === 'cloudflare' ? connectCloudflare() : patch({ provider: id }))}
            />
          ))}
        </div>
        {providerLocked && (
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
            disabled={providerLocked}
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
                locked={providerLocked}
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
          {providerLocked && (
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

/** M2-0430: Apple's on-device model is present but unusable until the owner accepts the Foundation Models
 *  CLI terms. Only that state renders: every other status needs no action, or none the user can take. */
export function AppleEngineNotice({ status }: { status: AppleEngineStatus }): JSX.Element | null {
  if (status !== 'unlicensed') return null
  return (
    <div className="flex items-start gap-2 rounded-[8px] border border-[var(--cl-border)] bg-white/[0.02] px-3 py-2 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
      <Cpu size={13} className="mt-[1px] shrink-0" />
      <span>
        Apple Intelligence is available on this Mac, but its Foundation Models tool is waiting for a one-time
        license acceptance. To enable it, open Terminal, run <code>sudo fm license</code> and accept the terms,
        then restart Métis. Métis then prefers Apple&apos;s model for suggestions and summaries that fit it.
      </span>
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
  const [appleEngine, setAppleEngine] = useState<AppleEngineStatus>('unsupported')
  useEffect(() => {
    let mounted = true
    void window.toto.localAppleEngineStatus().then(
      (status) => { if (mounted) setAppleEngine(status) },
      () => {}
    )
    return () => { mounted = false }
  }, [])
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

        <AppleEngineNotice status={appleEngine} />

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
