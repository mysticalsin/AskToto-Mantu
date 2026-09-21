import { useEffect, useMemo, useState } from 'react'
import type { OverlayLayout } from '@shared/overlay-chrome'
import type { OverlayPlacement } from '@shared/overlay-placement'
import { MetisMark } from './MetisMark'
import { JarvisOrbButton } from './JarvisOrbButton'
import { ObsidianOrb } from './ObsidianOrb'
import {
  appearancePreviewInitialPhase,
  appearancePreviewShowsBar,
  appearancePreviewShowsCircle,
  appearancePreviewShowsDock,
  appearancePreviewShowsHint,
  appearancePreviewShowsIsland,
  chromeSpec,
  defaultChromeId,
  ONBOARDING_CHROME_HEADING,
  ONBOARDING_CHROME_LEAD,
  ONBOARDING_PLACEMENT_COPY,
  ONBOARDING_PLACEMENT_HEADING,
  ONBOARDING_PLACEMENT_LEAD,
  ONBOARDING_PLACEMENTS,
  onboardingChromeForPlacement,
  placementDemoChromeId,
  placementDemoLayout,
  placementPreviewCaption,
  reduceAppearancePreview,
  type AppearancePreviewPhase,
  type OnboardingChromeId
} from '../lib/onboarding-appearance'

function AppearanceLivePreview({
  layout,
  placement,
  chromeId
}: {
  layout: OverlayLayout
  placement: OverlayPlacement
  chromeId: OnboardingChromeId
}): JSX.Element {
  const [phase, setPhase] = useState<AppearancePreviewPhase>(() => appearancePreviewInitialPhase(layout))

  useEffect(() => {
    setPhase(appearancePreviewInitialPhase(layout))
  }, [layout, chromeId, placement])

  const send = (event: Parameters<typeof reduceAppearancePreview>[2]): void => {
    setPhase((current) => reduceAppearancePreview(layout, current, event))
  }

  const showBar = appearancePreviewShowsBar(phase) && layout === 'bar'
  const showIsland = appearancePreviewShowsIsland(layout, phase)
  const showDock = appearancePreviewShowsDock(layout, phase)
  const showHint = appearancePreviewShowsHint(layout, phase)
  const showCircle = appearancePreviewShowsCircle(chromeId, phase)
  const placementLabel = placement === 'right-edge' ? 'right edge' : 'top'
  const hitLabel =
    layout === 'hide'
      ? `Click the ${placementLabel} to open Hidden`
      : layout === 'dock'
        ? 'Hover the dock to open'
        : layout === 'island'
          ? 'Hover the island to open'
          : 'Bar stays on screen'

  return (
    <div
      className={
        'onboard-appearance-preview' +
        (layout === 'bar' ? ' onboard-appearance-preview--bar' : '') +
        (layout === 'dock' ? ' onboard-appearance-preview--dock' : '') +
        (placement === 'right-edge' ? ' onboard-appearance-preview--right-edge' : '')
      }
      data-appearance-preview={layout}
      data-placement-preview={placement}
      data-chrome-preview={chromeId}
      data-appearance-phase={phase}
    >
      <div className="onboard-appearance-preview__desktop" aria-hidden="true" />
      <button
        type="button"
        className="onboard-appearance-preview__hit no-drag"
        aria-label={hitLabel}
        onClick={() => send('click-top')}
        onPointerEnter={() => send('hover-enter')}
        onPointerLeave={() => send('hover-leave')}
      />
      {showHint ? <span className="onboard-appearance-preview__hint" aria-hidden="true" /> : null}
      {showIsland ? (
        <span className="onboard-appearance-preview__island" data-island-square="true" aria-hidden="true" />
      ) : null}
      {showDock ? (
        <span
          className={
            'onboard-appearance-preview__dock' +
            (phase === 'settled' || phase === 'in' ? ' onboard-appearance-preview__dock--open' : '')
          }
          aria-hidden="true"
        />
      ) : null}
      {showCircle ? (
        /* Optical middle of the mock desktop — never edge-hug (Tony FAIL 4898ddb2). */
        <div
          className={
            'onboard-appearance-preview__circle-stage' +
            (chromeId === 'jarvis'
              ? ' onboard-appearance-preview__circle-stage--jarvis'
              : ' onboard-appearance-preview__circle-stage--typical')
          }
          data-circle-preview={chromeId}
          aria-hidden="true"
        >
          <div
            className={
              'overlay-orb-diagram overlay-orb-diagram--' +
              (chromeId === 'jarvis' ? 'obsidian' : 'jakub')
            }
            data-orb-diagram={chromeId === 'jarvis' ? 'obsidian' : 'jakub'}
            data-orb-diagram-animate="true"
          >
            {chromeId === 'jarvis' ? (
              <ObsidianOrb preview animate onActivate={() => undefined} title="" ariaLabel="" />
            ) : (
              <JarvisOrbButton preview animate onActivate={() => undefined} title="" ariaLabel="" />
            )}
          </div>
        </div>
      ) : showBar ? (
        <div className="onboard-appearance-preview__bar-slot">
          <div
            className={
              'onboard-appearance-preview__bar' +
              (phase === 'settled'
                ? ' overlay-spring overlay-spring--settled'
                : phase === 'in'
                  ? ' overlay-spring overlay-spring--in'
                  : phase === 'out'
                    ? ' overlay-spring overlay-spring--out'
                    : '')
            }
            onAnimationEnd={(e) => {
              if (e.target !== e.currentTarget) return
              if (phase === 'in') send('spring-in-end')
              if (phase === 'out') send('spring-out-end')
            }}
          >
            <MetisMark size={14} />
            <span>Métis</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}


function ChromeCardThumb({ id, selected }: { id: OnboardingChromeId; selected: boolean }): JSX.Element {
  if (id === 'circle' || id === 'jarvis') {
    const orb = id === 'jarvis' ? 'obsidian' : 'jakub'
    return (
      <span className={`onboard-chrome-thumb onboard-chrome-thumb--${id}`} aria-hidden="true">
        <div
          className={`overlay-orb-diagram overlay-orb-diagram--${orb}`}
          data-orb-diagram={orb}
          data-orb-diagram-animate={selected || undefined}
        >
          {id === 'jarvis' ? (
            <ObsidianOrb preview animate={selected} onActivate={() => undefined} title="" ariaLabel="" />
          ) : (
            <JarvisOrbButton preview animate={selected} onActivate={() => undefined} title="" ariaLabel="" />
          )}
        </div>
      </span>
    )
  }
  if (id === 'bar-hides') {
    return (
      <span className="onboard-chrome-thumb onboard-chrome-thumb--bar-hides" aria-hidden="true">
        <span className="onboard-chrome-thumb__bar onboard-chrome-thumb__bar--ghost" />
      </span>
    )
  }
  return (
    <span className="onboard-chrome-thumb onboard-chrome-thumb--bar-stays" aria-hidden="true">
      <span className="onboard-chrome-thumb__bar" />
    </span>
  )
}

export function OnboardingAppearance({
  value,
  locked,
  placement,
  placementLocked,
  chromeId: chromeIdProp,
  compact,
  saving = false,
  error = null,
  onChange,
  onPlacementChange,
  onChromeChange,
  onContinue
}: {
  value: OverlayLayout
  locked: boolean
  placement: OverlayPlacement
  placementLocked: boolean
  chromeId?: OnboardingChromeId
  compact?: boolean
  saving?: boolean
  error?: string | null
  onChange: (id: OverlayLayout) => void
  onPlacementChange: (id: OverlayPlacement) => void
  onChromeChange?: (id: OnboardingChromeId) => void
  onContinue?: () => void
}): JSX.Element {
  const [step, setStep] = useState<'placement' | 'chrome'>('placement')
  const [chromeId, setChromeId] = useState<OnboardingChromeId>(
    () => chromeIdProp ?? defaultChromeId(placement)
  )

  useEffect(() => {
    if (chromeIdProp) setChromeId(chromeIdProp)
  }, [chromeIdProp])

  useEffect(() => {
    // When placement changes, reset chrome to that edge's default unless parent owns it.
    if (!chromeIdProp) setChromeId(defaultChromeId(placement))
  }, [placement, chromeIdProp])

  const cards = useMemo(() => onboardingChromeForPlacement(placement), [placement])
  const active = chromeSpec(placement, chromeId)

  const pickPlacement = (id: OverlayPlacement): void => {
    // Update placement + live preview on the same tick. Stay on placement so Top/Right
    // never flash default Hidden (nearly invisible). Continue advances to chrome.
    onPlacementChange(id)
  }

  const continueFromPlacement = (): void => {
    setStep('chrome')
  }

  const previewLayout = step === 'placement' ? placementDemoLayout(placement) : active.layout
  const previewChromeId = step === 'placement' ? placementDemoChromeId(placement) : chromeId
  const previewCaption = step === 'placement' ? placementPreviewCaption(placement) : null

  const pickChrome = (id: OnboardingChromeId): void => {
    setChromeId(id)
    const spec = chromeSpec(placement, id)
    onChange(spec.layout)
    onChromeChange?.(id)
  }

  return (
    <div
      className={
        'onboard-appearance flex w-full flex-col items-center gap-5' + (compact ? ' onboard-appearance--compact' : '')
      }
      data-onboard-appearance-step={step}
    >
      <AppearanceLivePreview
        key={`${placement}:${previewLayout}:${previewChromeId}:${step}`}
        layout={previewLayout}
        placement={placement}
        chromeId={previewChromeId}
      />
      {previewCaption ? (
        <p className="onboard-appearance-preview-caption m-0 text-center text-[12px] text-white/75" data-placement-caption={placement}>
          {previewCaption}
        </p>
      ) : null}
      {step === 'placement' ? (
        <>
          <div className="onboard-act4-heading flex flex-col items-center gap-2">
            <h2 className="onboard-act4-title">{ONBOARDING_PLACEMENT_HEADING}</h2>
            <p className="onboard-act4-lead">{ONBOARDING_PLACEMENT_LEAD}</p>
          </div>
          <div role="radiogroup" aria-label="Overlay placement" className="overlay-chrome-grid overlay-chrome-grid--two">
            {ONBOARDING_PLACEMENTS.map((id) => {
              const on = placement === id
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={placementLocked || saving}
                  onClick={() => pickPlacement(id)}
                  className={
                    'overlay-chrome-card no-drag focus-ring ' +
                    (on ? 'overlay-chrome-card--selected' : '') +
                    (placementLocked || saving ? ' opacity-60' : '')
                  }
                >
                  {/* The placement step was title + sentence and nothing else, so choosing between
                      "Top" and "Right" meant choosing between two words. These are the same diagrams
                      the Settings placement picker already uses: a desktop with the surface drawn
                      where it will actually sit. */}
                  <span
                    className={`overlay-placement-diagram overlay-placement-diagram--${id}`}
                    data-placement-diagram={id}
                    aria-hidden="true"
                  >
                    <span className="overlay-placement-diagram__desktop" />
                    <span className="overlay-placement-diagram__mark" />
                  </span>
                  <span className="overlay-chrome-card__title">{ONBOARDING_PLACEMENT_COPY[id].title}</span>
                  <span className="overlay-chrome-card__desc">{ONBOARDING_PLACEMENT_COPY[id].desc}</span>
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className="onboard-cta no-drag focus-ring disabled:opacity-60"
            onClick={continueFromPlacement}
            disabled={placementLocked || saving}
            data-onboard-placement-continue="1"
          >
            Continue
          </button>
        </>
      ) : (
        <>
          <div className="onboard-act4-heading flex flex-col items-center gap-2">
            <h2 className="onboard-act4-title">{ONBOARDING_CHROME_HEADING}</h2>
            <p className="onboard-act4-lead">{ONBOARDING_CHROME_LEAD}</p>
          </div>
          <div role="radiogroup" aria-label="Overlay chrome" className="overlay-chrome-grid">
            {cards.map((card) => {
              const on = chromeId === card.id
              return (
                <button
                  key={card.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={locked || saving}
                  onClick={() => pickChrome(card.id)}
                  className={
                    'overlay-chrome-card no-drag focus-ring ' +
                    (on ? 'overlay-chrome-card--selected' : '') +
                    (locked || saving ? ' opacity-60' : '')
                  }
                >
                  <ChromeCardThumb id={card.id} selected={on} />
                  <span className="overlay-chrome-card__title">
                    {card.title}
                    {card.default ? <span className="overlay-chrome-card__default">Default</span> : null}
                  </span>
                  <span className="overlay-chrome-card__desc">{card.desc}</span>
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className="onboard-appearance-back no-drag focus-ring text-[12px] text-white/70 underline-offset-2 hover:text-white"
            onClick={() => setStep('placement')}
            disabled={saving}
          >
            Back to placement
          </button>
        </>
      )}
      {saving ? (
        <p aria-live="polite" className="m-0 text-center text-[11px] text-white/70">
          Saving your appearance…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-center text-[11px] text-[#ffb4b4]">
          {error}
        </p>
      ) : null}
      {onContinue && step === 'chrome' ? (
        <button
          type="button"
          onClick={onContinue}
          disabled={saving}
          className="onboard-cta no-drag focus-ring disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
      ) : null}
      {/* silence unused value lint when parent still tracks layout */}
      <span className="sr-only" aria-hidden="true">
        {value}
      </span>
    </div>
  )
}
