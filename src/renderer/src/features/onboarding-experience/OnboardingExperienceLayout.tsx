// @ts-nocheck
import { Suspense } from 'react'
import { Check, Volume2, VolumeX } from 'lucide-react'
import { InlineOrb } from '../../components/AgentStatus'
import { ScreenSetupActions } from '../../components/OnboardingScreenSetup'
import { OnboardingDemoScene } from '../../components/OnboardingDemoScene'
import { OnboardingAppearance } from '../../components/OnboardingAppearance'
import { KineticGrid } from '../../components/onboarding/KineticGrid'
import { isWindows } from '../../lib/keys'
import { ONBOARDING_PERSONAS } from '../../lib/persona-vibe'
import { sceneAfterAppearance, sceneAfterLicense, sceneAfterPersonalize, sceneAfterReveal, sceneAfterSetup } from '../../lib/onboarding-flow'
import { ActLicense, ActProgress, ActReady, HeroWelcome, OnboardingHeroVideo, PROBLEM_STORY, PERSONA_ICONS, TellTheRoomCard } from './onboarding-scenes'
import { MiniToggle, asrRowNeedsRepair, asrRowNeedsRetry, setupContinueLabel, setupRowLoadingPercent } from './onboarding-setup'
import { shouldMountKineticGrid } from '../../lib/onboarding-kinetic-grid'
import { playOnboardingVideo } from '../../lib/onboarding-hero-video'
import { requestOnboardingPortalOpen } from '../../lib/onboarding-portal'

export function OnboardingExperienceLayout(props: any): JSX.Element {
  const {
    scene,
    heroVideoRef,
    music,
    mode,
    setMode,
    setScene,
    rows,
    asrRow,
    asrReady,
    scanDone,
    allReady,
    needsPerms,
    asrBlocksContinue,
    consent,
    setConsent,
    settings,
    patch,
    screenSetup,
    restarting,
    retryAsr,
    requestMic,
    restartApp,
    playHero,
    appearance,
    appearanceLocked,
    placement,
    placementLocked,
    appearanceSave,
    pickAppearance,
    pickPlacement,
    finish,
    onOpenAiSettings,
    recoverEncryptedProfile,
    authReady
  } = props
  return (
    <>
      {/* FITO-185-P: keep lady bed through problem/reveal — unmounting on Next killed atmosphere. */}
      {(scene === 'hero' || scene === 'problem' || scene === 'reveal') && (
        <OnboardingHeroVideo videoRef={heroVideoRef} />
      )}
      <div
      className="onboard-root relative z-10 flex h-full w-full select-none flex-col items-center overflow-hidden px-10 text-center"
      onPointerDown={music.start}
    >
      {shouldMountKineticGrid(scene) && <KineticGrid />}
      <button
        type="button"
        className="onboard-mute no-drag focus-ring"
        aria-label={music.muted ? 'Unmute music' : 'Mute music'}
        aria-pressed={music.muted}
        onClick={music.toggleMute}
      >
        {music.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
      <div className="onboard-tour-chrome flex h-9 shrink-0 items-center justify-center pt-3">
        <ActProgress scene={scene} />
      </div>
      <div className="onboard-tour-slot flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-6">
      {scene === 'hero' && (
        <HeroWelcome
          onBegin={() => {
            // P0: paint problem FIRST — never wait on music/video/portal (Example: after Next → black/Loading).
            setScene('problem')
            try {
              music.start()
            } catch {
              /* ignore */
            }
            try {
              playOnboardingVideo(heroVideoRef.current)
            } catch {
              /* ignore */
            }
            try {
              requestOnboardingPortalOpen()
            } catch {
              /* ignore */
            }
          }}
        />
      )}

      {scene === 'problem' && (
        <div key="problem" className="onboard-post-lady flex flex-col items-center gap-8">
          <div className="scene-enter flex max-w-[420px] flex-col gap-3 text-left">
            {PROBLEM_STORY.map((line) => (
              <p
                key={line}
                className="m-0 text-[22px] font-medium leading-snug text-[color:var(--color-ink)]"
                style={{ opacity: 1 }}
              >
                {line}
              </p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              playHero()
              setScene('reveal')
            }}
            className="onboard-cta no-drag focus-ring"
          >
            Continue
          </button>
        </div>
      )}

      {scene === 'reveal' && (
        <Suspense
          fallback={
            <div className="flex flex-col items-center gap-6">
              <p className="m-0 text-[22px] font-semibold text-[color:var(--color-ink)]">See Métis in action</p>
              <button type="button" className="onboard-cta no-drag focus-ring" onClick={() => setScene(sceneAfterReveal())}>
                Continue
              </button>
            </div>
          }
        >
          <OnboardingDemoScene
            mode={mode}
            onSetMode={setMode}
            onContinue={() => {
              playHero()
              setScene(sceneAfterReveal())
            }}
            onPlayVideo={() => playHero()}
          />
        </Suspense>
      )}

      {scene === 'setup' && (
        <div key="setup" className="scene-enter flex flex-col items-center gap-6">
          <h2 className="m-0 text-[22px] font-semibold text-[color:var(--color-ink)]">Your setup</h2>
          <div className="flex w-full max-w-[440px] flex-col gap-2">
            {rows.map((r, i) => (
              <div
                key={r.key}
                className="glass-strong fade-up flex items-start gap-3 rounded-[12px] px-3.5 py-2.5 text-left"
                style={{ animationDelay: `${i * 70}ms`, animationFillMode: 'backwards' }}
              >
                <r.icon size={16} className="mt-0.5 shrink-0 text-[color:var(--color-ink-2)]" />
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[13px] text-[color:var(--color-ink)]">{r.label}</p>
                  {r.detail && <p className="m-0 text-[11px] text-[color:var(--color-ink-3)]">{r.detail}</p>}
                  {(r.key === 'local' || r.key === 'asr') && r.progress != null && (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-[var(--color-accent)]"
                        style={{ width: `${Math.round(r.progress * 100)}%` }}
                      />
                    </div>
                  )}
                  {r.key === 'local' && r.state === 'action' && r.progress == null && (
                    <div className="mt-1.5">
                      <button
                        type="button"
                        onClick={() => void window.toto.localModelsEnsure().catch(() => {})}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {/* Why-before-prompt: shown before the button that triggers the OS dialog / deep link, not
                      after — so the user knows what they're being asked for before they're asked. */}
                  {r.key === 'asr' && asrRowNeedsRetry(r) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                        Transcription files download when you first set up Métis. Check your connection.
                      </span>
                      <button
                        type="button"
                        onClick={() => void retryAsr()}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25"
                      >
                        Try again
                      </button>
                    </div>
                  )}
                  {r.key === 'asr' && asrRowNeedsRepair(r) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                        Reinstall Métis with the official installer, then reopen it.
                      </span>
                      <button
                        type="button"
                        onClick={() => void window.toto.quit()}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25"
                      >
                        Quit Métis
                      </button>
                    </div>
                  )}
                  {r.key === 'mic' && r.state === 'action' && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                        Lets Métis hear your side of the call.
                      </span>
                      <button
                        type="button"
                        onClick={() => void requestMic()}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25"
                      >
                        Allow Microphone
                      </button>
                    </div>
                  )}
                  {r.key === 'mic' && r.state === 'blocked' && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                        {isWindows
                          ? "Windows is blocking the microphone. Turn it back on in Privacy settings."
                          : "macOS won't ask again once you've said no. Turn it back on in Privacy settings."}
                      </span>
                      <button
                        type="button"
                        onClick={() => void window.toto.openPermissionSettings('microphone')}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25"
                      >
                        Open Microphone Settings
                      </button>
                    </div>
                  )}
                  {r.key === 'screen' && (r.state === 'action' || r.state === 'blocked') && (
                    <ScreenSetupActions
                      perms={screenSetup.perms}
                      check={screenSetup.check}
                      onRequest={() => void screenSetup.request()}
                      onRecheck={screenSetup.recheck}
                    />
                  )}
                  {r.key === 'screen' && r.state === 'restart' && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] leading-snug text-[color:var(--color-accent-2)]">
                        Granted. Restart Métis to finish enabling it.
                      </span>
                      <button
                        type="button"
                        onClick={restartApp}
                        disabled={restarting}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-semibold text-white hover:brightness-110 disabled:opacity-60"
                      >
                        {restarting ? 'Restarting…' : 'Restart Métis'}
                      </button>
                    </div>
                  )}
                  {/* Opt-out toggle framed as competence (Act 3 brief): screenAsk is a REAL, on-by-default
                      setting (ipc.ts) — never invented for this scene — so it's shown as "already on,
                      your call" rather than a setup step. Independent of the permission grant above: the
                      toggle flips the app's intent to ask, whether or not the OS has said yes yet. */}
                  {r.key === 'screen' && settings && patch && (
                    <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-white/10 pt-1.5">
                      <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                        Let Métis see your screen when you ask (on by default, your call).
                      </span>
                      <MiniToggle
                        on={settings.screenAsk}
                        onChange={(v) => patch({ screenAsk: v })}
                        label="Let Métis see your screen when you ask"
                      />
                    </div>
                  )}
                  {r.key === 'ai' && r.state === 'action' && (
                    <p className="mt-1 text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                      Transcription works without an AI connection. Activate your Métis licence in Settings → Identity for automatic summaries and answers, or connect your own provider in Settings → AI.
                    </p>
                  )}
                  {r.key === 'ai' && r.state === 'ready' && (
                    <p className="mt-1 text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                      Add your own provider key anytime in Settings (optional, never required).
                    </p>
                  )}
                </div>
                {(r.state === 'checking' || r.state === 'loading') && (
                  <span className="mt-0.5 shrink-0">
                    <InlineOrb kind="loading" percent={setupRowLoadingPercent(r.progress)} />
                  </span>
                )}
                {r.state === 'ready' && <Check size={16} className="mt-0.5 shrink-0 text-[var(--color-accent-2)]" />}
                {r.state === 'action' && <span className="mt-0.5 shrink-0 text-[11px] font-medium text-[color:var(--color-ink-2)]">needed</span>}
                {r.state === 'blocked' && <span className="mt-0.5 shrink-0 text-[11px] font-medium text-[color:var(--color-ink-2)]">blocked</span>}
                {r.state === 'restart' && (
                  <span className="mt-0.5 shrink-0 text-[11px] font-medium text-[color:var(--color-accent-2)]">restart</span>
                )}
              </div>
            ))}
          </div>
          {allReady && (
            <p className="fade-up m-0 text-[14px] font-medium text-[color:var(--color-ink)]">
              Everything’s ready. Nothing to configure.
            </p>
          )}
          {/* Métis's equivalent of Vibe Island's "restart your sessions" honest caveat (teardown, Config
              act) — but placed HERE, first, rather than saved for the final act, and reinforced again at
              Ready. True the moment scanning settles, regardless of allReady: nothing above changes when
              Métis is actually allowed to listen. */}
          {scanDone && (
            <p className="fade-up m-0 max-w-[360px] text-[11px] leading-snug text-[color:var(--color-ink-3)]">
              Métis only starts listening when you press Listen and tell the room. Nothing is captured before that.
            </p>
          )}
          {asrBlocksContinue && scanDone && (
            <p className="fade-up m-0 max-w-[360px] text-[11px] leading-snug text-[color:var(--color-ink-3)]">
              Transcription files are still finishing in the background. You can Continue now and finish them in Settings.
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              // Act 6 re-point (MQA-283): setup always advances to personalize now — license (when
              // enabled) has moved to sit between personalize and ready. See onboarding-flow.ts.
              onClick={() => {
                // P0 nuclear: never block Continue on ASR/access — rows stay informational.
                playHero()
                setScene(sceneAfterSetup())
              }}
              className="onboard-cta no-drag focus-ring"
            >
              {setupContinueLabel(needsPerms)}
            </button>
          </div>
        </div>
      )}

      {scene === 'personalize' && (
        <div key="personalize" className="scene-enter onboard-act4 flex flex-col items-center">
          <div className="onboard-act4-heading flex flex-col items-center gap-2">
            <p className="onboard-act4-kicker">Last one</p>
            <h2 className="onboard-act4-title">How should Métis show up?</h2>
            <p className="onboard-act4-lead">
              One pick shapes how it listens and what it says next. Change it anytime in Settings.
            </p>
          </div>
          <div className="onboard-persona-row">
            {/* The onboarding personality beat (Act 4, Vibe-Island-teardown "the ONE emotional choice
                after the heavy config step") — three refined cards over the plain three-button picker
                this replaced, each naming the mode's real behavior change (`persona-vibe.ts`, honest and
                unit-tested against the actual `DEFAULT_MODE_PROMPTS`) rather than inventing personality
                settings that don't exist. Selection delight is a single one-shot ring (`.persona-select-
                ring` below), keyed by `mode` so it retriggers fresh on every pick — same remount trick as
                `.scene-enter`'s `key={scene}` — and folds into the global prefers-reduced-motion rule for
                free (0ms duration = jumps straight to its end state, i.e. invisible). */}
            {ONBOARDING_PERSONAS.map((p) => {
              const Icon = PERSONA_ICONS[p.id]
              const selected = mode === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setMode(p.id)}
                  className={'onboard-persona no-drag focus-ring' + (selected ? ' is-selected' : '')}
                >
                  {selected && <span key={mode} aria-hidden="true" className="persona-select-ring" />}
                  <div className="flex items-center gap-1.5">
                    <Icon size={13} className="text-[color:var(--color-ink)]" />
                    <p className="onboard-persona-label">{p.label}</p>
                  </div>
                  <p className="onboard-persona-vibe">{p.vibe}</p>
                  <p className="onboard-persona-changes">{p.changes}</p>
                </button>
              )
            })}
          </div>
          <div className="flex flex-col items-center gap-4">
            <TellTheRoomCard consent={consent} onConsent={setConsent} />
            <button
              type="button"
              // Advances to license (only if enabled) or Ready. See onboarding-flow.ts.
              onClick={() => {
                playHero()
                setScene(sceneAfterPersonalize(settings?.licenseGateEnabled))
              }}
              disabled={!consent}
              className={'onboard-cta no-drag focus-ring' + (consent ? '' : ' onboard-cta--muted')}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Act 5 (MQA-281/282), re-pointed after personalize by Act 6 (MQA-283) — skipped ENTIRELY when
          settings.licenseGateEnabled is false (the default): personalize's Continue button above only
          ever routes here when that setting is already true, so a normal user (licensing off) never
          sees this scene render, not even for a frame. */}
      {scene === 'license' && (
        <ActLicense
          settings={settings}
          onContinue={() => {
            playHero()
            setScene(sceneAfterLicense())
          }}
        />
      )}

      {scene === 'appearance' && (
        <div key="appearance" className="onboard-appearance-scroll flex min-h-0 w-full flex-col items-center overflow-y-auto px-1 py-4">
          <OnboardingAppearance
            value={appearance}
            locked={appearanceLocked}
            placement={placement}
            placementLocked={placementLocked}
            saving={appearanceSave.busy}
            error={appearanceSave.error}
            onChange={(id) => void pickAppearance(id)}
            onPlacementChange={(id) => void pickPlacement(id)}
            onContinue={() => {
              playHero()
              setScene(sceneAfterAppearance())
            }}
          />
        </div>
      )}

      {scene === 'ready' && (
        <ActReady
          mode={mode}
          onFinish={finish}
          onOpenAiSettings={onOpenAiSettings}
          asrReady={asrReady}
          aiReady={settings?.providerReady === true}
          asrHint={asrRow.detail}
          asrProgress={asrRow.progress}
          showAsrRetry={asrRowNeedsRetry(asrRow)}
          onRetryAsr={() => void retryAsr()}
          recoverEncryptedProfile={recoverEncryptedProfile}
          authReady={authReady}
        />
      )}

      </div>
    </div>
    </>
  )
}

