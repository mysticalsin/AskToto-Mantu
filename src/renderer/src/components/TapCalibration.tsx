/**
 * Desk Tap Control — the whole Settings card: enable/arm/sensitivity controls, per-zone action
 * mapping, the guided calibration flow, and a live test mode. Self-contained so Settings.tsx only
 * inserts <TapControlCard/>; every decision (accept/reject copy, separability verdict) comes from
 * lib/tap/calibrate.ts — this file only renders state.
 *
 * Honest zone semantics on purpose: a single processed mono mic cannot tell left from right, so the
 * UI never promises directions — zones are "two spots YOU choose", and the separability gate refuses
 * to save spots the mic can't actually distinguish (nudging toward near/far or different surfaces).
 */
import { useEffect, useRef, useState } from 'react'
import { Fingerprint, Radio } from 'lucide-react'
import type { HotkeyAction, PublicSettings, SettingsPatch } from '@shared/ipc'
import { Section, ToggleRow, ctl } from './Settings'
import { makeCalibration, CALIB_N, type CalibrationSession, type CalibFeedback } from '../lib/tap/calibrate'
import { startTapCapture, startTapControl, type TapCaptureSession, type TapControlSession } from '../lib/tap/tap-control'
import type { BuildResult } from '../lib/tap/classify'

/** Curated action choices per zone — friendly labels over the existing HotkeyAction router. */
const ZONE_ACTIONS: Array<{ value: HotkeyAction; label: string }> = [
  { value: 'toggle-listen', label: 'Start / stop listening' },
  { value: 'whatnext', label: 'What to say next' },
  { value: 'summarize', label: 'Summarize screen' },
  { value: 'factcheck', label: 'Fact-check' },
  { value: 'explain', label: 'Explain' },
  { value: 'capture', label: 'Ask about my screen' },
  { value: 'hide', label: 'Hide / show Métis' }
]

const HINT_COPY: Record<Exclude<CalibFeedback, { accepted: true }>['hint'], string> = {
  'too-weak': 'Tap a bit harder.',
  clipped: 'A bit softer — that one clipped.',
  'double-hit': 'One single clean tap.',
  'rang-on': "That rang on — tap, don't slide.",
  'too-different': 'That one sounded different — same spot as before?',
  'not-a-tap': "Didn't catch that as a tap — try again."
}

type Flow =
  | { step: 'idle' }
  | { step: 'calibrating'; zone: number; accepted: number; hint: string | null }
  | { step: 'negatives'; collected: number }
  | { step: 'verdict'; result: BuildResult }
  | { step: 'testing'; lastZone: number | null }

export function TapControlCard({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: SettingsPatch) => void
}): JSX.Element {
  // Local mirror of tapControl so rapid multi-field edits (toggle → toggle → slider → per-zone selects)
  // accumulate instead of racing: each patch replaces the WHOLE tapControl object, so building every
  // patch from the possibly-stale `settings.tapControl` prop let a later edit clobber an earlier one
  // that hadn't round-tripped yet (audit finding #2). patchTap merges onto the local copy and adopts
  // external changes (e.g. calibration writing a profile) via the effect below.
  const [tc, setTc] = useState(settings.tapControl)
  useEffect(() => setTc(settings.tapControl), [settings.tapControl])
  const patchTap = (delta: Partial<PublicSettings['tapControl']>): void => {
    setTc((prev) => {
      const next = { ...prev, ...delta }
      patch({ tapControl: next })
      return next
    })
  }
  const locked = settings.managedKeys.includes('tapControl')
  const [flow, setFlow] = useState<Flow>({ step: 'idle' })
  const [zoneCount, setZoneCount] = useState(2)
  const sessionRef = useRef<CalibrationSession | null>(null)
  const captureRef = useRef<TapCaptureSession | null>(null)
  const testRef = useRef<TapControlSession | null>(null)

  const stopAll = (): void => {
    captureRef.current?.stop()
    captureRef.current = null
    testRef.current?.stop()
    testRef.current = null
    sessionRef.current = null
  }
  // Never leave the raw mic open after the card unmounts (tab switch, settings close).
  useEffect(() => stopAll, [])

  const syncFromSession = (hint: string | null): void => {
    const s = sessionRef.current
    if (!s) return
    const st = s.state()
    if (st.phase === 'zone') setFlow({ step: 'calibrating', zone: st.zone, accepted: st.accepted, hint })
    else if (st.phase === 'negatives') setFlow({ step: 'negatives', collected: st.collected })
  }

  const beginCalibration = async (): Promise<void> => {
    stopAll()
    try {
      const cap = await startTapCapture({
        micDeviceId: settings.micDeviceId || undefined,
        sensitivity: tc.sensitivity,
        onCandidate(c) {
          const s = sessionRef.current
          if (!s) return
          const st = s.state()
          if (st.phase === 'zone') {
            const fb = s.feedTap(c)
            syncFromSession(fb.accepted ? null : HINT_COPY[fb.hint])
          } else if (st.phase === 'negatives') {
            s.feedNegative(c)
            syncFromSession(null)
          }
        }
      })
      captureRef.current = cap
      sessionRef.current = makeCalibration(zoneCount, cap.sampleRate)
      setFlow({ step: 'calibrating', zone: 0, accepted: 0, hint: null })
    } catch {
      setFlow({ step: 'idle' }) // mic denied — the card simply stays idle
    }
  }

  const finishCalibration = (): void => {
    const s = sessionRef.current
    if (!s) return
    const result = s.finish({ micDeviceId: settings.micDeviceId || 'default', now: Date.now() })
    captureRef.current?.stop()
    captureRef.current = null
    setFlow({ step: 'verdict', result })
  }

  const saveProfile = (result: BuildResult): void => {
    const zones = result.profile.zones
    // Preserve any existing action mapping by index; default new zones to visual-only ('' = no action).
    const zoneActions = zones.map((_, i) => tc.zoneActions[i] ?? '')
    patchTap({ profile: result.profile, zoneActions })
    sessionRef.current = null
    setFlow({ step: 'idle' })
  }

  const beginTest = async (): Promise<void> => {
    if (!tc.profile) return
    stopAll()
    setFlow({ step: 'testing', lastZone: null })
    try {
      testRef.current = await startTapControl({
        profile: tc.profile,
        micDeviceId: settings.micDeviceId || undefined,
        sensitivity: tc.sensitivity,
        onEvent(e) {
          if (e.kind === 'tap') setFlow({ step: 'testing', lastZone: e.zone })
        }
      })
    } catch {
      setFlow({ step: 'idle' })
    }
  }

  const zoneNames = tc.profile?.zones.map((z) => z.name) ?? []

  return (
    <Section
      title="Desk Tap Control"
      desc="Tap the desk near your Mac to trigger an action — recognized on-device from the tap's sound. Pick two spots that sound different to the mic (one close, one at arm's length works best)."
      icon={Fingerprint}
    >
      <ToggleRow
        label="Enable tap control"
        desc={tc.profile ? 'Calibrated and ready.' : 'Needs a one-time calibration for your desk + mic.'}
        on={tc.enabled}
        onChange={(v) => patchTap({ enabled: v })}
        disabled={locked}
        icon={Fingerprint}
      />
      {tc.enabled && (
        <>
          <ToggleRow
            label="Only while listening"
            desc="On: taps work only during a live meeting session. Off: Métis keeps the mic open whenever the app runs, so a tap can also START a session — the macOS mic indicator stays on."
            on={tc.armOnlyWhileListening}
            onChange={(v) => patchTap({ armOnlyWhileListening: v })}
            disabled={locked}
          />
          <label className="flex items-center justify-between gap-3 px-1 py-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
            <span>Sensitivity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={tc.sensitivity}
              disabled={locked}
              onChange={(e) => patchTap({ sensitivity: Number(e.target.value) })}
              className="no-drag accent-[var(--cl-primary)]"
            />
          </label>

          {tc.profile &&
            tc.profile.zones.map((z, i) => (
              <div key={i} className="flex items-center justify-between gap-3 px-1 py-1.5">
                <span className="text-[13px] text-[color:var(--cl-foreground)]">{z.name}</span>
                <select
                  value={tc.zoneActions[i] ?? ''}
                  disabled={locked}
                  aria-label={`${z.name} action`}
                  onChange={(e) => {
                    const zoneActions = [...tc.zoneActions]
                    while (zoneActions.length <= i) zoneActions.push('')
                    zoneActions[i] = e.target.value
                    patchTap({ zoneActions })
                  }}
                  className={'w-56 ' + ctl}
                >
                  <option value="">Show a flash only</option>
                  {ZONE_ACTIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}

          {flow.step === 'idle' && (
            <div className="flex items-center gap-2 px-1 pt-2">
              <select
                value={zoneCount}
                onChange={(e) => setZoneCount(Number(e.target.value))}
                disabled={locked}
                aria-label="Number of zones"
                className={'w-40 ' + ctl}
              >
                <option value={2}>2 zones</option>
                <option value={4}>4 zones (advanced)</option>
              </select>
              <button type="button" onClick={() => void beginCalibration()} disabled={locked} className={ctl + ' no-drag'}>
                {tc.profile ? 'Recalibrate' : 'Calibrate'}
              </button>
              {tc.profile && (
                <button type="button" onClick={() => void beginTest()} disabled={locked} className={ctl + ' no-drag'}>
                  Test
                </button>
              )}
            </div>
          )}

          {flow.step === 'calibrating' && (
            <div className="flex flex-col gap-1 rounded-[10px] border border-white/10 bg-white/[0.03] px-3 py-2.5">
              <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">
                Zone {flow.zone + 1} of {zoneCount} — tap your spot firmly · {flow.accepted}/{CALIB_N}
              </div>
              <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
                {flow.hint ?? 'Same spot each time, one clean tap, brief pause between taps.'}
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-[var(--cl-primary)] transition-[width] duration-200"
                  style={{ width: `${((flow.zone * CALIB_N + flow.accepted) / (zoneCount * CALIB_N)) * 100}%` }}
                />
              </div>
              <button type="button" onClick={() => { stopAll(); setFlow({ step: 'idle' }) }} className={ctl + ' no-drag mt-1 w-24'}>
                Cancel
              </button>
              {flow.zone === zoneCount - 1 && flow.accepted >= CALIB_N && (
                <button
                  type="button"
                  onClick={() => { sessionRef.current?.startNegatives(); syncFromSession(null) }}
                  className={ctl + ' no-drag mt-1'}
                >
                  Continue
                </button>
              )}
            </div>
          )}

          {flow.step === 'negatives' && (
            <div className="flex flex-col gap-1 rounded-[10px] border border-white/10 bg-white/[0.03] px-3 py-2.5">
              <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">
                Teach it what to ignore · {flow.collected} captured
              </div>
              <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
                Type a sentence and click your mouse a few times — Métis learns YOUR keyboard so typing never
                triggers actions.
              </div>
              <button type="button" onClick={finishCalibration} className={ctl + ' no-drag mt-1 w-24'}>
                Done
              </button>
            </div>
          )}

          {flow.step === 'verdict' &&
            (flow.result.separable ? (
              <div className="flex flex-col gap-1 rounded-[10px] border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">
                  Calibration looks good — zones are clearly distinguishable.
                </div>
                <button type="button" onClick={() => saveProfile(flow.result)} className={ctl + ' no-drag mt-1 w-24'}>
                  Save
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1 rounded-[10px] border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <div className="text-[13px] font-medium text-[color:var(--cl-destructive)]">
                  Those spots sound too similar to the mic.
                </div>
                <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
                  Pick spots that differ more — one close to the Mac and one at arm's length, or two different
                  surfaces — then recalibrate.
                </div>
                <button type="button" onClick={() => void beginCalibration()} className={ctl + ' no-drag mt-1 w-32'}>
                  Recalibrate
                </button>
              </div>
            ))}

          {flow.step === 'testing' && (
            <div className="flex flex-col gap-1 rounded-[10px] border border-white/10 bg-white/[0.03] px-3 py-2.5">
              <div className="flex items-center gap-2 text-[13px] font-medium text-[color:var(--cl-foreground)]">
                <Radio size={13} className="text-[var(--cl-primary)]" /> Test mode — tap your zones
              </div>
              <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
                {flow.lastZone != null ? `Recognized: ${zoneNames[flow.lastZone] ?? `Zone ${flow.lastZone + 1}`}` : 'Listening…'}
              </div>
              <button type="button" onClick={() => { stopAll(); setFlow({ step: 'idle' }) }} className={ctl + ' no-drag mt-1 w-24'}>
                Stop
              </button>
            </div>
          )}
        </>
      )}
    </Section>
  )
}
