import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ExternalLink,
  Mic,
  Volume2,
  Headphones,
  ChevronDown,
  Sparkles,
  FolderOpen,
  FolderCog,
  AlertCircle,
  Trash2,
  Loader2,
  Heart,
  Cpu,
  Wand2,
  ShieldCheck,
  Keyboard,
  Info,
  X,
  Search,
  RefreshCw,
  Link2,
  CircleCheck,
  FileText,
  Upload,
  RotateCcw,
  Trash,
  Network
} from 'lucide-react'
import {
  DEFAULT_SHORTCUTS,
  HOTKEY_ACTIONS,
  type PublicSettings,
  type Profile,
  type TestKeyResponse,
  type DustAgent,
  type ConversationMode,
  type AuthStatus,
  type GraphStatus,
  type HotkeyAction
} from '@shared/ipc'
import {
  PROVIDERS,
  PROVIDER_IDS,
  detectProvider,
  parseDustUrl,
  resolveModelTier,
  type ProviderId
} from '@shared/providers'
import { DEFAULT_MODE_PROMPTS } from '@shared/prompts'
import { ModePicker } from './ModePicker'
import { MantuLogo } from './MantuLogo'
import { MantuMark } from './MantuMark'
import { usePermissions } from '../state'

const ctl =
  'no-drag font-body cl-input cl-focus px-3 py-2.5 text-[13px] text-[color:var(--cl-foreground)]'

/** Friendly name for a routed model in the thinking-mode explainer. Keeps raw model ids out of
 *  user-facing copy — recognized brands by name, everything else as a plain tier word. */
function prettyModel(m: string, provider: ProviderId, tier: 'base' | 'think'): string {
  if (provider === 'dust') return tier === 'think' ? 'your thinking agent' : 'your base agent'
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
  id
}: {
  value: string
  onCommit: (v: string) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  id?: string
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
    />
  )
}

function LazyInput({
  value,
  onCommit,
  className,
  placeholder,
  disabled,
  id
}: {
  value: string
  onCommit: (v: string) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  id?: string
}): JSX.Element {
  const { local, onChange, onBlur } = useLazyText(value, onCommit)
  return (
    <input
      id={id}
      value={local}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={className}
    />
  )
}

const managedChipCls =
  'inline-flex items-center gap-1 rounded-full border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] px-1.5 py-0 text-[10px] font-medium text-[color:var(--cl-primary)]'

function ManagedChip({ keys, k }: { keys: string[]; k: string }): JSX.Element | null {
  return keys.includes(k) ? <span className={managedChipCls}>Managed by your organization</span> : null
}

function Section({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="flex flex-col">
      <div className="mb-2.5">
        <div className="cl-eyebrow flex h-[18px] items-center font-semibold">{title}</div>
        {desc && (
          <div className="mt-1 text-[12px] text-[color:var(--cl-muted-foreground)]">{desc}</div>
        )}
      </div>
      {children}
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

function ToggleRow({
  label,
  desc,
  on,
  onChange,
  children,
  disabled = false
}: {
  label: string
  desc: string
  on: boolean
  onChange: (v: boolean) => void
  children?: ReactNode
  disabled?: boolean
}): JSX.Element {
  const id = useId()
  const toggleId = `${id}-toggle`
  return (
    <label
      htmlFor={toggleId}
      className={[
        'no-drag flex w-full items-center justify-between gap-3 rounded-xl px-1 py-2 text-left',
        disabled ? 'cursor-default' : 'cursor-pointer'
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
          {label}
          {disabled && <span className={managedChipCls}>Managed by your organization</span>}
        </div>
        <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">{desc}</div>
        {children}
      </div>
      <Toggle id={toggleId} on={on} onChange={onChange} label={label} disabled={disabled} />
    </label>
  )
}

/** Friendly hint for an auto-detected or ambiguous pasted key. */
function detectHint(value: string, current: ProviderId): { kind: 'ok' | 'tip'; text: string } | null {
  const v = value.trim()
  if (!v) return null
  const id = detectProvider(v)
  if (id) {
    if (id === current) return { kind: 'ok', text: `Detected ${PROVIDERS[id].label}.` }
    return { kind: 'ok', text: `Detected ${PROVIDERS[id].label} — selected it for you.` }
  }
  if (/^sk-/.test(v)) {
    return {
      kind: 'tip',
      text: 'This key shape is shared by several providers — pick the right one above.'
    }
  }
  return null
}

function AiSection({
  settings,
  patch,
  saveKey,
  clearKey,
  testKey
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  saveKey: (provider: ProviderId, k: string) => Promise<void>
  clearKey: (provider: ProviderId) => Promise<void>
  testKey: (provider: ProviderId, k: string) => Promise<TestKeyResponse>
}): JSX.Element {
  const provider = settings.provider
  const def = PROVIDERS[provider]
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [test, setTest] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; message?: string }>({
    status: 'idle'
  })
  const [adv, setAdv] = useState(false)
  const [filter, setFilter] = useState('')
  const skipClearRef = useRef(false) // don't wipe a freshly-pasted key when detection switches provider
  const model = settings.providerModels[provider] ?? def.defaultModel
  const baseModelName = resolveModelTier(provider, settings.providerModels, settings.providerModelsThinking, 'base')
  const thinkModelName = resolveModelTier(provider, settings.providerModels, settings.providerModelsThinking, 'think')
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

  // Auto-detect provider from the key as the user pastes/types.
  const onKeyChange = (value: string): void => {
    setKey(value)
    setTest({ status: 'idle' })
    if (locked) return
    const id = detectProvider(value)
    if (id && id !== provider) {
      skipClearRef.current = true // keep the key we just captured across the provider switch
      patch({ provider: id })
    }
  }

  const onSave = async (): Promise<void> => {
    const trimmed = key.trim()
    if (!trimmed) {
      await clearKey(provider)
      setKey('')
      setTest({ status: 'idle' })
      return
    }
    try {
      await saveKey(provider, trimmed)
    } catch (e) {
      // e.g. OS encryption unavailable — store.setApiKey throws; don't fail silently.
      setTest({ status: 'error', message: e instanceof Error ? e.message : 'Could not save the key.' })
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
    // Auto-verify the key right after saving so the user immediately sees whether it actually works —
    // no separate "Test" click. The ✓/✗ status renders below.
    setTest({ status: 'loading' })
    try {
      const res = await testKey(provider, trimmed)
      if (res.ok) setTest({ status: 'ok', message: 'Key is valid and working.' })
      else setTest({ status: 'error', message: res.error || 'Saved, but the key did not work — check it and re-save.' })
    } catch (e) {
      setTest({ status: 'error', message: e instanceof Error ? e.message : 'Saved, but could not verify the key.' })
    }
    setKey('')
  }

  const onTest = async (): Promise<void> => {
    const trimmed = key.trim()
    if (!trimmed) {
      setTest({ status: 'error', message: 'Paste a key above to test it.' })
      return
    }
    setTest({ status: 'loading' })
    const res = await testKey(provider, trimmed)
    if (res.ok) setTest({ status: 'ok', message: 'Key is valid.' })
    else setTest({ status: 'error', message: res.error || 'Key test failed.' })
  }

  const onRemove = async (): Promise<void> => {
    await clearKey(provider)
    setKey('')
    setTest({ status: 'idle' })
  }

  const hint = detectHint(key, provider)
  const q = filter.trim().toLowerCase()
  // Dust is its own first-class integration (rendered above), not a tile alongside the raw LLMs.
  const shown = PROVIDER_IDS.filter(
    (id) => id !== 'dust' && (!q || PROVIDERS[id].label.toLowerCase().includes(q))
  )

  return (
    <div className="flex flex-col gap-5">
      {/* Dust — AskToto's primary brain (your Second Brain agents). Always here, not a tile. */}
      <DustSetup
        settings={settings}
        patch={patch}
        saveKey={saveKey}
        clearKey={clearKey}
        active={provider === 'dust'}
      />

      <Section title="Or use a model provider" desc="Prefer a raw model? Pick one — paste a key and AskToto detects most of them.">
        {PROVIDER_IDS.length > 8 && (
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
        <div className="grid grid-cols-3 gap-2">
          {shown.map((id) => {
            const active = id === provider
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                disabled={locked}
                onClick={() => patch({ provider: id })}
                className={[
                  'no-drag cl-focus flex items-center justify-between gap-1.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors',
                  active
                    ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]'
                    : 'border-[var(--cl-border)] bg-white/[0.02] hover:bg-white/[0.05]',
                  locked ? 'opacity-60 cursor-not-allowed' : ''
                ].join(' ')}
              >
                <span className="truncate text-[12px] font-medium text-[color:var(--cl-foreground)]">
                  {PROVIDERS[id].label}
                </span>
                {settings.hasKeys[id] && (
                  <Check size={14} className="shrink-0 text-[color:var(--cl-success)]" />
                )}
              </button>
            )
          })}
        </div>
        {locked && (
          <div className="mt-2">
            <span className={managedChipCls}>Managed by your organization</span>
          </div>
        )}
      </Section>

      {provider !== 'dust' && (
      <Section title={`${def.label} key`} desc="Stored encrypted on this device. It never leaves your machine except to call the provider.">
        <div className="flex items-center gap-2">
          <label htmlFor={keyInputId} className="sr-only">
            {def.label} API key
          </label>
          <input
            id={keyInputId}
            type="password"
            value={key}
            onChange={(e) => onKeyChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSave()}
            placeholder={
              settings.hasKeys[provider] ? '•••••• saved — paste to replace' : `Paste your ${def.label} key`
            }
            className={'flex-1 ' + ctl}
          />
          <button
            type="button"
            onClick={onSave}
            className="no-drag cl-focus flex items-center gap-1 rounded-[10px] bg-[var(--cl-primary)] px-4 py-2.5 text-[13px] font-medium text-white hover:opacity-90"
          >
            {saved ? <Check size={14} /> : null}
            {saved ? 'Saved' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onTest}
            disabled={test.status === 'loading'}
            className="no-drag cl-focus flex items-center gap-1 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2.5 text-[13px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-50"
          >
            {test.status === 'loading' ? <Loader2 size={14} className="animate-spin" /> : null}
            Test
          </button>
          {settings.hasKeys[provider] && (
            <button
              type="button"
              onClick={onRemove}
              title="Remove saved key"
              className="no-drag cl-focus flex items-center justify-center rounded-[10px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-3 py-2.5 text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/20"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>

        {hint && (
          <div
            className={[
              'mt-2 flex items-center gap-1.5 text-[12px]',
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
              'mt-2 flex items-center gap-1.5 text-[12px]',
              test.status === 'ok'
                ? 'text-[color:var(--cl-success)]'
                : 'text-[color:var(--cl-destructive)]'
            ].join(' ')}
          >
            {test.status === 'ok' ? <Check size={13} /> : <AlertCircle size={13} />}
            {test.message}
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
              rel="noreferrer"
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
                <input
                  id={modelInputId}
                  list={`m-${provider}`}
                  value={model}
                  disabled={settings.managedKeys.includes('providerModels')}
                  onChange={(e) =>
                    patch({ providerModels: { ...settings.providerModels, [provider]: e.target.value } })
                  }
                  placeholder={def.fastModel || 'base model id'}
                  className={['w-full', ctl, settings.managedKeys.includes('providerModels') ? 'opacity-60' : ''].join(' ')}
                />
                <ManagedChip keys={settings.managedKeys} k="providerModels" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`think-${provider}`} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                Thinking model · hard, coding questions
              </label>
              <input
                id={`think-${provider}`}
                list={`m-${provider}`}
                value={settings.providerModelsThinking[provider] ?? ''}
                disabled={settings.managedKeys.includes('providerModelsThinking')}
                onChange={(e) =>
                  patch({
                    providerModelsThinking: { ...settings.providerModelsThinking, [provider]: e.target.value }
                  })
                }
                placeholder={def.thinkModel || def.defaultModel || 'thinking model id'}
                className={['w-full', ctl, settings.managedKeys.includes('providerModelsThinking') ? 'opacity-60' : ''].join(' ')}
              />
            </div>
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
                  className={['w-full', ctl, settings.managedKeys.includes('customBaseUrl') ? 'opacity-60' : ''].join(' ')}
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
      )}

      {/* Thinking mode — applies to whatever's active (raw model tiers, or your two Dust agents) */}
      <Section title="Thinking mode" desc="When to use a fast model vs. a deeper one for harder questions.">
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
            ? `Auto — simple questions use ${prettyModel(baseModelName, provider, 'base')}; coding, engineering & complex go to ${prettyModel(thinkModelName, provider, 'think')}.`
            : settings.thinkingMode === 'always'
              ? `Every answer uses ${prettyModel(thinkModelName, provider, 'think')} (deep mode).`
              : `Every answer uses ${prettyModel(baseModelName, provider, 'base')} (fastest & cheapest).`}
        </span>
      </Section>
    </div>
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

function DustSetup({
  settings,
  patch,
  saveKey,
  clearKey,
  active
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  saveKey: (provider: ProviderId, k: string) => Promise<void>
  clearKey: (provider: ProviderId) => Promise<void>
  active: boolean
}): JSX.Element {
  const [link, setLink] = useState('')
  const [dustKey, setDustKey] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [agents, setAgents] = useState<DustAgent[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [cli, setCli] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({
    busy: false,
    msg: null,
    ok: false
  })
  const linkId = useId()
  const wsId = useId()
  const agentSel = useId()
  const thinkSel = useId()

  const isEu = /eu\.dust\.tt/i.test(settings.dustBaseUrl)
  const agent = settings.providerModels['dust'] ?? ''
  const thinkAgent = settings.providerModelsThinking['dust'] ?? ''
  const keySaved = !!settings.hasKeys['dust']
  const hasWs = !!settings.dustWorkspaceId.trim()
  const connected = keySaved && hasWs && !!agent
  const selectedAgentName = agents?.find((a) => a.sId === agent)?.name

  // Connect locally by importing the Dust CLI session (token + workspace + region) from the keychain.
  // On success: activate Dust + load the agents (proves the token works) so the user just picks them.
  const connectCli = async (): Promise<void> => {
    setCli({ busy: true, msg: null, ok: false })
    const r = await window.toto.dustImportCli()
    if (!r.ok) {
      // No CLI session found → automatically kick off the setup (install + interactive login) instead of
      // just printing a command. The login needs a browser OAuth, so it opens in a Terminal window.
      setCli({ busy: true, ok: false, msg: 'No Dust CLI found — starting setup…' })
      const s = await window.toto.dustSetupCli()
      setCli({
        busy: false,
        ok: false,
        msg: s.ok
          ? 'Setup opened in Terminal. Finish the Dust login there, then click "Connect from Dust CLI" again.'
          : s.error || r.error || 'Could not start the Dust CLI setup.'
      })
      return
    }
    await patch({ provider: 'dust' }) // import set key/workspace/region in main; make Dust active + refresh
    setCli({ busy: false, ok: true, msg: `Connected — workspace ${r.workspaceId}. Loading your agents…` })
    await loadAgents()
  }

  // Save a Dust API key (manual alternative to the CLI). Dust keeps its own key, independent of the
  // raw-provider key field — so Dust stays self-contained whatever the active provider is.
  const saveDustKey = async (): Promise<void> => {
    const k = dustKey.trim()
    if (!k) return
    setKeySaving(true)
    await saveKey('dust', k)
    setDustKey('')
    setKeySaving(false)
  }
  const removeDustKey = async (): Promise<void> => {
    await clearKey('dust')
  }
  const useDust = (): void => void patch({ provider: 'dust' })

  // Paste any Dust link → auto-fill workspace, region, and (if present) the agent.
  const onLink = (v: string): void => {
    setLink(v)
    const p = parseDustUrl(v)
    const next: Partial<PublicSettings> = {}
    if (p.workspaceId) next.dustWorkspaceId = p.workspaceId
    if (p.baseUrl) next.dustBaseUrl = p.baseUrl
    if (p.agentId) next.providerModels = { ...settings.providerModels, dust: p.agentId }
    if (Object.keys(next).length) patch(next)
  }

  const loadAgents = async (): Promise<void> => {
    setLoading(true)
    setErr(null)
    const r = await window.toto.dustListAgents()
    setLoading(false)
    if (r.ok && r.agents) {
      setAgents(r.agents)
      if (!agent && r.agents[0]) {
        patch({ providerModels: { ...settings.providerModels, dust: r.agents[0].sId } })
      }
    } else {
      setAgents(null)
      setErr(r.error || 'Could not load your agents. Check the key + workspace, then retry.')
    }
  }

  const setAgent = (sId: string): void =>
    patch({ providerModels: { ...settings.providerModels, dust: sId } })

  const setThinkAgent = (sId: string): void =>
    patch({ providerModelsThinking: { ...settings.providerModelsThinking, dust: sId } })

  const regionBtn = (eu: boolean): string =>
    [
      'no-drag cl-focus flex-1 rounded-[8px] border px-3 py-2 text-[12px] font-medium transition-colors',
      isEu === eu
        ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)] text-[color:var(--cl-foreground)]'
        : 'border-[var(--cl-border)] bg-white/[0.02] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.05]'
    ].join(' ')

  return (
    <Section
      title={active ? 'Dust · your brain (active)' : 'Dust · your brain'}
      desc="AskToto's primary brain — your own Dust agents (Second Brain retrieval + tools). Connect once with the Dust CLI, pick a base (Haiku) and thinking (Sonnet) agent."
    >
      <div className="flex flex-col gap-4">
        {/* One-click: import the local Dust CLI session (token + workspace + region) from the keychain */}
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)]/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">
              Connect locally with the Dust CLI
            </span>
            <button
              type="button"
              onClick={connectCli}
              disabled={cli.busy}
              className="no-drag cl-focus flex items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {cli.busy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
              Connect from Dust CLI
            </button>
          </div>
          <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Already ran <code className="rounded bg-white/[0.08] px-1">dust login</code>? This reads your
            session from the keychain — no key to copy. macOS may ask to allow keychain access once.
          </span>
          {cli.msg && (
            <span
              className={[
                'text-[11px]',
                cli.ok ? 'text-[color:var(--cl-success)]' : 'text-[color:var(--cl-destructive)]'
              ].join(' ')}
            >
              {cli.msg}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-[var(--cl-border)]" />
          <span className="text-[10px] uppercase tracking-wide text-[color:var(--cl-muted-foreground)]">
            or set up manually
          </span>
          <div className="h-px flex-1 bg-[var(--cl-border)]" />
        </div>

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
              placeholder="Paste your Dust workspace or agent URL — it fills the rest in"
              className={'w-full pl-7 ' + ctl}
            />
          </div>
          <span className="pl-7 text-[11px] text-[color:var(--cl-muted-foreground)]">
            e.g. https://dust.tt/w/<b>abc123</b>/builder/agents/<b>myAgent</b> — or fill the fields below.
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
          <input
            id={wsId}
            value={settings.dustWorkspaceId}
            onChange={(e) => patch({ dustWorkspaceId: e.target.value })}
            placeholder="Workspace ID (e.g. abc123)"
            className={'w-full ' + ctl}
          />
          <div className="flex gap-2">
            <button type="button" onClick={() => patch({ dustBaseUrl: 'https://dust.tt' })} className={regionBtn(false)}>
              US · dust.tt
            </button>
            <button type="button" onClick={() => patch({ dustBaseUrl: 'https://eu.dust.tt' })} className={regionBtn(true)}>
              EU · eu.dust.tt
            </button>
          </div>
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
                className="no-drag cl-focus rounded-[8px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-2.5 py-1 text-[11px] text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/20"
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
                disabled={keySaving || !dustKey.trim()}
                className="no-drag cl-focus flex items-center gap-1 rounded-[10px] bg-[var(--cl-primary)] px-3 py-2.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {keySaving ? <Loader2 size={14} className="animate-spin" /> : null} Save
              </button>
            </div>
          )}
          <span className="pl-7 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Get one at dust.tt → Settings → API Keys (admin). Or just use “Connect from Dust CLI” above.
          </span>
        </div>

        {/* Step 4 — pick the agent from a live list (no ids to copy) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--cl-foreground)]">
              <StepBadge n={4} done={!!agent} /> Pick your agents
            </div>
            <button
              type="button"
              onClick={loadAgents}
              disabled={loading || !keySaved || !hasWs}
              title={!keySaved || !hasWs ? 'Save your key + workspace first' : 'Load your Dust agents'}
              className="no-drag cl-focus flex items-center gap-1 rounded-[8px] border border-[var(--cl-input)] bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-40"
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {agents ? 'Refresh' : 'Load my agents'}
            </button>
          </div>

          {/* Base agent — used for simple questions (back it with Haiku in Dust) */}
          <label htmlFor={agentSel} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
            Base agent · simple questions (e.g. Haiku-backed)
          </label>
          {agents && agents.length > 0 ? (
            <select id={agentSel} value={agent} onChange={(e) => setAgent(e.target.value)} className={'w-full ' + ctl}>
              <option value="" disabled>
                Select an agent…
              </option>
              {agents.map((a) => (
                <option key={a.sId} value={a.sId}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="Base agent id (e.g. your Haiku agent)"
              className={'w-full ' + ctl}
            />
          )}

          {/* Thinking agent — used for hard/coding questions & Think mode (back it with Sonnet in Dust) */}
          <label htmlFor={thinkSel} className="mt-1 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
            Thinking agent · hard, coding questions (e.g. Sonnet-backed) · optional
          </label>
          {agents && agents.length > 0 ? (
            <select id={thinkSel} value={thinkAgent} onChange={(e) => setThinkAgent(e.target.value)} className={'w-full ' + ctl}>
              <option value="">Same as base agent</option>
              {agents.map((a) => (
                <option key={a.sId} value={a.sId}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={thinkAgent}
              onChange={(e) => setThinkAgent(e.target.value)}
              placeholder="Thinking agent id (optional — defaults to base)"
              className={'w-full ' + ctl}
            />
          )}
          {err && (
            <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
              <AlertCircle size={12} /> {err}
            </div>
          )}
        </div>

        {/* Live status + activation */}
        <div
          className={[
            'cl-card flex items-center justify-between gap-2 px-3 py-2.5 text-[12px]',
            connected ? 'text-[color:var(--cl-success)]' : 'text-[color:var(--cl-muted-foreground)]'
          ].join(' ')}
        >
          <span className="flex items-center gap-2">
            {connected ? <CircleCheck size={15} /> : <Info size={15} />}
            {connected
              ? `Workspace ${settings.dustWorkspaceId}. Base: ${selectedAgentName || agent}${
                  thinkAgent ? `, Thinking: ${agents?.find((a) => a.sId === thinkAgent)?.name || thinkAgent}` : ' (thinking → same as base)'
                }.`
              : 'Connect from the Dust CLI above, or finish steps 1–4.'}
          </span>
          {active ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-primary)]">
              <CircleCheck size={12} /> Active
            </span>
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
      perm: isWin ? 'Needs Mic; Windows prompts for system audio' : 'Needs Mic + Screen Recording',
      icon: Headphones
    },
    {
      id: 'system',
      label: 'Them',
      desc: 'The other person',
      perm: isWin ? 'Windows prompts for system audio' : 'Needs Screen Recording',
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
              'no-drag cl-focus flex flex-col items-center gap-1 rounded-xl border px-2 py-3 transition-colors',
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

const MODE_LABEL: Record<ConversationMode, string> = {
  general: 'General',
  interview: 'Interview',
  meeting: 'Meeting',
  sales: 'Sales',
  negotiation: 'Negotiation',
  presentation: 'Presentation',
  support: 'Support'
}

const LANGUAGE_OPTIONS = [
  'English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese', 'Dutch',
  'Polish', 'Arabic', 'Chinese', 'Japanese', 'Korean', 'Hindi', 'Russian', 'Turkish'
]

/** Editable, pre-filled system prompt for the selected default mode. Plug-and-play with reset. */
function ModePromptEditor({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const mode = settings.mode
  const override = settings.modePrompts[mode]
  const value = override ?? DEFAULT_MODE_PROMPTS[mode]
  const isCustom = !!override && override.trim() !== '' && override !== DEFAULT_MODE_PROMPTS[mode]
  const locked = settings.managedKeys.includes('modePrompts')
  const reset = (): void => {
    const m = { ...settings.modePrompts }
    delete m[mode]
    patch({ modePrompts: m })
  }
  return (
    <Section
      title={`Prompt · ${MODE_LABEL[mode]}`}
      desc="Pre-filled with a strong default. Edit freely; every mode keeps its own. Reset anytime."
    >
      <LazyTextarea
        value={value}
        disabled={locked}
        onCommit={(v) => patch({ modePrompts: { ...settings.modePrompts, [mode]: v } })}
        className={[ctl, 'h-44 w-full resize-none text-[12px] leading-relaxed', locked ? 'opacity-60' : ''].join(' ')}
      />
      <div className="mt-1.5 flex items-center gap-3">
        {isCustom ? (
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
        )}
        <ManagedChip keys={settings.managedKeys} k="modePrompts" />
      </div>
    </Section>
  )
}

const TEXT_FILE_RE = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|css|tsx?|jsx?|py|rb|go|rs|java|sql|sh)$/i

/** Cluely-style "add files for context" — reads text on-device and folds it into every answer. */
function ContextDocs({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const mode = settings.mode
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
    if (droppedForCap > 0) bits.push(`${droppedForCap} not added — 25-document limit reached.`)
    if (skipped.length) bits.push(`Skipped (text files only, ≤2 MB): ${skipped.slice(0, 3).join(', ')}.`)
    if (!bits.length) bits.push('No text files found. Supported: txt, md, csv, json, code…')
    setNote(bits.join(' '))
  }

  const remove = (i: number): void => writeDocs(docs.filter((_, idx) => idx !== i))

  return (
    <Section
      title={`Context documents — ${MODE_LABEL[mode]}`}
      desc="Import what this mode should know about — résumé, deck, brief, specs. Kept per-mode (no cross-leak), read on-device, woven into this mode's answers."
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
          'no-drag flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center transition-colors',
          drag
            ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]'
            : 'border-[var(--cl-input)] bg-white/[0.02] hover:bg-white/[0.04]'
        ].join(' ')}
      >
        <Upload size={18} className="text-[color:var(--cl-primary)]" />
        <span className="text-[13px] text-[color:var(--cl-foreground)]">
          Drop files here or <span className="text-[color:var(--cl-primary)]">browse</span>
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

type TabId = 'ai' | 'personalize' | 'audio' | 'privacy' | 'meetings' | 'shortcuts' | 'about'

const TABS: { id: TabId; label: string; icon: typeof Cpu }[] = [
  { id: 'ai', label: 'Your AI', icon: Cpu },
  { id: 'personalize', label: 'Personalize', icon: Wand2 },
  { id: 'audio', label: 'Audio', icon: Mic },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck },
  { id: 'meetings', label: 'Meetings', icon: FolderOpen },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'about', label: 'About', icon: Info }
]

export function Settings({
  settings,
  patch,
  saveKey,
  clearKey,
  testKey,
  onClose
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  saveKey: (provider: ProviderId, k: string) => Promise<void>
  clearKey: (provider: ProviderId) => Promise<void>
  testKey: (provider: ProviderId, k: string) => Promise<TestKeyResponse>
  onClose?: () => void
}): JSX.Element {
  const [tab, setTab] = useState<TabId>('ai')
  const managed = settings.managedKeys.length > 0

  return (
    <div className="cl-root panel-enter flex w-full flex-col overflow-hidden rounded-2xl shadow-[var(--shadow-panel)] text-[color:var(--cl-foreground)]">
      {/* Draggable header — sits directly under the always-visible AskToto bar */}
      <header className="cl-header drag flex h-11 shrink-0 items-center gap-2 rounded-t-2xl px-3.5">
        <MantuMark size={18} />
        <span className="font-ui text-[14px] font-semibold tracking-tight">Settings</span>
        {managed && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--cl-primary)]">
            Managed by your organization
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="no-drag cl-focus ml-auto flex size-7 items-center justify-center rounded-md text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] hover:text-[color:var(--cl-foreground)]"
        >
          <X size={16} />
        </button>
      </header>

      {/* TOP tab bar (Tony: "setting bar at the top") — horizontal, scrolls if narrow */}
      <nav
        role="tablist"
        aria-label="Settings sections"
        className="cl-tabbar no-drag scroll-thin flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--cl-border)] px-2 py-1.5"
      >
        {TABS.map((t) => {
          const active = t.id === tab
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={active}
              aria-controls="settings-panel"
              onClick={() => setTab(t.id)}
              className={[
                'cl-focus flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors',
                active
                  ? 'bg-[var(--cl-primary)] text-white'
                  : 'text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] hover:text-[color:var(--cl-foreground)]'
              ].join(' ')}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          )
        })}
      </nav>

      <main
        role="tabpanel"
        id="settings-panel"
        aria-labelledby={`settings-tab-${tab}`}
        className="cl-content scroll-thin max-h-[480px] overflow-y-auto"
      >
        <div className="flex flex-col gap-6 px-5 py-5">
            {tab === 'ai' && (
              <AiSection settings={settings} patch={patch} saveKey={saveKey} clearKey={clearKey} testKey={testKey} />
            )}

            {tab === 'personalize' && (
              <div className="flex flex-col gap-6">
                <Section title="Default mode" desc="Pick what AskToto is helping with. This is the only place to change it.">
                  <div className="flex items-center gap-2">
                    <ModePicker mode={settings.mode} onChange={(m) => patch({ mode: m })} size="sm" disabled={settings.managedKeys.includes('mode')} />
                    <ManagedChip keys={settings.managedKeys} k="mode" />
                  </div>
                </Section>
                <Section
                  title="Language"
                  desc="AskToto assists live in the speaker's language. Pick the language for your answers, and a separate one for the saved summary/recap (handy when the meeting is in one language but you want the notes in another)."
                >
                  <label className="mb-1 block text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                    Answers & live assist
                  </label>
                  <select
                    value={settings.outputLanguage}
                    onChange={(e) => patch({ outputLanguage: e.target.value })}
                    disabled={settings.managedKeys.includes('outputLanguage')}
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
                <ModePromptEditor settings={settings} patch={patch} />
                <ContextDocs settings={settings} patch={patch} />
                <Section title="About you" desc="The more AskToto knows, the sharper your answers. Used for interview & sales.">
                  <ProfileEditor profile={settings.profile} onChange={(p) => patch({ profile: p })} disabled={settings.managedKeys.includes('profile')} />
                </Section>
              </div>
            )}

            {tab === 'audio' && (
              <div className="flex flex-col gap-6">
                <Section title="Listen to" desc="Whose audio AskToto transcribes during a meeting.">
                  <div className="mb-2"><ManagedChip keys={settings.managedKeys} k="audioSource" /></div>
                  <AudioChoices settings={settings} patch={patch} />
                </Section>
                <Section title="In meetings">
                  <ToggleRow
                    label="Auto-answer"
                    desc="Draft a reply the moment they ask a question."
                    on={settings.autoSuggest}
                    onChange={(v) => patch({ autoSuggest: v })}
                    disabled={settings.managedKeys.includes('autoSuggest')}
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
                    desc="Off = show only what to say; full transcript at the end."
                    on={settings.showLiveTranscript}
                    onChange={(v) => patch({ showLiveTranscript: v })}
                    disabled={settings.managedKeys.includes('showLiveTranscript')}
                  />
                  <ToggleRow
                    label="Play chime when recording starts"
                    desc="A soft audible cue each time Listen begins."
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
                </Section>
              </div>
            )}

            {tab === 'privacy' && (
              <div className="flex flex-col gap-6">
                <Section title="Screen capture" desc="Whether AskToto can be seen when you share or record your screen.">
                  <ToggleRow
                    label="Hide from screen capture"
                    desc="Hide the window from screen capture & sharing."
                    on={settings.contentProtection}
                    onChange={(v) => patch({ contentProtection: v })}
                    disabled={settings.managedKeys.includes('contentProtection')}
                  />
                </Section>
                <Section title="Recording consent" desc="Notice shown to you before AskToto records others.">
                  <ToggleRow
                    label="Require consent reminder"
                    desc='Show the "other participants are being recorded" reminder every time Listen starts.'
                    on={settings.requireConsentIndicator}
                    onChange={(v) => patch({ requireConsentIndicator: v })}
                    disabled={settings.managedKeys.includes('requireConsentIndicator')}
                  >
                    <div className="mt-1.5 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                      Useful for regulated environments or when local law requires explicit notice.
                    </div>
                  </ToggleRow>
                </Section>
              </div>
            )}

            {tab === 'meetings' && (
              <>
              <Section
                title="Meetings & transcripts"
                desc="Every meeting is saved here as a clean note your Dust agents can read and follow up on."
              >
                <div className="cl-card px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={15} className="shrink-0 text-[color:var(--cl-primary)]" />
                    <span className="flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]" title={settings.resolvedMeetingsFolder}>
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
                      onClick={() => void window.toto.openMeetingsFolder()}
                      className={[
                        'no-drag cl-focus flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]',
                        settings.managedKeys.includes('meetingsFolder') ? 'opacity-60 cursor-not-allowed' : ''
                      ].join(' ')}
                    >
                      <FolderOpen size={12} /> Open
                    </button>
                  </div>
                </div>
                <div className="mt-2">
                  <ToggleRow
                    label="Auto-save transcripts"
                    desc="Write the transcript + notes to the folder when a meeting ends."
                    on={settings.autoSaveTranscripts}
                    onChange={(v) => patch({ autoSaveTranscripts: v })}
                    disabled={settings.managedKeys.includes('autoSaveTranscripts')}
                  />
                  {!settings.encryptTranscripts && (
                    <div className="mt-1 flex items-start gap-1.5 px-1 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
                      <AlertCircle size={12} className="mt-0.5 shrink-0" />
                      Transcripts are saved as plain text in your chosen folder. If that folder syncs to the
                      cloud, your data leaves this device.
                    </div>
                  )}
                  <ToggleRow
                    label="Encrypt transcripts at rest"
                    desc="Locks saved transcripts/notes with your OS keychain so they're unreadable on disk. Trade-off: your Dust agents, recall search, and the knowledge graph can't read encrypted files."
                    on={settings.encryptTranscripts}
                    onChange={(v) => patch({ encryptTranscripts: v })}
                    disabled={settings.managedKeys.includes('encryptTranscripts')}
                  >
                    {settings.encryptTranscripts && (
                      <div className="mt-1 flex items-start gap-1.5 px-1 text-[11px] leading-snug text-[color:var(--cl-success)]">
                        <CircleCheck size={12} className="mt-0.5 shrink-0" />
                        Encrypted at rest — even if the folder syncs to the cloud, the contents stay locked to
                        this device. Opening a transcript shows a temporary decrypted copy.
                      </div>
                    )}
                  </ToggleRow>
                  <ToggleRow
                    label="Auto-start on a meeting"
                    desc="Begin listening automatically when a Teams / Zoom / Meet call starts."
                    on={settings.autoStartOnMeeting}
                    onChange={(v) => patch({ autoStartOnMeeting: v })}
                    disabled={settings.managedKeys.includes('autoStartOnMeeting')}
                  >
                    <div className="mt-1.5 flex flex-col gap-1 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                      <span>
                        {window.navigator.platform.toLowerCase().includes('win')
                          ? 'On Windows, AskToto detects meetings by reading window titles and browser tabs.'
                          : 'Needs Accessibility + Automation permissions in System Settings → Privacy & Security.'}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span
                          className={[
                            'inline-block h-1.5 w-1.5 rounded-full',
                            settings.autoStartOnMeeting ? 'bg-[var(--cl-primary)]' : 'bg-white/20'
                          ].join(' ')}
                        />
                        {settings.autoStartOnMeeting ? 'Watching for meetings' : 'Not watching'}
                      </span>
                    </div>
                  </ToggleRow>
                  <ToggleRow
                    label="Launch at login"
                    desc="Open AskToto automatically when you sign in."
                    on={settings.launchAtLogin}
                    onChange={(v) => patch({ launchAtLogin: v })}
                    disabled={settings.managedKeys.includes('launchAtLogin')}
                  />
                  <div className="mt-3 flex flex-col gap-1.5">
                    <label className="text-[12px] font-medium text-[color:var(--cl-foreground)]">
                      Custom meeting apps
                    </label>
                    <textarea
                      value={settings.customMeetingApps.join('\n')}
                      onChange={(e) =>
                        patch({
                          customMeetingApps: e.target.value
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .slice(0, 20)
                        })
                      }
                      placeholder="Around&#10;Amazon Chime&#10;Jitsi"
                      rows={3}
                      disabled={settings.managedKeys.includes('customMeetingApps')}
                      className={[
                        ctl,
                        'h-20 resize-none text-[12px]',
                        settings.managedKeys.includes('customMeetingApps') ? 'opacity-60 cursor-not-allowed' : ''
                      ].join(' ')}
                    />
                    <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                      One app name per line. AskToto will also treat windows with these names as meetings.
                    </span>
                  </div>
                </div>
              </Section>
              <GraphSection settings={settings} patch={patch} />
              </>
            )}

            {tab === 'shortcuts' && (
              <Section title="Keyboard shortcuts" desc="Global shortcuts work even when AskToto is not focused. Leave blank to disable. Use Cmd (Mac) / Ctrl (Windows).">
                <Shortcuts settings={settings} patch={patch} />
              </Section>
            )}

            {tab === 'about' && (
              <div className="flex flex-col gap-6">
                <Section title="Account" desc="Sign-in tying AskToto to your Mantu Microsoft account & Dust.">
                  <AccountRow settings={settings} patch={patch} />
                </Section>
                <Section title="Permissions" desc="Status of the OS permissions AskToto needs.">
                  <PermissionsSection />
                </Section>
                <div className="flex flex-col items-center gap-2 pt-2">
                  <MantuLogo size={22} />
                  <div className="flex items-center gap-1 text-[11px] text-[color:var(--cl-muted-foreground)]">
                    <Heart size={11} className="text-[color:var(--cl-destructive)]" />
                    Built with care by{' '}
                    <a
                      href="https://www.linkedin.com/in/tonywalteur/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 transition-colors hover:text-[color:var(--cl-foreground)]"
                    >
                      Tony Walteur
                    </a>
                  </div>
                </div>
              </div>
            )}
        </div>
      </main>

      {/* Footer — Mantu credit + Done */}
      <footer className="cl-footer flex h-12 shrink-0 items-center justify-between rounded-b-2xl px-4">
        <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
          Built by{' '}
          <a
            href="https://www.linkedin.com/in/tonywalteur/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[color:var(--cl-primary)] underline underline-offset-2"
          >
            Tony Walteur
          </a>{' '}
          · Mantu
        </span>
        <button
          type="button"
          onClick={onClose}
          className="no-drag cl-focus rounded-[10px] bg-[var(--cl-primary)] px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
        >
          Done
        </button>
      </footer>
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
  const refresh = (): void => void window.toto.graphifyStatus().then(setStatus)
  useEffect(refresh, [settings.graphifyEnabled])

  const rebuild = async (): Promise<void> => {
    setBusy(true)
    setStatus(await window.toto.graphifyRebuild())
    setBusy(false)
  }

  return (
    <Section
      title="Knowledge graph"
      desc="Turn your notes into a connected graph — see how meetings, people and topics link. Reuses your Claude / Claude Code (no extra key, never Gemini)."
    >
      <ToggleRow
        label="Build a knowledge graph of my notes"
        desc="Runs graphify over your notes folder. Connections appear in Meeting history (the network icon on each note)."
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
              'Checking…'
            ) : !status.installed ? (
              <span className="text-[color:var(--cl-muted-foreground)]">graphify not found — install it below.</span>
            ) : status.building || busy ? (
              'Building the graph…'
            ) : status.hasGraph ? (
              <span className="text-[color:var(--cl-foreground)]">
                {status.nodes ?? 0} nodes · {status.edges ?? 0} links{status.backend ? ` · ${status.backend}` : ''}
              </span>
            ) : (
              <span className="text-[color:var(--cl-muted-foreground)]">
                No graph yet — Rebuild to create it{status.backend ? ` (via ${status.backend})` : ''}.
              </span>
            )}
          </div>
          {status && !status.installed && (
            <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              Install once: <code className="rounded bg-white/[0.08] px-1">pip install graphifyy</code> or{' '}
              <code className="rounded bg-white/[0.08] px-1">uv tool install graphifyy</code>, then Rebuild.
            </span>
          )}
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
              disabled={busy || status?.building || !status?.installed}
              className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] bg-[var(--cl-primary)] px-3 py-2 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              <RefreshCw size={13} className={busy || status?.building ? 'animate-spin' : ''} /> Rebuild now
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
        </div>
      )}
    </Section>
  )
}

function AccountRow({
  settings,
  patch
}: {
  settings: PublicSettings
  // Real impl (state.ts) returns Promise<void> and awaits disk persistence; typed void to match the
  // Settings prop contract. `await patch(...)` still waits for the write before we re-read auth status.
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [saving, setSaving] = useState(false)
  const [clientId, setClientId] = useState(settings.azureClientId || '')
  const [tenantId, setTenantId] = useState(settings.azureTenantId || '')
  const [domain, setDomain] = useState(settings.azureAllowedDomain || '')
  const refresh = (): void => void window.toto.authStatus().then(setStatus)
  useEffect(refresh, [])

  const signIn = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = await window.toto.signIn()
    setBusy(false)
    if (!r.ok) setErr(r.error || 'Sign-in failed.')
    refresh()
  }
  const signOut = async (): Promise<void> => {
    await window.toto.signOut()
    refresh()
  }

  // Enable Microsoft sign-in in-app: persist the (public, non-secret) Entra IDs, then re-read auth
  // status — readConfig() picks them up so `configured` flips true and the live sign-in button appears.
  const enableSso = async (): Promise<void> => {
    const ci = clientId.trim()
    const ti = tenantId.trim()
    const dom = domain.trim().replace(/^@/, '')
    if (!ci || !ti || !dom) {
      setErr('Fill in all three fields to enable Microsoft sign-in.')
      return
    }
    setSaving(true)
    setErr(null)
    await patch({ azureClientId: ci, azureTenantId: ti, azureAllowedDomain: dom })
    refresh()
    setSaving(false)
    setShowSetup(false)
  }

  const disableSso = async (): Promise<void> => {
    await patch({ azureClientId: '', azureTenantId: '', azureAllowedDomain: '' })
    setClientId('')
    setTenantId('')
    setDomain('')
    refresh()
  }

  if (!status) return <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">Checking…</div>

  const field = (
    label: string,
    val: string,
    set: (v: string) => void,
    placeholder: string
  ): JSX.Element => (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">{label}</span>
      <input
        value={val}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
        className={`${ctl} w-full`}
      />
    </label>
  )

  const setupForm = (
    <div className="mt-1 flex flex-col gap-2.5 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.02] p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[color:var(--cl-primary)]" />
        <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          One-time setup. In{' '}
          <a
            href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[color:var(--cl-primary)] underline underline-offset-2"
          >
            Microsoft Entra <ExternalLink size={10} />
          </a>{' '}
          register an app (platform <b>Mobile &amp; desktop</b>, redirect{' '}
          <code className="rounded bg-white/[0.06] px-1">http://localhost</code>), then paste its IDs.
          These are public identifiers — no secret needed.
        </p>
      </div>
      {field('Application (client) ID', clientId, setClientId, '00000000-0000-0000-0000-000000000000')}
      {field('Directory (tenant) ID', tenantId, setTenantId, '00000000-0000-0000-0000-000000000000')}
      {field('Allowed email domain', domain, setDomain, 'mantu.com')}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={enableSso}
          disabled={saving}
          className="no-drag cl-focus flex items-center justify-center gap-2 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : null}
          Enable Microsoft sign-in
        </button>
        <button
          type="button"
          onClick={() => setShowSetup(false)}
          className="no-drag cl-focus rounded-[8px] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
        >
          Cancel
        </button>
      </div>
    </div>
  )

  return (
    <div className="cl-card flex flex-col gap-2 px-3 py-2.5">
      {status.signedIn ? (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CircleCheck size={15} className="text-[color:var(--cl-success)]" />
            <span className="text-[12px] text-[color:var(--cl-foreground)]">
              Signed in as {status.email}
            </span>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="no-drag cl-focus rounded-[8px] border border-[var(--cl-input)] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.06]"
          >
            Sign out
          </button>
        </div>
      ) : status.configured ? (
        <>
          <button
            type="button"
            onClick={signIn}
            disabled={busy}
            className="no-drag cl-focus flex items-center justify-center gap-2 rounded-[8px] bg-[var(--cl-primary)] px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            Sign in with Microsoft
          </button>
          <div className="flex items-center justify-between">
            <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              Restricted to @{status.domain}. Ties your usage to Dust.
            </span>
            <button
              type="button"
              onClick={disableSso}
              className="no-drag cl-focus shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)] underline underline-offset-2 hover:text-[color:var(--cl-foreground)]"
            >
              Reset SSO
            </button>
          </div>
          {err && <span className="text-[11px] text-[color:var(--cl-destructive)]">{err}</span>}
        </>
      ) : showSetup ? (
        setupForm
      ) : (
        <>
          <button
            type="button"
            onClick={() => setShowSetup(true)}
            className="no-drag cl-focus flex items-center justify-center gap-2 rounded-[8px] bg-[var(--cl-primary)] px-3 py-2 text-[13px] font-medium text-white hover:opacity-90"
          >
            <ShieldCheck size={14} />
            Set up Microsoft sign-in
          </button>
          <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Enable Microsoft (Entra) sign-in to lock AskToto to your Mantu domain and tie usage to Dust.
            One-time setup — takes a minute.
          </span>
          {err && <span className="text-[11px] text-[color:var(--cl-destructive)]">{err}</span>}
        </>
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

function PermissionsSection(): JSX.Element {
  const { permissions } = usePermissions()
  const isWin = window.navigator.platform.toLowerCase().includes('win')

  if (!permissions) {
    return <div className="text-[13px] text-[color:var(--cl-muted-foreground)]">Checking permissions…</div>
  }

  const rows: { label: string; status: string; note: string }[] = [
    {
      label: 'Microphone',
      status: permissions.microphone,
      note: isWin
        ? 'Windows asks the first time you start Listen.'
        : 'Grant in System Settings → Privacy & Security → Microphone.'
    },
    {
      label: 'Screen / system audio',
      status: permissions.screenRecording,
      note: isWin
        ? 'Windows may ask once before capturing system audio.'
        : 'Grant in System Settings → Privacy & Security → Screen Recording.'
    },
    {
      label: 'Auto-start on meeting',
      status: permissions.accessibility,
      note: isWin
        ? 'No extra permission needed on Windows.'
        : 'Grant Accessibility in System Settings → Privacy & Security.'
    }
  ]

  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
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
          </div>
        </div>
      ))}
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
  'scroll-up': 'Move up',
  'scroll-down': 'Move down',
  settings: 'Open settings'
}

function displayAccelerator(a: string): string {
  return a
    .replace(/CommandOrControl/g, '⌘')
    .replace(/Command/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Shift/g, '⇧')
    .replace(/Alt/g, '⌥')
    .replace(/Return/g, '↵')
    .replace(/\\/g, '\\')
}

function Shortcuts({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const user = settings.shortcuts ?? {}
  const set = (action: HotkeyAction, value: string): void => {
    const next = value.trim()
    patch({
      shortcuts: { ...user, [action]: next }
    })
  }
  const reset = (action: HotkeyAction): void => {
    const next = { ...user }
    next[action] = DEFAULT_SHORTCUTS[action] ?? ''
    patch({ shortcuts: next })
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        {HOTKEY_ACTIONS.map((action) => {
          const current = user[action] ?? DEFAULT_SHORTCUTS[action] ?? ''
          const isDefault = current === (DEFAULT_SHORTCUTS[action] ?? '')
          return (
            <div key={action} className="flex items-center justify-between gap-3 px-1 py-1.5 text-[13px]">
              <span className="min-w-[140px] text-[color:var(--cl-muted-foreground)]">
                {SHORTCUT_LABELS[action]}
              </span>
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="text"
                  value={current}
                  placeholder={isDefault ? displayAccelerator(current) : 'Disabled'}
                  onChange={(e) => set(action, e.target.value)}
                  className={[
                    'no-drag cl-input font-ui min-w-0 flex-1 px-2 py-1 text-[12px]',
                    !isDefault ? 'text-[color:var(--cl-primary)]' : ''
                  ].join(' ')}
                  spellCheck={false}
                />
                <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                  {displayAccelerator(current)}
                </span>
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
      <div className="text-[11px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
        Format examples: <code className="text-[color:var(--cl-foreground)]">CommandOrControl+Shift+L</code>,{' '}
        <code className="text-[color:var(--cl-foreground)]">Alt+F</code>. Invalid accelerators are ignored.
        Changes are applied immediately in the running app.
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
        placeholder="Anything else AskToto should know…"
        value={profile.notes}
        onCommit={(v) => set('notes', v)}
      />
      <div className="flex items-center gap-1.5 px-1 text-[11px] text-[color:var(--cl-muted-foreground)]">
        <Sparkles size={11} className="text-[color:var(--cl-primary)]" />
        Tip: paste your résumé + the job post for spot-on interview answers.
      </div>
    </div>
  )
}
