import { useEffect, useState } from 'react'
import type { OverlayLayout } from '@shared/overlay-chrome'
import type { OverlayPlacement } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'
import { OverlayChromePicker } from './OverlayChromePicker'
import { OverlayPlacementPicker } from './OverlayPlacementPicker'
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

function AppearanceLivePreview({ layout, placement }: { layout: OverlayLayout; placement: OverlayPlacement }): JSX.Element {
  const presentation = resolveOverlayPresentation({ layout, placement })
  const presentationLayout = presentation.layout
  const rightEdgePreview = presentation.surface === 'edge-chat'
  const [phase, setPhase] = useState<AppearancePreviewPhase>(() => appearancePreviewInitialPhase(presentationLayout))

  useEffect(() => {
    setPhase(appearancePreviewInitialPhase(presentationLayout))
  }, [presentationLayout])

  const send = (event: Parameters<typeof reduceAppearancePreview>[2]): void => {
    setPhase((current) => reduceAppearancePreview(presentationLayout, current, event))
  }

  const showBar = !rightEdgePreview && appearancePreviewShowsBar(phase)
  const showIsland = !rightEdgePreview && appearancePreviewShowsIsland(presentationLayout, phase)
  const showHint = !rightEdgePreview && appearancePreviewShowsHint(presentationLayout, phase)
  const placementLabel = placement === 'right-edge' ? 'right edge' : 'top'
  const hitLabel =
    presentationLayout === 'hide'
      ? `Click the ${placementLabel} to open Hidden`
      : presentationLayout === 'island'
        ? 'Hover the island to open'
        : 'Bar stays on screen'

  return (
    <div
      className={
        'onboard-appearance-preview' +
        (presentationLayout === 'bar' ? ' onboard-appearance-preview--bar' : '') +
        (rightEdgePreview ? ' onboard-appearance-preview--right-edge' : '')
      }
      data-appearance-preview={presentationLayout}
      data-placement-preview={placement}
      data-appearance-phase={phase}
    >
      <div className="onboard-appearance-preview__desktop" aria-hidden="true" />
      {rightEdgePreview ? (
        <>
          <div data-edge-drawer="true" aria-hidden="true" className="absolute top-8 right-0 z-[1] flex h-16 w-2/3 items-center gap-2 rounded-l-xl border border-white/15 bg-black/45 px-3 text-[10px] text-white/80">
            <MetisMark size={14} />
            <span>Command sidecar</span>
          </div>
          <span data-edge-tab="true" aria-hidden="true" className="absolute top-12 right-0 z-[2] h-10 w-3 rounded-l-lg bg-[#d6baff]" />
        </>
      ) : null}
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
              (presentationLayout === 'bar' || phase === 'settled'
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
  placement,
  placementLocked,
  compact,
  saving = false,
  error = null,
  onChange,
  onPlacementChange,
  onContinue
}: {
  value: OverlayLayout
  locked: boolean
  placement: OverlayPlacement
  placementLocked: boolean
  compact?: boolean
  saving?: boolean
  error?: string | null
  onChange: (id: OverlayLayout) => void
  onPlacementChange: (id: OverlayPlacement) => void
  onContinue?: () => void
}): JSX.Element {
  return (
    <div
      className={
        'onboard-appearance flex w-full flex-col items-center gap-5' + (compact ? ' onboard-appearance--compact' : '')
      }
    >
      <AppearanceLivePreview key={`${value}:${placement}`} layout={value} placement={placement} />
      <div className="onboard-act4-heading flex flex-col items-center gap-2">
        <h2 className="onboard-act4-title">{ONBOARDING_APPEARANCE_HEADING}</h2>
        <p className="onboard-act4-lead">{ONBOARDING_APPEARANCE_LEAD}</p>
      </div>
      <div className="flex w-full flex-col gap-2">
        <p className="m-0 text-center text-[12px] font-medium text-white">Position</p>
        <p className="m-0 text-center text-[11px] leading-snug text-white/70">
          Right edge stays beside your meeting. Drag it up or down anytime.
        </p>
        <OverlayPlacementPicker value={placement} locked={placementLocked || saving} onChange={onPlacementChange} />
      </div>
      <OverlayChromePicker
        value={value}
        placement={placement}
        locked={locked || saving}
        copy={ONBOARDING_APPEARANCE_COPY}
        onChange={onChange}
      />
      {saving ? (
        <p aria-live="polite" className="m-0 text-center text-[11px] text-white/70">Saving your appearance…</p>
      ) : null}
      {error ? <p role="alert" className="m-0 text-center text-[11px] text-[#ffb4b4]">{error}</p> : null}
      {onContinue ? (
        <button type="button" onClick={onContinue} disabled={saving} className="onboard-cta no-drag focus-ring disabled:opacity-60">
          {saving ? 'Saving…' : 'Continue'}
        </button>
      ) : null}
    </div>
  )
}
