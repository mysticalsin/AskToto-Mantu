import { useEffect, useState, type ReactNode } from 'react'
import { AlertCircle, Lock, Volume2 } from 'lucide-react'
import type { PublicSettings } from '@shared/ipc'
import type { SpokenRepliesState, TtsVoice } from '@shared/spoken-replies'
import {
  clampSpeechRate,
  DEFAULT_SPOKEN_REPLIES_SETTINGS,
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  type SpokenRepliesSettings
} from '@shared/spoken-replies-settings'
import { Section } from '../../ui/Section'
import { ToggleRow } from '../../ui/Toggle'
import { managedChipCls } from '../../ui/ManagedChip'
import { ctl } from '../../ui/ctl'

const HINT = 'text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]'
const ROW_BUTTON =
  'no-drag cl-focus rounded-full bg-[var(--cl-primary)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--cl-primary)] hover:bg-[var(--cl-primary)]/25 disabled:opacity-60'

/** What the person is told, in one place so Opus reviews the words together. */
export const SPOKEN_REPLIES_COPY = {
  title: 'Spoken replies',
  desc: 'Métis can read its answers aloud with a voice installed on this computer. The text always stays on screen, and nothing is copied or sent anywhere.',
  toggleLabel: 'Read answers aloud',
  toggleDesc: 'Asking a new question, holding the voice shortcut or pressing Stop silences it at once.',
  preview: 'Automatic replies are off. The fixed preview remains available while spoken replies are being tested.',
  managed: "Your organization sets this. You can't change it here.",
  unavailable: "Spoken replies aren't available on this computer. Answers stay on screen.",
  meeting: 'Spoken replies are paused while Métis records a meeting. Answers stay on screen.',
  voiceLabel: 'Voice',
  systemVoice: 'Automatic · approved installed voice',
  speedLabel: 'Speed',
  previewButton: 'Preview voice',
  stopPreviewButton: 'Stop preview',
  previewFailed: "Couldn't play the preview. Try again."
} as const

/** `1.25` is shown as `1.25x` and `1` as `1x`: no trailing zeros, always the multiplier. */
export function formatSpeechRate(rate: number): string {
  return `${Number(clampSpeechRate(rate).toFixed(2))}x`
}

function useSpokenRepliesState(): SpokenRepliesState | null {
  const [state, setState] = useState<SpokenRepliesState | null>(null)
  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void (async () => {
      try {
        const bridge = window.toto.spokenReplies
        unsubscribe = bridge.onState((next) => {
          if (!cancelled) setState(next)
        })
        const current = await bridge.getState()
        if (!cancelled && current)
          setState((previous) => (previous && previous.revision > current.revision ? previous : current))
      } catch {
        /* no bridge (a test host): the section still renders from settings */
      }
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])
  return state
}

/** The approved voices, loaded once the section is in use. An unreachable engine is simply an empty list. */
function useApprovedVoices(enabled: boolean): TtsVoice[] {
  const [voices, setVoices] = useState<TtsVoice[]>([])
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const list = await window.toto.spokenReplies.voices()
        if (!cancelled) setVoices(list)
      } catch {
        /* no bridge: only automatic selection is available */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])
  return voices
}

function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className={`flex items-start gap-1.5 px-1 py-1 ${HINT}`}>
      <span className="mt-px shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/**
 * Settings › Speech › Spoken replies (G27). Every control applies at once (no Save, HIG S6). The text of an answer is
 * on screen whether or not it is read aloud, so muted and unavailable only say why nothing is heard. The preview plays
 * a fixed sentence with the voice and speed on screen, before they are saved, and the same button stops it.
 */
export function SpokenRepliesSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => Promise<unknown> | void
}): JSX.Element {
  const spoken: SpokenRepliesSettings = settings.spokenReplies ?? DEFAULT_SPOKEN_REPLIES_SETTINGS
  const state = useSpokenRepliesState()
  const managed = settings.managedKeys?.includes('spokenReplies') === true
  const unavailable = state !== null && !state.available
  const on = spoken.speakReplies
  const voices = useApprovedVoices(!unavailable)
  const [previewFailed, setPreviewFailed] = useState(false)
  const previewing = state?.playback === 'preview'
  // A missing or unapproved saved voice uses the first approved installed voice, represented by Automatic.
  const selectedVoice = voices.some((voice) => voice.id === spoken.voiceId) ? (spoken.voiceId ?? '') : ''
  const subDisabled = managed || unavailable

  const change = (next: Partial<SpokenRepliesSettings>): void => void patch({ spokenReplies: { ...spoken, ...next } })
  const togglePreview = async (): Promise<void> => {
    try {
      setPreviewFailed(false)
      if (previewing) {
        await window.toto.spokenReplies.stop()
        return
      }
      const result = await window.toto.spokenReplies.preview({
        voiceId: selectedVoice === '' ? null : selectedVoice,
        rate: spoken.rate
      })
      if (!result.ok) setPreviewFailed(true)
    } catch {
      setPreviewFailed(true)
    }
  }

  return (
    <Section title={SPOKEN_REPLIES_COPY.title} desc={SPOKEN_REPLIES_COPY.desc} icon={Volume2}>
      <ToggleRow
        label={SPOKEN_REPLIES_COPY.toggleLabel}
        desc={SPOKEN_REPLIES_COPY.toggleDesc}
        on={on}
        onChange={(value) => change({ speakReplies: value })}
        disabled={managed}
        managedChip={managed}
      >
        {!on && !managed && (
          <div className={`mt-1 flex flex-wrap items-center gap-2 ${HINT}`}>
            <span className={managedChipCls}>Preview</span>
            <span>{SPOKEN_REPLIES_COPY.preview}</span>
          </div>
        )}
      </ToggleRow>
      {managed && <Notice icon={<Lock size={12} aria-hidden />}>{SPOKEN_REPLIES_COPY.managed}</Notice>}
      {unavailable && <Notice icon={<AlertCircle size={12} aria-hidden />}>{SPOKEN_REPLIES_COPY.unavailable}</Notice>}
      {on && !unavailable && state?.muted === 'meeting' && (
        <Notice icon={<AlertCircle size={12} aria-hidden />}>{SPOKEN_REPLIES_COPY.meeting}</Notice>
      )}

      <div
        className={[
          'mt-1 flex flex-col gap-2 border-t border-[var(--cl-border)] pt-2 pl-3 transition-opacity',
          subDisabled ? 'opacity-60' : ''
        ].join(' ')}
        data-spoken-sub-rows={subDisabled ? 'disabled' : 'enabled'}
      >
        <label className="flex min-w-0 items-center gap-2">
          <span className="w-12 shrink-0 text-[12px] text-[color:var(--cl-muted-foreground)]">
            {SPOKEN_REPLIES_COPY.voiceLabel}
          </span>
          <select
            value={selectedVoice}
            disabled={subDisabled}
            onChange={(event) => change({ voiceId: event.target.value === '' ? null : event.target.value })}
            aria-label={SPOKEN_REPLIES_COPY.voiceLabel}
            className={'min-w-0 flex-1 ' + ctl}
          >
            <option value="">{SPOKEN_REPLIES_COPY.systemVoice}</option>
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} · {voice.language}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-2">
          <span className="w-12 shrink-0 text-[12px] text-[color:var(--cl-muted-foreground)]">
            {SPOKEN_REPLIES_COPY.speedLabel}
          </span>
          <input
            type="range"
            aria-label={SPOKEN_REPLIES_COPY.speedLabel}
            aria-valuetext={formatSpeechRate(spoken.rate)}
            min={SPEECH_RATE_MIN}
            max={SPEECH_RATE_MAX}
            step={0.05}
            value={clampSpeechRate(spoken.rate)}
            disabled={subDisabled}
            onChange={(event) => change({ rate: clampSpeechRate(Number(event.target.value)) })}
            className="no-drag cl-focus min-w-0 flex-1 accent-[var(--cl-primary)] disabled:cursor-not-allowed"
          />
          <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-[color:var(--cl-muted-foreground)]">
            {formatSpeechRate(spoken.rate)}
          </span>
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void togglePreview()}
            disabled={(managed || unavailable) && !previewing}
            className={ROW_BUTTON}
          >
            {previewing ? SPOKEN_REPLIES_COPY.stopPreviewButton : SPOKEN_REPLIES_COPY.previewButton}
          </button>
          {previewFailed && <span className={HINT}>{SPOKEN_REPLIES_COPY.previewFailed}</span>}
        </div>
      </div>
    </Section>
  )
}
