import {
  Image,
  Eye,
  EyeOff,
  AudioLines,
  LayoutGrid,
  FileText,
  Pause
} from 'lucide-react'
import { Spinner } from './ui'

function clock(s: number): string {
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

/**
 * Detached control pill — rendered by App horizontally centered below the answer when hideToolbar=true.
 * Mirrors the toolbar controls from Bar without the Mantu mark, history, or panel-expand buttons.
 * All props are optional so App can wire them incrementally.
 */
export interface ControlBarProps {
  /** Whether a screen capture is in progress. */
  capturing?: boolean
  onCapture?: () => void
  /** true = hidden from screen sharing (stealth on). */
  stealth?: boolean
  onToggleStealth?: () => void
  /** Whether the live session microphone is active. */
  listening?: boolean
  /** Elapsed recording time in seconds. */
  seconds?: number
  /** Toggles the listen/recording state (also used for the Pause button for now). */
  onToggleListen?: () => void
  /** Opens the transcript view (shown as a text button when listening). */
  onViewTranscript?: () => void
  /** Routes to Settings → Personalize for mode switching. */
  onOpenModes?: () => void
}

/**
 * Presentational glass pill containing the same controls as the Bar toolbar.
 * App renders it horizontally centered below the answer panel.
 */
export function ControlBar(props: ControlBarProps): JSX.Element {
  const {
    capturing = false,
    onCapture,
    stealth = true,
    onToggleStealth,
    listening = false,
    seconds = 0,
    onToggleListen,
    onViewTranscript,
    onOpenModes
  } = props

  return (
    <div className="aw-pill inline-flex items-center gap-3 px-4 py-2">
      {/* Capture */}
      <button
        type="button"
        title="Capture screen  (⌘⇧S)"
        aria-label="Capture screen"
        onClick={onCapture}
        className="no-drag focus-ring grid place-items-center rounded-lg p-1 text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
      >
        {capturing ? <Spinner size={18} /> : <Image size={18} strokeWidth={1.85} />}
      </button>

      {/* Stealth — danger-colored when NOT in stealth (i.e. visible to screen sharing) */}
      <button
        type="button"
        title={
          stealth
            ? 'Hidden from screen sharing. Others cannot see Métis. Click to show.'
            : 'Visible in screen sharing. Others can see Métis. Click to hide.'
        }
        aria-label={stealth ? 'Show to screen sharing' : 'Hide from screen sharing'}
        onClick={onToggleStealth}
        className={[
          'no-drag focus-ring grid place-items-center rounded-lg p-1 transition-colors duration-[var(--duration-hover)]',
          !stealth
            ? 'text-[color:var(--color-danger)]'
            : 'text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        {stealth ? <EyeOff size={18} strokeWidth={1.85} /> : <Eye size={18} strokeWidth={1.85} />}
      </button>

      {/* Mode — read-only pivot; routes to Settings → Personalize */}
      <button
        type="button"
        title="Conversation mode"
        aria-label="Conversation mode"
        onClick={onOpenModes}
        className="no-drag focus-ring grid place-items-center rounded-lg p-1 text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
      >
        <LayoutGrid size={18} strokeWidth={1.85} />
      </button>

      {/* Divider */}
      <span className="h-4 w-px bg-[var(--color-hair-soft)]" />

      {/* Listen / rec indicator */}
      <button
        type="button"
        title={listening ? 'End meeting & get summary' : 'Start listening'}
        aria-label={listening ? 'End meeting' : 'Start listening'}
        onClick={onToggleListen}
        className={[
          'no-drag focus-ring grid place-items-center rounded-lg p-1 transition-colors duration-[var(--duration-hover)]',
          listening
            ? 'text-[color:var(--color-danger)]'
            : 'text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]'
        ].join(' ')}
      >
        {listening ? (
          <span className="rec-dot h-[10px] w-[10px] rounded-full bg-[var(--color-danger)] shadow-[0_0_8px_var(--color-danger)]" />
        ) : (
          <AudioLines size={18} strokeWidth={1.85} />
        )}
      </button>

      {/* Live-session controls — only shown while listening */}
      {listening && (
        <>
          <span className="tabular-nums text-[12px] font-medium text-[color:var(--color-danger)]">
            {clock(seconds)}
          </span>
          {/* Pause — wired to listen-toggle for now; a true pause state is out of scope. */}
          <button
            type="button"
            title="Pause recording"
            aria-label="Pause recording"
            onClick={onToggleListen}
            className="no-drag focus-ring grid place-items-center rounded-lg p-1 text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
          >
            <Pause size={16} strokeWidth={1.85} />
          </button>
          <button
            type="button"
            onClick={onViewTranscript}
            className="no-drag focus-ring flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[color:var(--color-ink-2)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
          >
            <FileText size={12} strokeWidth={1.85} />
            View Transcript
          </button>
        </>
      )}
    </div>
  )
}
