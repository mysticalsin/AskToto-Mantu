import { useLayoutEffect, useState } from 'react'
import type { OverlayLayout } from '@shared/overlay-chrome'
import type { OverlayPlacement } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'
import { OverlayChromePicker } from './OverlayChromePicker'
import { OverlayPlacementPicker } from './OverlayPlacementPicker'
import { MetisMark } from './MetisMark'
import {
  appearancePreviewEdgeState,
  appearancePreviewInitialPhase,
  appearancePreviewStateKey,
  appearancePreviewShowsBar,
  appearancePreviewShowsHint,
  appearancePreviewShowsIsland,
  ONBOARDING_APPEARANCE_HEADING,
  ONBOARDING_APPEARANCE_LEAD,
  ONBOARDING_POSITION_HEADING,
  ONBOARDING_POSITION_LEAD,
  onboardingAppearanceCopy,
  placementDemoLayout,
  placementPreviewCaption,
  reduceAppearancePreview,
  type AppearancePreviewPhase
} from '../lib/onboarding-appearance'

function AppearanceLivePreview({ layout, placement }: { layout: OverlayLayout; placement: OverlayPlacement }): JSX.Element {
  const presentation = resolveOverlayPresentation({ layout, placement })
  const presentationLayout = presentation.layout
  const rightEdgePreview = presentation.surface === 'edge-chat'
  const previewStateKey = appearancePreviewStateKey(presentationLayout, rightEdgePreview)
  const [phase, setPhase] = useState<AppearancePreviewPhase>(() => appearancePreviewInitialPhase(presentationLayout))

  useLayoutEffect(() => {
    setPhase(appearancePreviewInitialPhase(presentationLayout))
  }, [presentationLayout, previewStateKey])

  const send = (event: Parameters<typeof reduceAppearancePreview>[2]): void => {
    setPhase((current) => reduceAppearancePreview(presentationLayout, current, event, placement))
  }

  const showBar = !rightEdgePreview && appearancePreviewShowsBar(phase)
  const showIsland = !rightEdgePreview && appearancePreviewShowsIsland(presentationLayout, phase)
  const showHint = !rightEdgePreview && appearancePreviewShowsHint(presentationLayout, phase)
  const edgeState = appearancePreviewEdgeState(presentationLayout, phase)
  const placementLabel = placement === 'right-edge' ? 'right edge' : 'top'
  const hitLabel =
    rightEdgePreview
      ? `Hover the right edge ${presentationLayout === 'hide' ? 'zone' : 'rail'} to preview ${presentationLayout === 'hide' ? 'Hidden' : 'Island'}`
      : presentationLayout === 'hide'
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
          {edgeState.showEdgeGlow ? (
            <span data-edge-glow="true" aria-hidden="true" className="onboard-appearance-preview__edge-glow" />
          ) : null}
          {edgeState.showDrawer ? (
            <div
              data-edge-drawer="true"
              aria-hidden="true"
              className={
                'onboard-appearance-preview__edge-drawer' +
                (phase === 'in'
                  ? ' onboard-appearance-preview__edge-drawer--in'
                  : phase === 'out'
                    ? ' onboard-appearance-preview__edge-drawer--out'
                    : '')
              }
              onAnimationEnd={(event) => {
                if (event.target !== event.currentTarget) return
                if (phase === 'in') send('spring-in-end')
                if (phase === 'out') send('spring-out-end')
              }}
            >
              <MetisMark size={14} />
              <span>Command sidecar</span>
            </div>
          ) : null}
          {edgeState.showRail ? (
            <span data-edge-tab="true" aria-hidden="true" className="onboard-appearance-preview__edge-rail" />
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        className="onboard-appearance-preview__hit no-drag"
        aria-label={hitLabel}
        onClick={() => send('click-top')}
        onPointerEnter={() => send('hover-enter')}
        onPointerLeave={() => send('hover-leave')}
        onFocus={() => send('hover-enter')}
        onBlur={() => send('hover-leave')}
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
  const [step, setStep] = useState<'position' | 'appearance'>('position')
  const previewLayout = step === 'position' ? placementDemoLayout(placement) : value

  return (
    <div
      className={
        'onboard-appearance flex w-full flex-col items-center gap-5' + (compact ? ' onboard-appearance--compact' : '')
      }
      data-onboard-appearance-step={step}
    >
      <AppearanceLivePreview layout={previewLayout} placement={placement} />
      <p
        className="onboard-appearance-preview-caption"
        data-placement-caption={placement}
      >
        {step === 'position' ? placementPreviewCaption(placement) : 'Preview your chosen resting shape.'}
      </p>
      {step === 'position' ? (
        <>
          <div className="onboard-act4-heading flex flex-col items-center gap-2">
            <h2 className="onboard-act4-title">{ONBOARDING_POSITION_HEADING}</h2>
            <p className="onboard-act4-lead">{ONBOARDING_POSITION_LEAD}</p>
          </div>
          <div className="flex w-full flex-col gap-2">
            <p className="m-0 text-center text-[12px] font-medium text-white">Position</p>
            <p className="m-0 text-center text-[11px] leading-snug text-white/70">
              Right edge stays beside your meeting. Drag it up or down anytime.
            </p>
            <OverlayPlacementPicker value={placement} locked={placementLocked || saving} onChange={onPlacementChange} />
          </div>
          <button
            type="button"
            className="onboard-cta no-drag focus-ring disabled:opacity-60"
            data-onboard-placement-continue="1"
            disabled={saving}
            onClick={() => setStep('appearance')}
          >
            Continue to appearance
          </button>
        </>
      ) : (
        <>
          <div className="onboard-act4-heading flex flex-col items-center gap-2">
            <h2 className="onboard-act4-title">{ONBOARDING_APPEARANCE_HEADING}</h2>
            <p className="onboard-act4-lead">{ONBOARDING_APPEARANCE_LEAD}</p>
          </div>
          <OverlayChromePicker
            value={value}
            placement={placement}
            locked={locked || saving}
            copy={onboardingAppearanceCopy(placement)}
            onChange={onChange}
          />
          <button
            type="button"
            className="onboard-appearance-back no-drag focus-ring text-[12px] text-white/70 underline-offset-2 hover:text-white"
            disabled={saving}
            onClick={() => setStep('position')}
          >
            Back to position
          </button>
        </>
      )}
      {saving ? (
        <p aria-live="polite" className="m-0 text-center text-[11px] text-white/70">Saving your appearance…</p>
      ) : null}
      {error ? <p role="alert" className="m-0 text-center text-[11px] text-[#ffb4b4]">{error}</p> : null}
      {onContinue && step === 'appearance' ? (
        <button type="button" onClick={onContinue} disabled={saving} className="onboard-cta no-drag focus-ring disabled:opacity-60">
          {saving ? 'Saving…' : 'Continue'}
        </button>
      ) : null}
    </div>
  )
}
