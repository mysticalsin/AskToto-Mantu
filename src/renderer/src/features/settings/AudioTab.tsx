import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Headphones, Info, MessageSquare, MessageSquareQuote, Mic, Volume2 } from 'lucide-react'
import type { PublicSettings } from '@shared/ipc'
import { LANGUAGE_OPTIONS } from '@shared/lang-id'
import { isCloudOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { effectiveCloudSttProvider, type CloudSttProviderId } from '@shared/cloud-stt-provider'
import { isWindows } from '../../lib/keys'
import { FieldHint, TextButton } from '../../components/ui'
import { LazyInput } from '../../ui/LazyText'
import { ctl } from '../../ui/ctl'
import { ManagedChip } from '../../ui/ManagedChip'
import { Section } from '../../ui/Section'
import { ToggleRow } from '../../ui/Toggle'
import { AsrModelRow, CoreAsrAssetsRow, WhisperQualityRow } from './AiSection'

// asrWebgpuFallbackAt (WebGPU→WASM ASR downgrade marker) is a sibling addition to the settings schema
// not yet reflected in the shared PublicSettings type this file imports. Read/write it through this
// local extension so today's type still checks and the note below picks up the real field once
// @shared/ipc catches up, with no edit needed here.
type SettingsWithAsrWebgpuFallback = PublicSettings & { asrWebgpuFallbackAt?: number | null }

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




/** Seat Soniox API key for cloud STT (optional; Nova is the default transcript source). */
function SonioxKeySeat({
  hasKey,
  envLocked,
  onSaved
}: {
  hasKey: boolean
  envLocked: boolean
  onSaved: () => void
}): JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    const trimmed = key.trim()
    if (!trimmed) {
      setMsg('Paste a Soniox API key first.')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await window.toto.cloudSttSetSonioxKey(trimmed)
      setKey('')
      setMsg('Soniox key saved on this device.')
      onSaved()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save Soniox key.')
    } finally {
      setBusy(false)
    }
  }
  const clear = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await window.toto.cloudSttClearSonioxKey()
      setMsg('Soniox key removed.')
      onSaved()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not remove Soniox key.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.02] p-2.5">
      <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
        Soniox runs only when selected here and a key is seated (or SONIOX_API_KEY is set). Nova stays
        the default transcript source.
        {envLocked ? ' SONIOX_API_KEY env is active for this seat.' : hasKey ? ' A Soniox key is seated.' : ' No Soniox key seated yet.'}
      </p>
      <input
        type="password"
        value={key}
        disabled={envLocked || busy}
        onChange={(e) => setKey(e.target.value)}
        placeholder={hasKey && !envLocked ? '•••••• saved (paste to replace)' : 'Soniox API key'}
        aria-label="Soniox API key"
        className={'w-full ' + ctl}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={envLocked || busy}
          onClick={() => void save()}
          className="no-drag cl-focus rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Save Soniox key
        </button>
        {hasKey && !envLocked && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void clear()}
            className="no-drag cl-focus rounded-[8px] border border-[var(--cl-input)] px-3 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.06] disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
      {msg && <p className="text-[11px] text-[color:var(--cl-muted-foreground)]">{msg}</p>}
    </div>
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
    <div className="grid min-w-0 grid-cols-3 gap-2">
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
              'no-drag cl-focus flex min-w-0 w-full flex-col items-center gap-1 rounded-[var(--cl-radius)] border px-2 py-3 text-center transition-colors',
              active
                ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]'
                : 'border-[var(--cl-border)] bg-white/[0.02] hover:bg-white/[0.05]',
              locked ? 'opacity-60 cursor-not-allowed' : ''
            ].join(' ')}
          >
            <c.icon size={16} className={active ? 'text-[color:var(--cl-primary)]' : 'text-[color:var(--cl-muted-foreground)]'} />
            <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">{c.label}</span>
            <span className="min-w-0 break-words text-[11px] text-[color:var(--cl-muted-foreground)]">{c.desc}</span>
            <span className="min-w-0 break-words text-[10px] text-[color:var(--cl-muted-foreground)]">{c.perm}</span>
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
    <div className="mt-3 flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[12px] text-[color:var(--cl-muted-foreground)]">Microphone</span>
        <select
          value={settings.micDeviceId}
          disabled={locked}
          onChange={(e) => patch({ micDeviceId: e.target.value })}
          aria-label="Microphone"
          className={'no-drag min-w-0 flex-1 ' + ctl + (locked ? ' opacity-60' : '')}
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

export function AudioTab({
  settings,
  patch,
  refreshSettings,
  tapControl
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => Promise<PublicSettings>
  refreshSettings: () => Promise<void>
  tapControl: ReactNode
}): JSX.Element {
  // Match the worker's fail-closed source selection. A failed/absent probe cannot expose a development
  // preference that has no effect in a production build.
  const [asrBundled, setAsrBundled] = useState(true)
  useEffect(() => {
    void window.toto.asrBundled().then(setAsrBundled).catch(() => setAsrBundled(true))
  }, [])

  // Parakeet native-addon health. addonError is set when the sherpa-onnx addon itself failed to load
  // (e.g. a wrong-platform build) — a different failure from missing bundled assets, so the Audio
  // tab can say "engine broken in this build" instead of letting the toggle silently do nothing.
  const [parakeetAddonError, setParakeetAddonError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.toto.parakeetStatus().then((st) => {
      if (!cancelled) setParakeetAddonError(st.addonError)
    })
    return () => {
      cancelled = true
    }
  }, [settings.asrEngine])

  return (
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
                {tapControl}
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
  )
}
