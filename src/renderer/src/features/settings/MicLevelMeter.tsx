import { useEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { FieldHint } from '../../components/ui'
import { acquireInteractiveMic, type InputMicAdmission } from '../../lib/input-mic-admission'
import { isWindows } from '../../lib/keys'
import { micMeterMode } from '../../lib/permission-ask'
import { usePermissions } from '../../state'

// Full-scale RMS for the level meter below. Well above the VAD's own "is speaking" threshold
// (lib/vad.ts ON = 0.012) so normal close-mic speech visibly moves the bar without pegging it on
// every breath; this is a "do I have signal" indicator, not a calibrated VU meter.
const MIC_METER_FULL_SCALE = 0.2
// Same link style as the Settings permission rows (PermissionsSection), so the new controls add no new look.
const LINK_BUTTON =
  'no-drag cl-focus shrink-0 text-[11px] font-medium text-[color:var(--cl-primary)] hover:underline disabled:opacity-60'

/** Live input-level meter for MicPicker: opens its own getUserMedia + AnalyserNode against whichever
 *  device is selected (or the system default) so a user can confirm a mic — especially a newly paired
 *  Bluetooth/iPhone mic — is actually delivering signal before a meeting, without starting a real
 *  capture. Entirely separate from the app's real capture pipeline (lib/listen.ts); it never touches
 *  settings or recording state, only visualizes.
 *
 *  C26 (Apple HIG, moment of need): it opens the microphone on mount ONLY when access is already granted.
 *  A not-determined microphone shows "Test Microphone", which asks, then meters; a denied one shows the
 *  System Settings deep link and never asks. The status re-reads when Métis becomes active again
 *  (usePermissions), so a grant made in System Settings starts the meter without a click.
 *
 *  RMS math mirrors lib/vad.ts / whisper-worklet-src.ts (sum of squares over the buffer, then sqrt) so
 *  the bar reflects the same "how loud is this" signal the transcription pipeline itself computes.
 *
 *  Cleanup is the load-bearing part: a leaked getUserMedia stream keeps the mic hot and the OS
 *  recording indicator lit. teardown() stops every track, closes the AudioContext, and cancels the
 *  rAF loop; the effect calls it on every unmount AND every deviceId change (effect cleanup runs
 *  before the next effect body), so switching devices or leaving the Audio tab (this component
 *  unmounts with it — see the `tab === 'audio'` guard around MicPicker) always fully releases the mic. */
export function MicLevelMeter({
  deviceId,
  permissionNonce,
  onPermissionGranted
}: {
  deviceId: string
  /** Bumped by MicPicker's unlockLabels() after a fresh mic-permission grant. deviceId alone doesn't
   *  change when permission is granted in the same panel, so the meter would otherwise stay stuck on
   *  "No signal" until some unrelated device switch re-ran this effect. */
  permissionNonce?: number
  /** Called once Test Microphone has obtained access, so the picker can show real device names. */
  onPermissionGranted?: () => void
}): JSX.Element {
  const { permissions, refresh } = usePermissions()
  const [tested, setTested] = useState(false)
  const [testing, setTesting] = useState(false)
  const mode = micMeterMode(permissions?.microphone, { tested, windows: isWindows })
  const metering = mode === 'meter'
  // null = not blocked. Otherwise the getUserMedia failure kind, so the hint below can name the actual
  // cause instead of always saying "allow microphone access" (wrong for a disconnected/OverconstrainedError device).
  const [blockedReason, setBlockedReason] = useState<'permission' | 'device' | 'other' | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // Only the grant edge matters; a new callback identity must not report the same grant twice.
  const onGrantedRef = useRef(onPermissionGranted)
  onGrantedRef.current = onPermissionGranted
  useEffect(() => {
    if (tested && permissions?.microphone === 'granted') onGrantedRef.current?.()
  }, [tested, permissions?.microphone])

  useEffect(() => {
    if (!metering) return
    let cancelled = false
    const admissionAbort = new AbortController()
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let admission: InputMicAdmission | null = null
    let raf = 0

    const teardown = (): void => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      admissionAbort.abort()
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      if (ctx && ctx.state !== 'closed') void ctx.close()
      ctx = null
      void admission?.release()
      admission = null
    }

    void (async (): Promise<void> => {
      try {
        const capture = await acquireInteractiveMic(
          {
            audio: deviceId ? { deviceId: { exact: deviceId } } : true
          },
          'conversation',
          'application-probe',
          admissionAbort.signal
        )
        stream = capture.stream
        admission = capture.admission
        admission.onRevoke(teardown)
        if (cancelled || admission.revoked) {
          teardown()
          return
        }
        const s = capture.stream
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
  }, [deviceId, permissionNonce, metering])

  // Moment of need: the macOS prompt follows this click, then the re-read status opens the meter.
  const test = async (): Promise<void> => {
    setTesting(true)
    await window.toto.requestPermissionsUpfront('microphone').catch(() => null)
    setTested(true)
    await refresh().catch(() => {})
    setTesting(false)
  }

  if (mode === 'test') {
    return (
      <button type="button" onClick={() => void test()} disabled={testing} className={LINK_BUTTON}>
        Test Microphone
      </button>
    )
  }

  if (mode === 'denied') {
    const hint = isWindows
      ? 'Windows is blocking the microphone. Turn it back on in Privacy settings to test this device.'
      : "Microphone access is off for Métis, and macOS won't ask again. Turn it on in System Settings to test this device."
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <FieldHint text={hint}>
          <span className="flex h-2 items-center text-[color:var(--cl-muted-foreground)]">
            <AlertCircle size={12} />
          </span>
        </FieldHint>
        <button
          type="button"
          onClick={() => void window.toto.openPermissionSettings('microphone')}
          className={LINK_BUTTON}
        >
          {isWindows ? 'Open Windows Settings' : 'Open System Settings'}
        </button>
      </span>
    )
  }

  if (metering && blockedReason) {
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
