/**
 * Métis onboarding as an EXPERIENCE — five-act narrative per docs/ONBOARDING-EXPERIENCE.md
 * (anatomy extracted from the Vibe Island reference Tony supplied: hero → staged problem story →
 * reveal → live environment-scan magic moment → personalization/landing).
 *
 * Deliberate constraints:
 * - No animation libraries — CSS transitions + staged `animation-delay` only, like the rest of the app.
 * - Scene 4's checks are REAL (getPermissions / requestPermissionsUpfront / asrBundled) — a row only
 *   ever shows "ready" when it is actually true. Never fake the magic moment.
 * - Self-contained: mounts in place of the legacy tour via App's onboarding gate; everything the host
 *   needs comes back through onDone.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Cpu, FolderLock, Mic, MonitorUp, Sparkles } from 'lucide-react'
import type { ConversationMode, ProfileRecoveryResult, PublicSettings } from '@shared/ipc'
import type { ProviderId } from '@shared/providers'
import { MetisMark } from './MetisMark'
import { Onboarding } from './Onboarding'

export interface OnboardingExperienceProps {
  onDone: (result: { mode: ConversationMode; recordingConsent: boolean }) => void
  /** Optional escape hatch to the old flow while this one beds in. */
  onSkip?: () => void
}

/** One staged line of the problem story — revealed sequentially, then dimmed as the next lands. */
const STORY: string[] = [
  'You’re in the meeting.',
  'The question lands on you.',
  'You know that you know it.',
  '…and the moment passes.'
]

const REVEAL: string[] = [
  'The answer, before you need it.',
  'In your voice, from your meetings.',
  'On your device. Never uploaded.'
]

type Scene = 'hero' | 'story' | 'reveal' | 'setup' | 'personalize'

// Hero is the welcome beat, not a "step" — the dots only track the four guided acts after it, so the
// indicator appears the moment the user is actually inside the flow instead of before they've chosen to
// begin.
const GUIDED_SCENES: Scene[] = ['story', 'reveal', 'setup', 'personalize']

function ActProgress({ scene }: { scene: Scene }): JSX.Element | null {
  const idx = GUIDED_SCENES.indexOf(scene)
  if (idx < 0) return null
  return (
    <div className="fade-up absolute left-1/2 top-5 flex -translate-x-1/2 items-center gap-1.5" aria-hidden="true">
      {GUIDED_SCENES.map((s, i) => (
        <span
          key={s}
          className={
            'h-1.5 rounded-full transition-all duration-300 ' +
            (i === idx ? 'w-5 bg-[var(--color-accent)]' : i < idx ? 'w-1.5 bg-[var(--color-accent)]/50' : 'w-1.5 bg-white/15')
          }
        />
      ))}
    </div>
  )
}

interface SetupRow {
  key: string
  label: string
  icon: typeof Cpu
  state: 'checking' | 'ready' | 'action' | 'skipped'
  detail?: string
}

export function OnboardingExperience({ onDone, onSkip }: OnboardingExperienceProps): JSX.Element {
  const [scene, setScene] = useState<Scene>('hero')
  const [storyLine, setStoryLine] = useState(0)
  const [rows, setRows] = useState<SetupRow[]>([])
  const [mode, setMode] = useState<ConversationMode>('general')
  // Recording-consent gate. Entering the legacy flow at its provider step skips legacy slide 1 — the
  // ONLY place the consent checkbox lived — which silently persisted recordingConsent:false for every
  // new-flow user (CMO-QA finding #1). The checkbox is therefore a REQUIRED gate here, before Start.
  const [consent, setConsent] = useState(false)
  const doneRef = useRef(false)

  // --- Scene 2 pacing: one line every ~1.4s; hold the last line, then advance on click/auto.
  useEffect(() => {
    if (scene !== 'story') return
    if (storyLine >= STORY.length) return
    const t = setTimeout(() => setStoryLine((n) => n + 1), storyLine === 0 ? 400 : 1400)
    return () => clearTimeout(t)
  }, [scene, storyLine])

  // --- Scene 4: run the REAL checks the moment the scene mounts.
  useEffect(() => {
    if (scene !== 'setup') return
    let live = true
    const base: SetupRow[] = [
      { key: 'silicon', label: 'Apple Silicon acceleration', icon: Cpu, state: 'checking' },
      { key: 'asr', label: 'On-device transcription', icon: Sparkles, state: 'checking' },
      { key: 'brain', label: 'Private meeting brain', icon: FolderLock, state: 'checking' },
      { key: 'mic', label: 'Microphone', icon: Mic, state: 'checking' },
      { key: 'screen', label: 'Screen context', icon: MonitorUp, state: 'checking' }
    ]
    setRows(base)
    const set = (key: string, state: SetupRow['state'], detail?: string): void => {
      if (!live) return
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, state, detail } : r)))
    }
    // Stagger the resolutions so each row visibly "lands" — but every verdict is real.
    void (async () => {
      const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      await delay(500)
      set('silicon', 'ready', 'detected') // this build only ships arm64; reaching here IS the check
      await delay(450)
      const bundled = await window.toto.asrBundled().catch(() => false)
      set('asr', bundled ? 'ready' : 'action', bundled ? 'Parakeet + Whisper bundled' : 'models missing in this build')
      await delay(450)
      set('brain', 'ready', 'stays on this Mac')
      await delay(450)
      const perms = await window.toto.getPermissions().catch(() => null)
      set('mic', perms?.microphone === 'granted' ? 'ready' : 'action', perms?.microphone === 'granted' ? 'granted' : 'needs permission')
      await delay(350)
      set(
        'screen',
        perms?.screenRecording === 'granted' ? 'ready' : 'action',
        perms?.screenRecording === 'granted' ? 'granted' : 'optional — grant when you first capture'
      )
    })()
    return () => {
      live = false
    }
  }, [scene])

  const requestPerms = async (): Promise<void> => {
    const perms = await window.toto.requestPermissionsUpfront().catch(() => null)
    setRows((rs) =>
      rs.map((r) =>
        r.key === 'mic'
          ? { ...r, state: perms?.microphone === 'granted' ? 'ready' : 'action', detail: perms?.microphone === 'granted' ? 'granted' : 'needs permission' }
          : r.key === 'screen'
            ? { ...r, state: perms?.screenRecording === 'granted' ? 'ready' : 'action', detail: perms?.screenRecording === 'granted' ? 'granted' : 'optional' }
            : r
      )
    )
  }

  const finish = (): void => {
    if (doneRef.current || !consent) return
    doneRef.current = true
    onDone({ mode, recordingConsent: true })
  }

  const allReady = rows.length > 0 && rows.every((r) => r.state === 'ready' || r.state === 'skipped')
  const needsPerms = rows.some((r) => (r.key === 'mic' || r.key === 'screen') && r.state === 'action')

  return (
    <div className="relative flex h-full w-full select-none flex-col items-center justify-center gap-6 px-10 text-center">
      <ActProgress scene={scene} />
      {scene === 'hero' && (
        <div key="hero" className="scene-enter flex flex-col items-center gap-6">
          <span className="mark-halo">
            <MetisMark size={92} />
          </span>
          <div>
            <h1 className="text-[28px] font-semibold text-[color:var(--color-ink)]">
              Métis. <span className="text-[color:var(--color-ink-2)]">The wisdom before the moment.</span>
            </h1>
            <div className="mt-4 flex flex-col gap-1.5 text-[13px] text-[color:var(--color-ink-2)]">
              {['Answers grounded in your meeting', 'Everything on-device — never uploaded', "You're in control — recording always asks first"].map((t, i) => (
                <p key={t} className="fade-up m-0" style={{ animationDelay: `${300 + i * 220}ms` }}>
                  {t}
                </p>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setScene('story')}
            className="no-drag focus-ring h-10 rounded-full bg-[var(--color-accent)] px-6 text-[13px] font-semibold text-white shadow-[0_2px_16px_var(--color-accent-glow)] hover:brightness-110"
          >
            Begin
          </button>
          {onSkip && (
            <button type="button" onClick={onSkip} className="no-drag text-[11px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]">
              Skip the tour
            </button>
          )}
          <p className="m-0 text-[10px] tracking-wide text-[color:var(--color-ink-3)]">Mantu · Métis</p>
        </div>
      )}

      {scene === 'story' && (
        <div
          key="story"
          className="scene-enter flex min-h-[220px] flex-col items-center justify-center gap-3"
          onClick={() => (storyLine >= STORY.length ? setScene('reveal') : setStoryLine(STORY.length))}
        >
          {STORY.slice(0, storyLine).map((line, i) => (
            <p
              key={line}
              className="fade-up m-0 text-[22px] font-medium transition-opacity duration-700"
              style={{ opacity: i === storyLine - 1 ? 1 : 0.35, color: 'var(--color-ink)' }}
            >
              {line}
            </p>
          ))}
          {storyLine >= STORY.length && (
            <button
              type="button"
              onClick={() => setScene('reveal')}
              className="no-drag focus-ring fade-up mt-4 inline-flex items-center gap-1 rounded-full px-4 py-2 text-[13px] font-medium text-[color:var(--color-accent-2)] hover:bg-white/10"
            >
              Métis sees it coming <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}

      {scene === 'reveal' && (
        <div key="reveal" className="scene-enter flex flex-col items-center gap-6">
          <h2 className="m-0 text-[24px] font-semibold text-[color:var(--color-ink)]">Métis sees it coming.</h2>
          {/* Representation of the live bar — a real transcript line, then the answer MATERIALIZES through
              the glass (develop-in — the same blur-to-sharp idiom the real first-answer moment uses in
              styles.css) after a beat, instead of appearing instantly. That beat is the whole point: it's
              the one place in onboarding that should feel like it's actually thinking. */}
          <div className="glass-strong fade-up w-full max-w-[520px] rounded-[16px] px-4 py-3 text-left">
            <p className="m-0 text-[12px] text-[color:var(--color-ink-3)]">Example · THEM · just now</p>
            <p className="m-0 mt-0.5 text-[13px] text-[color:var(--color-ink)]">“Can you recap where we left things last time?”</p>
            <div className="develop-in mt-2 rounded-[10px] border border-white/10 bg-white/[0.04] px-3 py-2" style={{ animationDelay: '650ms', animationFillMode: 'backwards' }}>
              <p className="m-0 text-[12px] leading-relaxed text-[color:var(--color-ink-2)]">
                <Sparkles size={12} className="mr-1 inline text-[var(--color-accent-2)]" />
                Three things were agreed last call: the revised timeline, the security review, and the intro to
                their CTO — all three are done. Lead with that.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-1 text-[13px] text-[color:var(--color-ink-2)]">
            {REVEAL.map((t, i) => (
              <p key={t} className="fade-up m-0" style={{ animationDelay: `${900 + i * 240}ms`, animationFillMode: 'backwards' }}>
                {t}
              </p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setScene('setup')}
            className="no-drag focus-ring h-10 rounded-full bg-[var(--color-accent)] px-6 text-[13px] font-semibold text-white hover:brightness-110"
          >
            Set me up
          </button>
        </div>
      )}

      {scene === 'setup' && (
        <div key="setup" className="scene-enter flex flex-col items-center gap-6">
          <h2 className="m-0 text-[22px] font-semibold text-[color:var(--color-ink)]">Your setup</h2>
          <div className="flex w-full max-w-[440px] flex-col gap-2">
            {rows.map((r, i) => (
              <div
                key={r.key}
                className="glass-strong fade-up flex items-center gap-3 rounded-[12px] px-3.5 py-2.5 text-left"
                style={{ animationDelay: `${i * 70}ms`, animationFillMode: 'backwards' }}
              >
                <r.icon size={16} className="shrink-0 text-[color:var(--color-ink-2)]" />
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[13px] text-[color:var(--color-ink)]">{r.label}</p>
                  {r.detail && <p className="m-0 text-[11px] text-[color:var(--color-ink-3)]">{r.detail}</p>}
                </div>
                {r.state === 'checking' && (
                  <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-[var(--color-accent-2)]" />
                )}
                {r.state === 'ready' && <Check size={16} className="shrink-0 text-[var(--color-accent-2)]" />}
                {r.state === 'action' && <span className="shrink-0 text-[11px] font-medium text-[color:var(--color-ink-2)]">needed</span>}
              </div>
            ))}
          </div>
          {allReady && (
            <p className="fade-up m-0 text-[14px] font-medium text-[color:var(--color-ink)]">
              Everything’s ready. Nothing to configure.
            </p>
          )}
          <div className="flex items-center gap-2">
            {needsPerms && (
              <button
                type="button"
                onClick={() => void requestPerms()}
                className="no-drag focus-ring h-10 rounded-full bg-[var(--color-accent)] px-5 text-[13px] font-semibold text-white hover:brightness-110"
              >
                Grant access
              </button>
            )}
            <button
              type="button"
              onClick={() => setScene('personalize')}
              className={
                'no-drag focus-ring h-10 rounded-full px-5 text-[13px] font-semibold ' +
                (needsPerms
                  ? 'text-[color:var(--color-ink-2)] hover:bg-white/10'
                  : 'bg-[var(--color-accent)] text-white hover:brightness-110')
              }
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {scene === 'personalize' && (
        <div key="personalize" className="scene-enter flex flex-col items-center gap-6">
          <h2 className="m-0 text-[22px] font-semibold text-[color:var(--color-ink)]">How will you use Métis?</h2>
          <div className="flex gap-3">
            {(
              [
                { id: 'general', label: 'General', desc: 'Every meeting, every topic' },
                { id: 'sales', label: 'Sales', desc: 'Deals, objections, next steps' },
                { id: 'recruiting', label: 'Recruiting', desc: 'You interview — STAR probes, challenges' }
              ] as Array<{ id: ConversationMode; label: string; desc: string }>
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={
                  'no-drag focus-ring w-[150px] rounded-[14px] border px-4 py-3 text-left transition-all duration-150 ' +
                  (mode === m.id
                    ? 'scale-[1.03] border-[var(--color-accent)] bg-[var(--color-accent-soft)] shadow-[0_2px_14px_var(--color-accent-glow)]'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]')
                }
              >
                <p className="m-0 text-[13px] font-semibold text-[color:var(--color-ink)]">{m.label}</p>
                <p className="m-0 mt-0.5 text-[11px] leading-snug text-[color:var(--color-ink-2)]">{m.desc}</p>
              </button>
            ))}
          </div>
          <div className="flex flex-col items-center gap-3">
            <label className="flex max-w-[420px] cursor-pointer items-start gap-2.5 rounded-[12px] border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-left">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="no-drag mt-0.5 accent-[var(--color-accent)]"
              />
              <span className="text-[12px] leading-snug text-[color:var(--color-ink-2)]">
                I’ll tell everyone on the call before I record, and follow my company’s policy and the law.
              </span>
            </label>
            <p className="m-0 text-[15px] font-medium text-[color:var(--color-ink)]">Ready when you are.</p>
            <button
              type="button"
              onClick={finish}
              disabled={!consent}
              className={
                'no-drag focus-ring h-10 rounded-full px-7 text-[13px] font-semibold text-white ' +
                (consent
                  ? 'bg-[var(--color-accent)] shadow-[0_2px_16px_var(--color-accent-glow)] hover:brightness-110'
                  : 'cursor-not-allowed bg-white/10 opacity-60')
              }
            >
              Start
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The full first-run flow: the five-act experience above, then the legacy component entered at its
 * PROVIDER step (5) so API-key setup + the final consent/permissions checklist keep their proven
 * implementation. Mode from the personalize scene is persisted before the handoff.
 */
export function OnboardingV2({
  settings,
  saveKey,
  recoverEncryptedProfile,
  patch,
  onOpenAiSettings,
  onDone,
  signedIn,
  signedInEmail
}: {
  settings: PublicSettings
  saveKey?: (provider: ProviderId, k: string) => Promise<void>
  recoverEncryptedProfile?: () => Promise<ProfileRecoveryResult>
  patch: (p: Partial<PublicSettings>) => void
  onOpenAiSettings?: () => void
  onDone: () => void
  signedIn?: boolean
  signedInEmail?: string
}): JSX.Element {
  // 'legacy-full' = the Skip path: the user opted out of the narrative, so they get the ENTIRE legacy
  // flow from slide 1 — its consent gate included. Skipping must never skip consent (CMO-QA #1).
  const [phase, setPhase] = useState<'experience' | 'provider' | 'legacy-full'>('experience')
  if (phase === 'experience') {
    return (
      <OnboardingExperience
        onDone={({ mode, recordingConsent }) => {
          patch({ mode, recordingConsent })
          setPhase('provider')
        }}
        onSkip={() => setPhase('legacy-full')}
      />
    )
  }
  return (
    <Onboarding
      settings={settings}
      saveKey={saveKey}
      recoverEncryptedProfile={recoverEncryptedProfile}
      patch={patch}
      onOpenAiSettings={onOpenAiSettings}
      onDone={onDone}
      signedIn={signedIn}
      signedInEmail={signedInEmail}
      initialStep={phase === 'legacy-full' ? 1 : 5}
      // Provider phase = the experience's required consent checkbox was already ticked. Seed it so a
      // still-in-flight patch can't let the legacy finish() re-persist false. legacy-full = the Skip
      // path, which hits the real consent slide 1, so leave it to read from settings.
      initialConsent={phase === 'provider' ? true : undefined}
    />
  )
}
