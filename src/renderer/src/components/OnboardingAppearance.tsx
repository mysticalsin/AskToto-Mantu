import { useEffect, useState } from 'react'
import type { OverlayLayout } from '@shared/overlay-chrome'
import { OverlayChromePicker } from './OverlayChromePicker'
import { MetisMark } from './MetisMark'
import {
  appearancePreviewInitialPhase,
  appearancePreviewShowsBar,
  appearancePreviewShowsHint,
  appearancePreviewShowsIsland,
  ONBOARDING_APPEARANCE_COPY,
  ONBOARDING_APPEARANCE_HEADING,
  ONBOARDING_APPEARANCE_LEAD,
  reduceAppearancePreview,
  type AppearancePreviewPhase
} from '../lib/onboarding-appearance'

function AppearanceLivePreview({ layout }: { layout: OverlayLayout }): JSX.Element {
  const [phase, setPhase] = useState<AppearancePreviewPhase>(() => appearancePreviewInitialPhase(layout))

  useEffect(() => {
    setPhase(appearancePreviewInitialPhase(layout))
  }, [layout])

  const send = (event: Parameters<typeof reduceAppearancePreview>[2]): void => {
    setPhase((current) => reduceAppearancePreview(layout, current, event))
  }

  const showBar = appearancePreviewShowsBar(phase)
  const showIsland = appearancePreviewShowsIsland(layout, phase)
  const showHint = appearancePreviewShowsHint(layout, phase)
  const hitLabel =
    layout === 'hide' ? 'Click the top to open Hidden' : layout === 'island' ? 'Hover the island to open' : 'Bar stays on screen'

  return (
    <div
      className={'onboard-appearance-preview' + (layout === 'bar' ? ' onboard-appearance-preview--bar' : '')}
      data-appearance-preview={layout}
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
      {showBar ? (
        <div className="onboard-appearance-preview__bar-slot">
          <div
            className={
              'onboard-appearance-preview__bar' +
              (layout === 'bar' || phase === 'settled'
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

export function OnboardingAppearance({
  value,
  locked,
  compact,
  onChange,
  onContinue
}: {
  value: OverlayLayout
  locked: boolean
  compact?: boolean
  onChange: (id: OverlayLayout) => void
  onContinue?: () => void
}): JSX.Element {
  return (
    <div
      className={
        'onboard-appearance flex w-full flex-col items-center gap-5' + (compact ? ' onboard-appearance--compact' : '')
      }
    >
      <AppearanceLivePreview key={value} layout={value} />
      <div className="onboard-act4-heading flex flex-col items-center gap-2">
        <h2 className="onboard-act4-title">{ONBOARDING_APPEARANCE_HEADING}</h2>
        <p className="onboard-act4-lead">{ONBOARDING_APPEARANCE_LEAD}</p>
      </div>
      <OverlayChromePicker
        value={value}
        locked={locked}
        copy={ONBOARDING_APPEARANCE_COPY}
        onChange={onChange}
      />
      {onContinue ? (
        <button type="button" onClick={onContinue} className="onboard-cta no-drag focus-ring">
          Continue
        </button>
      ) : null}
    </div>
  )
}
