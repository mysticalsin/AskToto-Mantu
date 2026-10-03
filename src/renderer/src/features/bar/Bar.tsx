import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react'
import { AudioLines, Brain, ChevronDown, ChevronLeft, ChevronUp, CornerDownLeft, Eye, EyeOff, FileSearch, FileText, Image, LayoutGrid, Pause, Play, Square, X } from 'lucide-react'
import { MantuMark } from '../../components/MantuMark'
import { ModePicker } from '../../components/ModePicker'
import { InlineOrb } from '../../components/AgentStatus'
import { modeLabel } from '@shared/ipc'
import { accelLabel } from '../../lib/keys'
import { ScreenRepairButton } from '../../components/ScreenPermissionRow'
import { ObsidianOrb } from '../../components/ObsidianOrb'
import { JarvisOrbButton } from '../../components/JarvisOrbButton'
import { BAR_MARK_SIZE_PX } from '../../lib/bar-pill-orb'
import { overlayUsesJarvisOrb } from '@shared/overlay-orb'
import {
  ElapsedClock,
  ICON_STROKE,
  IconTool,
  ScreenFreshnessChip,
  answerBodyMaxHeight,
  type BarProps
} from './bar-chrome'

export { ElapsedClock, answerBodyMaxHeight, type BarProps } from './bar-chrome'

export const Bar = memo(function Bar(props: BarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.focusSignal > 0) inputRef.current?.focus()
  }, [props.focusSignal])

  // Mode popover (Cluely-style: click the grid icon, pick a mode right there — no Settings redirect).
  // Two refs because the popover itself renders as a SIBLING of the icon (see below — escaping
  // .aw-widget's overflow:hidden) — outside-click must not close it while a click lands in either.
  const [modeOpen, setModeOpen] = useState(false)
  const modeRef = useRef<HTMLDivElement>(null)
  const modePopoverRef = useRef<HTMLDivElement>(null)
  // The outer wrapper is the popover's actual positioned ancestor (it renders as a sibling of
  // .aw-widget, not inside it) — modeAnchorLeft is computed against this, not the viewport.
  const wrapRef = useRef<HTMLDivElement>(null)
  // Horizontal anchor (px from wrapRef's left edge) for the popover below, measured off modeRef's real
  // position so it originates from the icon that opens it instead of centering under the whole bar.
  const [modeAnchorLeft, setModeAnchorLeft] = useState<number | null>(null)
  useEffect(() => {
    if (!modeOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (modeRef.current?.contains(t)) return
      if (modePopoverRef.current?.contains(t)) return
      setModeOpen(false)
      modeRef.current?.querySelector('button')?.focus()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Stop this Escape from reaching App.tsx's window-level handler, which would otherwise also
        // collapse/hide the overlay on top of closing this popover.
        e.stopPropagation()
        setModeOpen(false)
        modeRef.current?.querySelector('button')?.focus()
        return
      }
      // Trap Tab within the open popover (WCAG 2.4.3): a keyboard-only user tabbing off the last item
      // would otherwise land on the page behind the menu. Wrap first↔last while it's open.
      if (e.key === 'Tab') {
        const pop = modePopoverRef.current
        if (!pop) return
        const focusables = Array.from(
          pop.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        )
        if (!focusables.length) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey) {
          if (active === first || !pop.contains(active)) {
            e.preventDefault()
            last.focus()
          }
        } else if (active === last || !pop.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [modeOpen])

  // Move focus into the popover the moment it opens, so Tab order and screen-reader focus start
  // inside the menu instead of staying stranded on the trigger.
  useEffect(() => {
    if (!modeOpen) return
    modePopoverRef.current?.querySelector('button')?.focus()
  }, [modeOpen])

  // Anchor the popover horizontally to the Mode icon's real position rather than the bar's center —
  // useLayoutEffect so this lands before paint (no visible snap from a fallback center position).
  // Clamped against the popover's own measured width so a long custom-mode list can never push it past
  // the bar's edges even though modeRef itself sits well left of center.
  useLayoutEffect(() => {
    if (!modeOpen) return
    const place = (): void => {
      const iconRect = modeRef.current?.getBoundingClientRect()
      const wrapRect = wrapRef.current?.getBoundingClientRect()
      if (!iconRect || !wrapRect) return
      const iconCenter = iconRect.left + iconRect.width / 2 - wrapRect.left
      const half = (modePopoverRef.current?.offsetWidth ?? 0) / 2
      const margin = 8
      setModeAnchorLeft(Math.min(Math.max(iconCenter, half + margin), wrapRect.width - half - margin))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [modeOpen])

  // When a body is present the bar EXPANDS into one surface (big input → body → toolbar at the bottom).
  const expanded = !!props.body
  const hasAnswer = props.hasAnswer ?? expanded

  // Row 1 and the toolbar row are memoized ELEMENTS: `body` gets a fresh reference on every RAF-batched
  // stream flush (up to 60/sec while an answer streams), which defeats Bar's outer memo — without these,
  // every flush rebuilt and reconciled ~50 chrome elements (9 IconTools, input, pills) whose state never
  // changes mid-stream. Stable element identity here makes React bail out of both subtrees, so a flush
  // only reconciles the body slot. Same isolation philosophy as ScreenFreshnessChip/ElapsedClock above.
  const inputRow = useMemo(
    () => (
        <div
          className={[
            'flex items-center gap-3 px-5 transition-[padding,font-size] duration-[var(--duration-panel)] ease-[var(--ease-spring)]',
            expanded ? 'border-b border-[var(--color-hair-soft)]' : ''
          ].join(' ')}
          style={{ paddingTop: expanded ? 11 : 5, paddingBottom: expanded ? 11 : 5 }}
        >
          {/* Back arrow — far left of the input row when an answer is open and onBack is provided */}
          {hasAnswer && props.onBack && (
            <button
              type="button"
              title="Back"
              aria-label="Back"
              onClick={props.onBack}
              className="no-drag focus-ring flex-none grid place-items-center rounded-[10px] p-1 text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
            >
              <ChevronLeft size={18} strokeWidth={ICON_STROKE} />
            </button>
          )}

          {/* Screen-freshness chip (e.g. 'Seen 0.3s ago') — real screen-capture age; ticks itself every
              500ms (see ScreenFreshnessChip above) so it never reads stale. */}
          <ScreenFreshnessChip capturedAt={props.screenCapturedAt} />

          {/* "Heard live" chip — sibling of the screen-freshness chip above (same pill styling), driven
              directly by the real listening state (props.listening, sourced from useListen()'s live audio
              pipeline) rather than a separate signal. Kept as its own chip instead of merged into
              contextLabel because the two facts are independent: a screen can be stale while audio is
              live, or vice versa — a single chip could only ever show one of them at a time. */}
          {props.listening && (
            <span
              // Degraded capture (mic-only / no-mic) turns the chip amber with the honest label — the
              // deliberate no-live-banner design stays (nothing new appears, nothing interrupts), but the
              // one piece of persistent chrome that said "Heard live" stops claiming a side it isn't
              // capturing. Tooltip carries the full platform-aware cause + fix (e.g. Screen Recording).
              title={
                !props.paused
                  ? ([
                      props.captureDegraded?.note ?? null,
                      props.captureHealth
                        ? `Live microphone: ${props.captureHealth.selectionOutcome}; input ${props.captureHealth.inputSampleRate ?? 'unknown'} Hz, ${props.captureHealth.inputChannelCount ?? 'unknown'} channel(s) → 16 kHz processing. Settings meter is preflight only.`
                        : null,
                      props.recognizerStatus
                        ? `Transcription: ${props.recognizerStatus.model ?? `${props.recognizerStatus.engine} starting`}; language ${props.recognizerStatus.languageMode}${props.recognizerStatus.language ? ` (${props.recognizerStatus.language})` : ''}${props.recognizerStatus.requestedLanguage ? `; requested (${props.recognizerStatus.requestedLanguage})` : ''}.`
                        : null
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined)
                  : undefined
              }
              className={[
                'flex flex-none items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px]',
                !props.paused && (props.captureDegraded || props.noSpeechWarning || props.captureHealth?.selectionOutcome === 'fallback-default' || props.captureHealth?.selectionOutcome === 'unavailable')
                  ? 'text-[color:var(--color-warn)]'
                  : 'text-[color:var(--color-ink-2)]'
              ].join(' ')}
            >
              {props.paused ? (
                <>
                  <Pause size={11} strokeWidth={ICON_STROKE} className="text-[color:var(--color-warn)]" />
                  Paused
                </>
              ) : props.captureDegraded ? (
                <>
                  <span className="h-[6px] w-[6px] rounded-full bg-[color:var(--color-warn)]" />
                  <AudioLines size={11} strokeWidth={ICON_STROKE} />
                  {props.captureDegraded.side === 'them' ? 'Mic only' : 'No mic'}{props.captureDegraded.repair && <ScreenRepairButton />}
                </>
              ) : props.captureHealth?.selectionOutcome === 'unavailable' ? (
                <>
                  <span className="h-[6px] w-[6px] rounded-full bg-[color:var(--color-warn)]" />
                  <AudioLines size={11} strokeWidth={ICON_STROKE} />
                  No mic
                </>
              ) : props.noSpeechWarning ? (
                <>
                  <span className="h-[6px] w-[6px] rounded-full bg-[color:var(--color-warn)]" />
                  <AudioLines size={11} strokeWidth={ICON_STROKE} />
                  No speech detected
                </>
              ) : props.captureHealth?.selectionOutcome === 'fallback-default' ? (
                <>
                  <span className="h-[6px] w-[6px] rounded-full bg-[color:var(--color-warn)]" />
                  <AudioLines size={11} strokeWidth={ICON_STROKE} />
                  Mic fallback
                </>
              ) : (
                <>
                  <span className="h-[6px] w-[6px] rounded-full bg-[var(--color-danger)]" />
                  <AudioLines size={11} strokeWidth={ICON_STROKE} />
                  Heard live
                </>
              )}
            </span>
          )}

          <input
            ref={inputRef}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            // MQA-236: focusing the box to TYPE must not touch the screen — prewarmCapture() takes a
            // real frame ('prewarm' capture in main). The warm now rides hovering the Capture button,
            // the one place screen intent is actually signalled before the click.
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                props.onSubmit()
              }
            }}
            placeholder={
              // State-driven (Cluely-style): a live meeting reframes it around the conversation; after an
              // answer it invites a follow-up; idle it points at the screen.
              props.listening
                ? hasAnswer
                  ? 'Ask a follow-up about the meeting…'
                  : 'Ask anything about the meeting'
                : hasAnswer
                  ? 'Ask a follow-up…'
                  : 'Ask anything about your screen'
            }
            spellCheck={false}
            aria-label="Ask Métis anything"
            className={[
              // Brighter tier + a drop-shadow on the placeholder (same fix already applied to the
              // QuickActions hint) — "Ask anything…" pops clearly over any desktop, light or dark.
              'no-drag focus-ring font-body min-w-0 flex-1 bg-transparent tracking-[-0.01em] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-2)] placeholder:[text-shadow:0_1px_3px_rgba(0,0,0,0.65)] caret-[var(--color-accent-2)] transition-[font-size] duration-[var(--duration-panel)] ease-[var(--ease-spring)]',
              expanded ? 'text-[18px] font-[450]' : 'text-[15px] font-[450]'
            ].join(' ')}
          />

          {props.busy ? (
            <button
              type="button"
              title={props.listening ? 'Stop & end meeting' : 'Stop'}
              aria-label={props.listening ? 'Stop and end meeting' : 'Stop'}
              // While a meeting is live this is the big, obvious control in the bar — it must end the
              // meeting (same path as the toolbar's rec-dot / Square Stop), not just cancel whatever
              // answer happens to be streaming. Cancelling-only here silently ate the click: the stream
              // stopped, the button reverted to "Ask", and the meeting kept running with no summary.
              // Outside a meeting this button has no "end" concept, so it keeps the plain stream-cancel.
              onClick={props.listening ? props.onToggleListen : props.onStop}
              className="no-drag focus-ring grid h-[38px] w-[46px] place-items-center rounded-[10px] border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] text-[color:var(--color-danger)] hover:bg-[var(--color-danger)]/20"
            >
              <X size={18} />
            </button>
          ) : (
            // Hero submit — accent-filled, ~38px. The only aw-fill control in the bar row.
            <button
              type="button"
              title={`Ask (${accelLabel('Return')})`}
              aria-label="Ask"
              onClick={props.onSubmit}
              className="aw-fill no-drag focus-ring flex-none grid h-[38px] w-[46px] place-items-center rounded-[10px] text-white transition-colors duration-[var(--duration-hover)]"
            >
              <CornerDownLeft size={15} strokeWidth={ICON_STROKE} />
            </button>
          )}
        </div>
    ),
    [expanded, hasAnswer, props.onBack, props.screenCapturedAt, props.listening, props.paused, props.captureDegraded, props.captureHealth, props.noSpeechWarning, props.recognizerStatus, props.value, props.onChange, props.canPrewarm, props.onSubmit, props.busy, props.onToggleListen, props.onStop]
  )

  const toolbarRow = useMemo(
    () => (
        <div
          className="aw-toolbar border-t border-[var(--color-hair-soft)]"
          data-bar-toolbar
          data-bar-listening={props.listening ? 'true' : 'false'}
        >
          {/* The Mantu mark IS the logo → opens Settings. Locked circle: Listen chrome
              may expand the Bar, but this M must not flatten, stretch, or clip into a bar. */}
          <button
            type="button"
            title="Settings"
            aria-label="Settings"
            data-bar-mark
            onClick={props.onSettings}
            className="aw-bar-mark no-drag focus-ring"
          >
            <span className="aw-bar-mark__disk aw-mark-glow">
              <MantuMark size={BAR_MARK_SIZE_PX} round />
            </span>
          </button>

          {/* Icon cluster. No dummy 100px spacer — that stole width and collided with the
              right reserved slots at production overlay width. Tools flex in leftover space. */}
          <div className="aw-toolbar__tools" data-bar-tools>
            <IconTool
              title={props.captureAccel ? `Capture screen (${accelLabel(props.captureAccel)})` : 'Capture screen'}
              onClick={props.onCapture}
              onMouseEnter={() => { if (props.canPrewarm) void window.toto.prewarmCapture() }}
              onMouseDown={() => { if (props.canPrewarm) void window.toto.prewarmCapture() }}
            >
              {props.capturing ? <InlineOrb kind="working" /> : <Image size={19} strokeWidth={ICON_STROKE} />}
            </IconTool>
            {/* Spotlight Ref stays visible so users can discover it before configuring Dust. The
                unavailable click path names the required setup instead of silently hiding the tool. */}
            <IconTool
              title={props.spotlightReady ? 'Spotlight Ref' : 'Spotlight Ref · Connect Dust in Settings'}
              onClick={() => props.onSpotlightRef?.()}
            >
              <FileSearch size={19} strokeWidth={ICON_STROKE} />
            </IconTool>
            {/* Mode — click opens a popover (ModePicker) to switch directly, Cluely-style. The popover
                itself renders OUTSIDE .aw-widget (see below `.aw-widget`'s closing tag) because this
                widget has overflow:hidden for its rounded-corner blur backdrop, which would otherwise
                clip the popover. The tooltip shows the CURRENT mode name (e.g. "General"), matching
                Cluely's own hover behavior, rather than a generic description. */}
            <div ref={modeRef}>
              <IconTool
                title={modeLabel(props.mode, props.customModes)}
                onClick={() => setModeOpen((o) => !o)}
                active={modeOpen}
                ariaHasPopup
                ariaExpanded={modeOpen}
                edgeLeft
              >
                <LayoutGrid size={19} strokeWidth={ICON_STROKE} />
              </IconTool>
            </div>
            {/* Deep thinking — forces every answer to the strongest model (settings.thinkingMode 'always').
                The spinning rainbow ring makes the "on" state unmistakable at a glance. */}
            <IconTool
              title={props.thinkingOn ? 'Deep thinking on' : 'Deep thinking off'}
              onClick={() => props.onToggleThinking?.()}
              active={props.thinkingOn}
              rainbow={props.thinkingOn}
            >
              <Brain size={19} strokeWidth={ICON_STROKE} />
            </IconTool>
            {/* Window visibility on a shared/recorded screen (contentProtection). Hidden by default —
                the invisible-copilot identity — so EyeOff (hidden) is the muted resting state. Eye
                (visible) is the exceptional, attention-worthy state where others CAN see the overlay, so
                it lights with danger as an at-a-glance "you're exposed" cue. Separate from Private View
                (whether Métis captures YOUR screen), which lives in Settings → Privacy. */}
            {/* MQA-036: this button toggles contentProtection ("can other people see the Métis overlay in
                a screen share"), NOT privateView ("can Métis see YOUR screen") — two different settings
                keys. It was labelled "Private view", the exact name of the OTHER control in
                Settings → Privacy, and its tooltip showed the inverse state, so a user protecting a live
                screen share clicked it believing it hid something and instead REVEALED the overlay to
                everyone on the call. The label now states what it actually does. */}
            <IconTool
              title={
                props.stealthLocked
                  ? 'Hidden from screen share: managed by your organization'
                  : props.stealth
                    ? 'Hidden from screen share. Click to make Métis visible.'
                    : 'Visible in screen share. Click to hide Métis.'
              }
              onClick={props.onToggleStealth}
              active={!props.stealth}
              danger
              disabled={props.stealthLocked}
            >
              {props.stealth ? <EyeOff size={19} strokeWidth={ICON_STROKE} /> : <Eye size={19} strokeWidth={ICON_STROKE} />}
            </IconTool>
            <span className="h-5 w-px bg-[var(--color-hair-soft)]" />
            <IconTool
              title={props.listening ? 'End meeting & get summary' : 'Start listening'}
              onClick={props.onToggleListen}
              active={props.listening}
              danger
              cyanIdle
            >
              {props.listening ? (
                <span
                  className={[
                    'h-[12px] w-[12px] rounded-full rec-dot',
                    props.paused
                      ? 'bg-[color:var(--color-ink-3)] [animation-play-state:paused]'
                      : 'bg-[var(--color-danger)] shadow-[0_0_8px_var(--color-danger)]'
                  ].join(' ')}
                />
              ) : (
                <AudioLines size={19} strokeWidth={ICON_STROKE} />
              )}
            </IconTool>
          </div>

          {/* Right reserved slots. Listening is already a meeting: no "+ New meeting" here
              (that action stays after Stop / on Review / History). Timer + pause own one box. */}
          <div className="aw-toolbar__actions" data-bar-actions>
            {props.listening && (
              <div className="aw-toolbar__timer" data-bar-listen-timer>
                  <ElapsedClock
                    startedAt={props.startedAt}
                    paused={props.paused}
                    pausedMs={props.pausedMs ?? 0}
                    pausedAt={props.pausedAt ?? null}
                  />
                  {/* Pause suspends capture (mic + system audio stay warm, nothing is finalized/saved) —
                      distinct from Stop (the danger rec-dot in the tools cluster), which ends the meeting. */}
                  <button
                    type="button"
                    title={props.paused ? 'Resume recording' : 'Pause recording'}
                    aria-label={props.paused ? 'Resume recording' : 'Pause recording'}
                    onClick={props.onTogglePause}
                    className="no-drag focus-ring grid place-items-center rounded-[10px] p-1 text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
                  >
                    {props.paused ? (
                      <Play size={16} strokeWidth={ICON_STROKE} />
                    ) : (
                      <Pause size={16} strokeWidth={ICON_STROKE} />
                    )}
                  </button>
                  {/* Stop — ends the meeting (recap + save), identical to the rec-dot; an explicit
                      square makes "end" discoverable next to Pause instead of hiding behind the dot. */}
                  <button
                    type="button"
                    title="Stop & end meeting"
                    aria-label="Stop and end meeting"
                    onClick={props.onToggleListen}
                    className="no-drag focus-ring grid place-items-center rounded-[10px] p-1 text-[color:var(--color-danger)] transition-colors duration-[var(--duration-hover)] hover:brightness-125"
                  >
                    <Square size={14} strokeWidth={ICON_STROKE} fill="currentColor" />
                  </button>
              </div>
            )}
            {props.listening ? (
                <button
                  type="button"
                  data-bar-transcript
                  title={props.transcriptShown ? 'Hide the live transcript' : 'Show the live transcript'}
                  onClick={props.onTranscript}
                  className="aw-toolbar__transcript no-drag focus-ring flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white/[0.05] px-2.5 py-1.5 text-[13px] font-semibold leading-none text-[color:var(--color-ink-2)] transition-colors duration-[var(--duration-hover)] hover:bg-white/[0.1] hover:text-[color:var(--color-ink)]"
                >
                  <FileText size={13} strokeWidth={ICON_STROKE} />
                  <span className="aw-toolbar__transcript-copy">Transcript</span>
                </button>
            ) : (
              <button
                type="button"
                data-bar-history
                onClick={props.onHistory}
                className="no-drag focus-ring flex items-center gap-1.5 rounded-full bg-white/[0.05] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-ink-2)] transition-colors duration-[var(--duration-hover)] hover:bg-white/[0.1] hover:text-[color:var(--color-ink)]"
              >
                History
                <ChevronDown size={13} strokeWidth={ICON_STROKE} />
              </button>
            )}
            {props.canMinimize !== false ? (
              overlayUsesJarvisOrb('bar', props.orbStyle) ? (
                <ObsidianOrb
                  orbMood={props.orbMood ?? 'idle'}
                  listening={props.listening}
                  title="Minimize to the orb"
                  ariaLabel="Minimize to the orb"
                  onActivate={props.onMinimize}
                />
              ) : (
                <JarvisOrbButton
                  orbMood={props.orbMood ?? 'idle'}
                  listening={props.listening}
                  title="Minimize to the orb"
                  ariaLabel="Minimize to the orb"
                  onActivate={props.onMinimize}
                />
              )
            ) : null}
            {/* Collapse-chevron: plain ghost, not aw-fill. Submit is the only accent-filled control.
                Disabled (not hidden, so the toolbar doesn't jump) when there's nothing behind the bar
                for it to reveal — e.g. idle with no answer/history/settings open. */}
            <button
              type="button"
              data-bar-chevron
              title={!props.canTogglePanel ? 'Nothing to expand yet' : props.panelOpen ? 'Collapse' : 'Expand'}
              aria-label={props.panelOpen ? 'Collapse' : 'Expand'}
              aria-disabled={!props.canTogglePanel}
              disabled={!props.canTogglePanel}
              onClick={props.onTogglePanel}
              className={[
                'no-drag focus-ring grid h-[32px] w-[36px] place-items-center rounded-[10px] text-[color:var(--color-ink-3)] transition-colors duration-[var(--duration-hover)]',
                props.canTogglePanel ? 'hover:text-[color:var(--color-ink)]' : 'cursor-not-allowed opacity-40'
              ].join(' ')}
            >
              {props.panelOpen ? <ChevronUp size={16} strokeWidth={ICON_STROKE} /> : <ChevronDown size={16} strokeWidth={ICON_STROKE} />}
            </button>
          </div>
        </div>
    ),
    [props.onSettings, props.listening, props.onCapture, props.capturing, props.captureAccel, props.spotlightReady, props.onSpotlightRef, props.mode, props.customModes, modeOpen, props.thinkingOn, props.onToggleThinking, props.stealth, props.onToggleStealth, props.stealthLocked, props.onToggleListen, props.paused, props.startedAt, props.pausedMs, props.pausedAt, props.onTogglePause, props.transcriptShown, props.onTranscript, props.onHistory, props.onMinimize, props.canMinimize, props.orbMood, props.orbStyle, props.canTogglePanel, props.panelOpen, props.onTogglePanel]
  )

  return (
    // The flex-col lets additional in-flow elements grow the window as needed.
    <div ref={wrapRef} className="relative flex w-full flex-col items-stretch gap-1.5">
      <div
        className={[
          'aw-widget w-full',
          // Working → fast rainbow ring; Private view on → calm slow rainbow contour as the indicator.
          props.busy ? 'rainbow-ring' : props.stealth ? 'aw-hidden-rainbow' : ''
        ].join(' ')}
      >
        {/* Row 1 — hero input + ↵ submit (memoized element above). */}
        {inputRow}

        {/* Body — grid-rows 0fr<->1fr switches INSTANTLY (not transitioned); only opacity animates.
            Always rendered so the fade runs on mount rather than snapping on conditional mount/unmount.
            grid-template-rows used to be in the transitioned-properties list too, animating height over
            var(--duration-panel) on EVERY answer/suggestion mount — a layout property, not transform/
            opacity, so Chromium re-lays-out this box on every animation frame of that transition, and
            each of those frames is a real ResizeObserver tick that pushed an immediate (unthrottled,
            un-quantized-away) native window resize the whole time the panel was opening. Jumping the
            grid track straight to its final size turns that into the single instantaneous step the rest
            of the app already treats content changes as, while the opacity fade (GPU/compositor-only,
            no further layout work) keeps the same visual reveal. */}
        <div
          className="grid overflow-hidden transition-opacity duration-[var(--duration-panel)] ease-[var(--ease-spring)]"
          style={{
            gridTemplateRows: props.body ? '1fr' : '0fr',
            opacity: props.body ? 1 : 0
          }}
        >
          <div className="min-h-0">
            <div
              className="aw-body scroll-thin overflow-y-auto px-5 py-3"
              style={{ maxHeight: answerBodyMaxHeight() }}
            >
              {props.body}
            </div>
          </div>
        </div>

        {/* Row 2 — toolbar (memoized element above, same rationale as Row 1). */}
        {toolbarRow}
      </div>

      {/* Mode popover — deliberately a SIBLING of .aw-widget (not nested inside it), because .aw-widget
          has overflow:hidden for its rounded-corner blur backdrop, which would otherwise clip this.
          Anchored to modeAnchorLeft (the Mode icon's own measured position, see the layout effect
          above) rather than centering under the whole bar, so it opens directly under its trigger. */}
      {modeOpen && (
        <div
          ref={modePopoverRef}
          data-overlay
          className="glass-strong absolute top-full z-20 mt-1.5 -translate-x-1/2 rounded-[14px] p-1.5"
          style={{ left: modeAnchorLeft ?? '50%' }}
        >
          <ModePicker
            mode={props.mode}
            onChange={(m) => {
              props.onSetMode(m)
              setModeOpen(false)
              modeRef.current?.querySelector('button')?.focus()
            }}
            customModes={props.customModes}
            size="sm"
          />
        </div>
      )}
    </div>
  )
})
