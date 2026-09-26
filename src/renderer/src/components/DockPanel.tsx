import { memo } from 'react'

/**
 * Cap4 revealed right-edge sidecar. Horizontal text, vertical stack.
 * Hover expands into this panel; rest chrome stays OverlayPeek dock sliver.
 * Entry points are truthful labels — they call the same handlers as Bar.
 */
export const DockPanel = memo(function DockPanel({
  onAsk,
  onListen,
  listening,
  onOpenIntelligence,
  onOpenSettings,
  askBusy
}: {
  onAsk: () => void
  onListen: () => void
  listening: boolean
  onOpenIntelligence: () => void
  onOpenSettings: () => void
  askBusy: boolean
}): JSX.Element {
  return (
    <div className="overlay-dock-panel" data-dock-panel="1" data-hug-width={true}>
      <div className="overlay-dock-panel__head">
        <span className="overlay-dock-panel__title">Métis</span>
        <span className="overlay-dock-panel__hint">Right edge</span>
      </div>
      <div className="overlay-dock-panel__actions">
        <button type="button" className="overlay-dock-panel__btn" onClick={onAsk} disabled={askBusy}>
          Ask
        </button>
        <button type="button" className="overlay-dock-panel__btn" onClick={onListen}>
          {listening ? 'Stop listen' : 'Listen'}
        </button>
        <button type="button" className="overlay-dock-panel__btn" onClick={onOpenIntelligence}>
          Intelligence
        </button>
        <button type="button" className="overlay-dock-panel__btn overlay-dock-panel__btn--ghost" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </div>
  )
})
