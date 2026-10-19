import { useCallback, useEffect, useState } from 'react'
import type { CommandMicAvailabilityResult } from '@shared/ipc'
import { useCommandMic } from '../lib/use-command-mic'

export function CommandSpeechPanel({
  engineSelected,
  onClose
}: {
  engineSelected: boolean
  onClose: () => void
}): JSX.Element {
  const mic = useCommandMic()
  const [availability, setAvailability] = useState<CommandMicAvailabilityResult | null>(null)
  const refreshAvailability = useCallback(() => {
    return window.toto
      .commandMicAvailability()
      .then(setAvailability)
      .catch(() => setAvailability({ ok: false, reason: 'unauthorized' }))
  }, [])
  useEffect(() => {
    void refreshAvailability()
  }, [refreshAvailability])
  useEffect(() => {
    if (mic.status === 'error') void refreshAvailability()
  }, [mic.status, refreshAvailability])
  const listening = mic.status === 'listening'
  const busy = mic.status === 'starting' || mic.status === 'finalizing'
  const policyBlocked =
    (availability?.ok === false && availability.reason === 'policy_blocked') || mic.reason === 'policy_blocked'
  const unsupported =
    !engineSelected ||
    (availability?.ok === false && availability.reason === 'unsupported_engine') ||
    mic.reason === 'unsupported_engine'
  const unavailable = policyBlocked || unsupported || !availability?.ok
  const message = policyBlocked
    ? 'Voice commands are unavailable under this managed cloud-only profile. Local speech is blocked by policy; contact your administrator.'
    : unsupported
      ? 'Local voice commands require Parakeet. Select Parakeet in Speech settings.'
      : availability === null
        ? 'Checking voice command policy…'
        : availability.ok === false && availability.reason === 'unauthorized'
          ? 'Sign in to use voice commands.'
          : mic.status === 'starting'
            ? 'Opening the microphone…'
            : listening
              ? 'Listening. Speak one command, then stop.'
              : mic.status === 'finalizing'
                ? 'Checking the command…'
                : mic.status === 'done'
                  ? 'Command sent for review.'
                  : mic.status === 'error'
                    ? mic.reason === 'activation_required'
                      ? 'Use the Start button to begin a voice command.'
                      : mic.reason === 'no_speech'
                        ? 'No speech recognized; try again.'
                        : mic.reason === 'policy_blocked'
                          ? 'Voice commands are unavailable under this managed cloud-only profile. Local speech is blocked by policy; contact your administrator.'
                          : mic.reason === 'microphone_unavailable'
                            ? 'Microphone access is unavailable.'
                            : 'Local recognition could not complete. Try again.'
                    : 'Voice capture starts only when you press Start.'

  return (
    <section
      role="region"
      aria-label="Local voice command"
      className="no-drag fixed right-3 top-3 z-[80] w-[min(320px,calc(100vw-24px))] rounded-2xl border border-white/15 bg-[var(--color-surface)] p-3 text-[var(--color-ink)] shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold">Local voice command</h2>
        <button type="button" className="no-drag focus-ring rounded-lg px-2 py-1 text-[12px]" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-[var(--color-ink-2)]" role="status" aria-live="polite">
        {message}
      </p>
      <div className="mt-3 flex gap-2">
        {!listening ? (
          <button
            id="metis-command-mic-start"
            data-metis-command-mic-start=""
            type="button"
            className="no-drag focus-ring rounded-xl bg-[var(--color-accent)] px-3 py-2 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || unavailable}
            onClick={() => {
              void mic.start()
            }}
          >
            {busy ? 'Please wait…' : 'Start voice command'}
          </button>
        ) : (
          <button
            type="button"
            className="no-drag focus-ring rounded-xl bg-[var(--color-accent)] px-3 py-2 text-[12px] font-medium text-white"
            onClick={() => {
              void mic.finish()
            }}
          >
            Stop and review
          </button>
        )}
        {listening && (
          <button
            type="button"
            className="no-drag focus-ring rounded-xl border border-white/20 px-3 py-2 text-[12px]"
            onClick={() => {
              void mic.cancel()
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </section>
  )
}
