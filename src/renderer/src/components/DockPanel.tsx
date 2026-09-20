import { memo, useCallback, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { AudioLines, Brain, Image, Settings, X, CornerDownLeft } from 'lucide-react'
import { MetisMark } from './MetisMark'

const ICON = 17
const STROKE = 1.85

/**
 * Cap4 expanded right-edge sidecar — Bar DNA glass, not stub buttons.
 * DESIGN: docs/design/CAP4-SIDEBOX-DESIGN.md
 */
export const DockPanel = memo(function DockPanel({
  askValue,
  onAskChange,
  onAskSubmit,
  askBusy,
  onListen,
  listening,
  onCapture,
  captureAvailable,
  onOpenIntelligence,
  onOpenSettings,
  onCollapse
}: {
  askValue: string
  onAskChange: (v: string) => void
  onAskSubmit: () => void
  askBusy: boolean
  onListen: () => void
  listening: boolean
  onCapture?: () => void
  captureAvailable: boolean
  onOpenIntelligence: () => void
  onOpenSettings: () => void
  onCollapse: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  const submitAsk = useCallback(() => {
    if (askBusy) return
    if (!askValue.trim()) return
    onAskSubmit()
  }, [askBusy, askValue, onAskSubmit])

  const onForm = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      submitAsk()
    },
    [submitAsk]
  )

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submitAsk()
      }
    },
    [submitAsk]
  )

  return (
    <div className="overlay-dock-panel" data-dock-panel="1" data-hug-width={true}>
      <header className="overlay-dock-panel__head">
        <div className="overlay-dock-panel__brand">
          <MetisMark size={18} />
          <span className="overlay-dock-panel__title">Métis</span>
        </div>
        <button
          type="button"
          className="overlay-dock-panel__icon-btn"
          title="Collapse"
          aria-label="Collapse side box"
          onClick={onCollapse}
        >
          <X size={16} strokeWidth={STROKE} />
        </button>
      </header>

      <form className="overlay-dock-panel__ask" onSubmit={onForm}>
        <input
          ref={inputRef}
          className="overlay-dock-panel__ask-input"
          type="text"
          value={askValue}
          onChange={(e) => onAskChange(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask anything…"
          aria-label="Ask anything"
          disabled={askBusy}
          autoComplete="off"
        />
        <button
          type="submit"
          className="overlay-dock-panel__ask-go"
          title="Ask"
          aria-label="Submit ask"
          disabled={askBusy || !askValue.trim()}
        >
          <CornerDownLeft size={15} strokeWidth={STROKE} />
        </button>
      </form>

      <div className="overlay-dock-panel__rows" role="list">
        <button
          type="button"
          role="listitem"
          className={[
            'overlay-dock-panel__row',
            listening ? 'overlay-dock-panel__row--live' : ''
          ].join(' ')}
          onClick={onListen}
        >
          <AudioLines size={ICON} strokeWidth={STROKE} className="overlay-dock-panel__row-icon" />
          <span className="overlay-dock-panel__row-label">Listen</span>
          {listening ? <span className="overlay-dock-panel__chip">Listening</span> : null}
        </button>

        {captureAvailable && onCapture ? (
          <button type="button" role="listitem" className="overlay-dock-panel__row" onClick={onCapture}>
            <Image size={ICON} strokeWidth={STROKE} className="overlay-dock-panel__row-icon" />
            <span className="overlay-dock-panel__row-label">Capture</span>
          </button>
        ) : null}

        <button type="button" role="listitem" className="overlay-dock-panel__row" onClick={onOpenIntelligence}>
          <Brain size={ICON} strokeWidth={STROKE} className="overlay-dock-panel__row-icon" />
          <span className="overlay-dock-panel__row-label">Intelligence</span>
        </button>
      </div>

      <footer className="overlay-dock-panel__foot">
        <button type="button" className="overlay-dock-panel__settings" onClick={onOpenSettings}>
          <Settings size={15} strokeWidth={STROKE} />
          <span>Settings</span>
        </button>
        {askBusy ? <span className="overlay-dock-panel__chip overlay-dock-panel__chip--busy">Busy</span> : null}
      </footer>
    </div>
  )
})
