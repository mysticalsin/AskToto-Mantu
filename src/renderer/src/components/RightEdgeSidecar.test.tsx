import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RightEdgeSidecar, SidecarChat } from './RightEdgeSidecar'

const sidecar = readFileSync(join(__dirname, './RightEdgeSidecar.tsx'), 'utf8')
const answer = readFileSync(join(__dirname, './Answer.tsx'), 'utf8')
const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const e2eSmoke = readFileSync(join(__dirname, '../../../../scripts/e2e-smoke.mjs'), 'utf8')

function findElement(node: ReactNode, type: string): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) return null
  if (node.type === type) return node as ReactElement<Record<string, unknown>>
  for (const child of Children.toArray(node.props.children)) {
    const found = findElement(child, type)
    if (found) return found
  }
  return null
}

describe('right-edge dock', () => {
  afterEach(() => vi.useRealTimers())
  it('uses the supplied controlled conversation route and sends an uncomposed Enter exactly once', () => {
    const changes: string[] = []
    let submissions = 0
    const chat = SidecarChat({
      value: 'Draft a concise update',
      onChange: (value) => changes.push(value),
      onSubmit: () => {
        submissions += 1
      }
    })

    const markup = renderToStaticMarkup(chat)
    expect(markup).toContain('aria-label="Ask Métis"')
    expect(markup).toContain('aria-label="Ask Métis anything"')
    expect(markup).toContain('Draft a concise update')

    const input = findElement(chat, 'input')
    const form = findElement(chat, 'form')
    expect(input).not.toBeNull()
    expect(form).not.toBeNull()

    ;(input!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'Turn this into next steps' }
    })
    let prevented = false
    ;(input!.props.onKeyDown as (event: {
      key: string
      shiftKey: boolean
      nativeEvent: { isComposing: boolean }
      preventDefault: () => void
    }) => void)({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {
        prevented = true
      }
    })

    expect(changes).toEqual(['Turn this into next steps'])
    expect(prevented).toBe(true)
    expect(submissions).toBe(1)

    ;(input!.props.onKeyDown as (event: {
      key: string
      shiftKey: boolean
      nativeEvent: { isComposing: boolean }
      preventDefault: () => void
    }) => void)({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: true },
      preventDefault: () => {
        throw new Error('IME Enter must not submit or prevent composition')
      }
    })
    expect(submissions).toBe(1)

    ;(form!.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: () => undefined
    })
    expect(submissions).toBe(2)
  })

  it('renders the supplied answer inside an accessible vertical dock', () => {
    const markup = renderToStaticMarkup(
      <RightEdgeSidecar
        open
        onOpen={() => undefined}
        onClose={() => undefined}
        value="What changed?"
        onChange={() => undefined}
        onSubmit={() => undefined}
        body={<p>Current answer</p>}
        onToggleListen={() => undefined}
        onCapture={() => undefined}
        onOpenIntelligence={async () => ({ ok: true })}
        onSpotlightRef={() => undefined}
        spotlightReady
        onHistory={() => undefined}
        onSettings={() => undefined}
        liveNotice="Microphone needs input. Check your microphone connection."
      />
    )

    expect(markup).toContain('aria-label="Métis"')
    expect(markup).toContain('aria-label="Métis response"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('Current answer')
    expect(markup).toContain('Start listening')
    expect(markup).toContain('Capture screen')
    expect(markup).toContain('Mantu Intelligence')
    expect(markup).toContain('Spotlight Ref')
    expect(markup).toContain('Microphone needs input. Check your microphone connection.')
    expect(markup).toContain('data-right-edge-status="Ready"')
    expect(markup).toContain('data-right-edge-action-rail="true"')
    expect(markup).toContain('aria-label="Start listening"')
    expect(markup).toContain('aria-label="Capture screen"')
    expect(markup).toContain('aria-label="Mantu Intelligence"')
    expect(markup).toContain('aria-label="Spotlight Ref"')
    expect(markup).toContain('aria-label="Open settings"')
    expect(markup).toContain('aria-label="Open History"')
    expect(markup).toContain('History')
  })

  it('keeps live meeting pause and transcript controls reachable without widening the action rail', () => {
    vi.useFakeTimers()
    vi.setSystemTime(120_000)
    const live = renderToStaticMarkup(
      <RightEdgeSidecar
        open
        onOpen={() => undefined}
        onClose={() => undefined}
        listening
        paused={false}
        startedAt={55_000}
        onToggleListen={() => undefined}
        onTogglePause={() => undefined}
        onTranscript={() => undefined}
        transcriptShown={false}
        onHistory={() => undefined}
      />
    )
    expect(live).toContain('aria-label="Meeting controls"')
    expect(live).toContain('aria-label="Meeting duration"')
    expect(live).toContain('>1:05</span>')
    expect(live).toContain('data-right-edge-status="Listening"')
    expect(live).toContain('aria-label="Pause meeting"')
    expect(live).toContain('aria-label="Stop meeting"')
    expect(live).toContain('aria-label="Show transcript"')
    expect(live).not.toContain('aria-label="Open History"')

    const paused = renderToStaticMarkup(
      <RightEdgeSidecar
        open
        onOpen={() => undefined}
        onClose={() => undefined}
        listening
        paused
        startedAt={55_000}
        onToggleListen={() => undefined}
        onTogglePause={() => undefined}
        onTranscript={() => undefined}
        transcriptShown
        onHistory={() => undefined}
      />
    )
    expect(paused).toContain('data-right-edge-status="Paused"')
    expect(paused).toContain('aria-label="Resume meeting"')
    expect(paused).toContain('aria-label="Hide transcript"')
    expect(paused).toContain('aria-pressed="true"')
    expect(paused).not.toContain('aria-label="Pause meeting"')
  })

  it('keeps meeting time stable across a parked dock and starts the next meeting at zero', () => {
    vi.useFakeTimers()
    const renderClock = (startedAt: number, paused: boolean, pausedMs: number, pausedAt: number | null): string =>
      renderToStaticMarkup(
        <RightEdgeSidecar
          open
          onOpen={() => undefined}
          onClose={() => undefined}
          listening
          paused={paused}
          startedAt={startedAt}
          pausedMs={pausedMs}
          pausedAt={pausedAt}
          onToggleListen={() => undefined}
        />
      )

    vi.setSystemTime(100_000)
    expect(renderClock(1_000, true, 0, 85_000)).toContain('>1:24</span>')
    // This is a fresh render after the sidecar was parked, not an update to its prior clock instance.
    vi.setSystemTime(130_000)
    expect(renderClock(1_000, true, 0, 85_000)).toContain('>1:24</span>')
    vi.setSystemTime(150_000)
    expect(renderClock(1_000, false, 55_000, null)).toContain('>1:34</span>')
    vi.setSystemTime(175_000)
    expect(renderClock(170_000, false, 0, null)).toContain('>0:05</span>')
  })

  it('keeps microphone failure and degraded-capture notices accurate in the compact dock', () => {
    const visibleNotice = (liveNotice: string): string => {
      const markup = renderToStaticMarkup(
        <RightEdgeSidecar open onOpen={() => undefined} onClose={() => undefined} liveNotice={liveNotice} />
      )
      expect(markup).toContain(`aria-label="${liveNotice.replaceAll("'", '&#x27;')}"`)
      return markup.match(/class="right-edge-sidecar__status-notice"[^>]*>([^<]*)<\/p>/)?.[1] ?? ''
    }

    expect(visibleNotice('Mic silent · check input')).toBe('Mic silent · check input')
    expect(visibleNotice('Microphone input stopped (device disconnected or sleep); reconnecting automatically…')).toBe('Mic lost · reconnecting')
    expect(visibleNotice('Could not start the microphone. Check Windows microphone access.')).toBe('Mic unavailable · check access')
    expect(visibleNotice("Couldn't start the microphone. Check Microphone access in System Settings.")).toBe('Mic unavailable · check access')
    expect(visibleNotice('Microphone unavailable. Listening to system audio only.')).toBe('Mic unavailable · system audio only')
    expect(visibleNotice('System audio needs Screen Recording permission. Listening to microphone only.')).toBe('System audio needs Screen Recording permission. Listening to microphone only.')
  })

  it('does not expose an inert dismissal control while the dock must remain open', () => {
    const markup = renderToStaticMarkup(
      <RightEdgeSidecar
        open
        canClose={false}
        onOpen={() => undefined}
        onClose={() => undefined}
        value="Draft"
        onChange={() => undefined}
        onSubmit={() => undefined}
      />
    )

    expect(markup).not.toContain('aria-label="Close Métis"')
    expect(markup).toContain('tabindex="-1"')
    expect(markup).toContain('aria-hidden="true"')
  })

  it('keeps Spotlight Ref discoverable without claiming Dust is connected', () => {
    const markup = renderToStaticMarkup(
      <RightEdgeSidecar
        open
        onOpen={() => undefined}
        onClose={() => undefined}
        onSpotlightRef={() => undefined}
        spotlightReady={false}
      />
    )

    expect(markup).toContain('Spotlight Ref')
    expect(markup).toContain('Connect Dust')
  })

  it('receives the current app-owned paths rather than a duplicate chat or control route', () => {
    const rightEdgeCalls = app.match(/<RightEdgeSidecar[\s\S]*?\/>/g) ?? []
    expect(rightEdgeCalls).toHaveLength(2)
    for (const call of rightEdgeCalls) {
      expect(call).toContain('value={input}')
      expect(call).toContain('onChange={setInput}')
      expect(call).toContain('onSubmit={submit}')
      expect(call).toContain('onStop={onStop}')
      expect(call).toContain('onClose={closeRightEdgeDock}')
      expect(call).toContain('canClose={overlayIdle && !autoHideForced}')
      expect(call).toContain('body={barBody}')
      expect(call).toContain('onToggleListen={toggleListen}')
      expect(call).toContain('paused={listen.paused}')
      expect(call).toContain('startedAt={meetingStartRef.current}')
      expect(call).toContain('pausedMs={meetingPauseRef.current.pausedMs}')
      expect(call).toContain('pausedAt={meetingPauseRef.current.pausedAt}')
      expect(call).toContain('onTogglePause={onTogglePause}')
      expect(call).toContain('onTranscript={toggleTranscript}')
      expect(call).toContain('transcriptShown={transcriptShown}')
      expect(call).toContain('onCapture={capture}')
      expect(call).toContain('onOpenIntelligence={openIntelligenceDashboard}')
      expect(call).toContain('onSpotlightRef={spotlightRef}')
      expect(call).toContain('spotlightReady={spotlightRefReady}')
      expect(call).toContain('onHistory={onBarHistory}')
      expect(call).toContain('onSettings={onBarSettings}')
      expect(call).toContain('liveNotice={listen.error}')
    }
    expect(app.match(/meetingPauseRef\.current = freshMeetingPauseClock\(\)/g)).toHaveLength(2)
    expect(app).toContain('meetingPauseRef.current = setMeetingPaused(meetingPauseRef.current')
    expect(app).toContain('const openIntelligenceDashboard = useCallback')
    expect(app).toContain('window.toto.brainOpenDashboard()')
    expect(app).toContain('minimizeForIntelligence()')
  })

  it('keeps a narrow accessible rail and a single fixed-composer body scroller without mounting Bar', () => {
    expect(sidecar).toMatch(/RIGHT_EDGE_TAB_WIDTH = 52/)
    expect(sidecar).toMatch(/RIGHT_EDGE_DRAWER_WIDTH = 360/)
    expect(sidecar).toMatch(/aria-label="Open Métis"/)
    expect(sidecar).toMatch(/aria-expanded=\{open\}/)
    expect(sidecar).toMatch(/role="complementary"/)
    expect(sidecar).toMatch(/aria-label="Métis"/)
    expect(sidecar).not.toContain('Métis command')
    expect(sidecar).not.toContain('useCommandMic')
    expect(sidecar).not.toContain('Test microphone access')
    expect(sidecar).toContain('event.nativeEvent.isComposing')
    expect(sidecar).toContain("'right-edge-sidecar__action--icon'")
    expect(sidecar).toMatch(/onKeyDown/)
    expect(sidecar).toMatch(/event\.key === 'Escape'/)
    expect(sidecar).toMatch(/const close = \(\): void => \{[\s\S]*?cancelPendingCommand\(\)[\s\S]*?onClose\(\)/)
    expect(css).toMatch(/\.right-edge-sidecar__body \{[\s\S]*?overflow-y: auto/)
    expect(css).toMatch(/\.right-edge-sidecar__body \{[\s\S]*?overflow-x: hidden/)
    expect(css).toMatch(/\.right-edge-sidecar__drawer-scroll \{[\s\S]*?overflow: hidden/)
    expect(css).toMatch(/\.right-edge-sidecar__drawer \{[\s\S]*?z-index: 2/)
    expect(css).toMatch(/\.right-edge-sidecar__rail \{[\s\S]*?width: 12px/)
    expect(css).toMatch(/prefers-reduced-motion/)
    expect(app).toContain('const rightEdgeDockVisible = rightEdgePresentation && !isPanelBody')
    // The drawer is absolutely positioned, so its host must own the native sidecar height. Otherwise
    // the root hugs a sibling setup CTA and clips the dock to a thin strip at the top of the window.
    expect(app).toMatch(/rightEdgeDockVisible \? 'h-full min-h-0' : ''/)
    expect(app).toMatch(/overlayPeeked \? 'p-0' : rightEdgeDockVisible \? 'p-0' : overlayShowsSettingsSheet/)
    expect(app).toContain('settings && !rightEdgeDockVisible && !settings.providerReady')
    expect(app).toMatch(/rightEdgeDockVisible \? 'h-full' : ''/)
    expect(app).toMatch(/rightEdgeDockVisible \? \(\s*<RightEdgeSidecar[\s\S]*?\) : rightEdgePresentation \? null : <Bar/)
    expect(sidecar).not.toMatch(/window\.toto\.resize/)
    expect(sidecar).toContain('tabIndex={open ? -1 : 0}')
    expect(sidecar).toContain('aria-hidden={open || undefined}')
    expect(sidecar).toContain('requestAnimationFrame(() => composerRef.current?.focus())')
    expect(sidecar).toContain('data-right-edge-status={')
    expect(sidecar).toContain('right-edge-sidecar__header-back')
    expect(sidecar).toContain('data-right-edge-action-rail="true"')
    expect(sidecar).toContain('aria-label={label}')
    expect(sidecar).toContain('liveNotice?: string | null')
    expect(sidecar).toContain('{liveNotice ?')
    expect(sidecar).toContain('aria-label="Open History"')
    expect(sidecar.indexOf('right-edge-sidecar__body')).toBeLessThan(sidecar.indexOf('right-edge-sidecar__actions'))
    expect(sidecar.indexOf('right-edge-sidecar__actions')).toBeLessThan(sidecar.indexOf('right-edge-sidecar__composer'))
    expect(css).toMatch(/\.right-edge-sidecar__drawer \{[\s\S]*?border-radius:\s*16px/)
    expect(css).toMatch(/\.right-edge-sidecar__action-rail \{[\s\S]*?display:\s*flex/)
    expect(css).toMatch(/\.right-edge-sidecar__history \{[\s\S]*?margin-left:\s*auto/)
    expect(css).toMatch(/\.right-edge-sidecar__status-notice \{[\s\S]*?text-overflow:\s*ellipsis/)
    expect(sidecar).toContain('right-edge-sidecar__action--icon')
    expect(sidecar).toContain('className="right-edge-sidecar__chat-input no-drag"')
    expect(sidecar).not.toContain('right-edge-sidecar__chat-input no-drag focus-ring')
    expect(sidecar).toContain('className="right-edge-sidecar__status-notice"')
    expect(sidecar).toContain("return 'Mic silent · check input'")
    expect(sidecar).toContain("return 'Transcription repair'")
    expect(css).not.toMatch(/@keyframes right-edge-sidecar-zone-in/)
    const rightEdgeSpring = css.slice(css.indexOf('@keyframes overlay-spring-in-right'), css.indexOf('@keyframes overlay-spring-out-right'))
    expect(rightEdgeSpring).toContain('transform: translateX(10px);')
    expect(rightEdgeSpring).not.toContain('scale(')
    const onboardingEdgePreviewSpring = css.slice(css.indexOf('@keyframes onboard-edge-preview-in'), css.indexOf('.overlay-spring {'))
    expect(onboardingEdgePreviewSpring).toContain('transform: translateX(12px);')
    expect(onboardingEdgePreviewSpring).not.toContain('scale(')
    expect(css).toMatch(/\.right-edge-sidecar__answer \{[\s\S]*?width: 100%/)
    expect(css).toMatch(/\.answer--sidecar \{[\s\S]*?min-width: 0/)
    expect(css).toMatch(/\.answer--sidecar \.md pre \{[\s\S]*?overflow-x: auto/)
    expect(css).toMatch(/\.answer--sidecar \.md table \{[\s\S]*?table-layout: fixed/)
    expect(css).toMatch(/\.answer--sidecar \.md :where\(th, td\) \{[\s\S]*?overflow-wrap: anywhere/)
    expect(answer).toContain("variant?: 'default' | 'sidecar'")
    expect(answer).toContain("variant === 'sidecar'")
    expect(answer).toContain('answer__footer-row')
    expect(app).toContain("variant={rightEdgePresentation ? 'sidecar' : 'default'}")
    expect(app).toContain('const showWideMeetingChrome = showListeningChrome && !rightEdgeDockVisible')
    expect(app).toContain('const rightEdgeDismissalLockRef = useRef(false)')
    expect(app).toContain('rightEdgeDismissalLockRef.current = true')
    expect(app).toContain('if (rightEdgePresentation && rightEdgeDismissalLockRef.current && !d.restoredFromParkedRail) return')
    expect(app).toContain('if (rightEdgePresentation && d.restoredFromParkedRail) rightEdgeDismissalLockRef.current = false')
    expect(app).toMatch(/const onOverlayPointerLeave = useCallback\(\(\) => \{[\s\S]*?rightEdgeDismissalLockRef\.current = false/)
    expect(app).toMatch(/else if \(a === 'metis-command'\) \{[\s\S]*?rightEdgeDismissalLockRef\.current = false/)
    expect(app).toMatch(/\{showWideMeetingChrome && \(\s*<QuickActions/)
    expect(app).toMatch(/\{showWideMeetingChrome && listen\.error/)
    expect(e2eSmoke).toContain('verifyRightEdgeReferenceLayout')
    expect(e2eSmoke).toContain('right-edge action rail did not keep every action on one compact row')
    expect(e2eSmoke).toContain('verifyLongSidecarResponse')
    expect(e2eSmoke).toContain('long sidecar answer wraps prose and tables while the composer remains anchored')
  })

  it('renders each action only through an explicit real handler and keeps opaque proposals cancellable', () => {
    expect(sidecar).toMatch(/\{listening && onToggleListen \? \(/)
    expect(sidecar).toMatch(/\{!listening && onToggleListen \? \(/)
    expect(sidecar).toMatch(/\{onTogglePause \? \(/)
    expect(sidecar).toMatch(/\{listening && onTranscript \? \(/)
    expect(sidecar).toMatch(/\{onCapture \? \(/)
    expect(sidecar).toMatch(/\{onOpenIntelligence \? \(/)
    expect(sidecar).toMatch(/\{onSpotlightRef \? \(/)
    expect(sidecar).toMatch(/\{onSettings \? \(/)
    expect(sidecar).toContain('cancelMetisCommand')
    expect(sidecar).toContain('It cannot be approved here.')
    expect(sidecar).not.toContain('Confirm pending action')
  })

  it('summons a parked right-edge dock immediately without switching to top-center Bar chrome', () => {
    const commandHotkeyAt = app.indexOf("else if (a === 'metis-command')")
    expect(commandHotkeyAt).toBeGreaterThan(-1)
    const commandHotkey = app.slice(commandHotkeyAt, commandHotkeyAt + 240)

    expect(commandHotkey).toContain("dispatchAutoHide({ type: 'reveal-now' })")
    expect(commandHotkey).toContain('setCollapsed(false)')
    expect(app).toContain("overlaySpringClassName(overlaySpring, rightEdgePresentation ? 'right' : 'top')")
    expect(css).toMatch(/\.overlay-spring--edge-right/)
    expect(css).toMatch(/\.overlay-spring--in \.right-edge-sidecar__drawer/)
  })

  it('reconciles a native cursor-watch reveal with the parked right-edge renderer', () => {
    const cursorHoverAt = app.indexOf('window.toto.onOverlayCursorHover?.((d) => {')
    expect(cursorHoverAt).toBeGreaterThan(-1)
    const cursorHover = app.slice(cursorHoverAt, cursorHoverAt + 960)

    expect(cursorHover).toContain('if (d.hovering)')
    expect(cursorHover).toContain('if (rightEdgePresentation && rightEdgeDismissalLockRef.current && !d.restoredFromParkedRail) return')
    expect(cursorHover).toContain('if (rightEdgePresentation && d.restoredFromParkedRail) rightEdgeDismissalLockRef.current = false')
    expect(cursorHover).toContain('setRightEdgeDockDismissed(false)')
    expect(cursorHover).toContain("dispatchAutoHide({ type: 'reveal-now' })")
  })

  it('guards a dirty recap before it launches and collapses for the standalone Intelligence dashboard', () => {
    expect(app).toMatch(/const openIntelligenceDashboard = useCallback\(async[\s\S]*?guardReviewNav\(\(\) => \{[\s\S]*?approved = true/)
    expect(app).toContain("Save or discard the recap before opening Mantu Intelligence.")
    expect(app).toMatch(/window\.toto\.brainOpenDashboard\(\)[\s\S]*?minimizeForIntelligence\(\)/)
    expect(app).toMatch(/const closeRightEdgeDock = useCallback\(\(\): void => \{[\s\S]*?forceParkAfterHideRef\.current = true[\s\S]*?dispatchAutoHide\(\{ type: 'collapse-now' \}\)/)
    expect(app).toMatch(/const minimizeForIntelligence = useCallback\(\(\): void => \{[\s\S]*?if \(rightEdgePresentation\) closeRightEdgeDock\(\)/)
    expect(app).toContain('const [rightEdgeDockDismissed, setRightEdgeDockDismissed] = useState(false)')
    expect(app).toMatch(/const overlaySurfaceRevealed = rightEdgePresentation && rightEdgeDockDismissed \? false : overlayRevealed/)
    expect(app).toMatch(/const edgeDockParked = rightEdgePresentation && rightEdgeDockDismissed/)
    expect(app).toMatch(/const overlayPeeked = \(edgeDockParked && overlaySpring === 'rest'\) \|\| overlayShowPeek/)
    expect(app).toMatch(/const revealOverlay = useCallback\(\(\) => \{[\s\S]*?rightEdgeDismissalLockRef\.current = false[\s\S]*?setRightEdgeDockDismissed\(false\)/)
  })

  it('does not hand off to Intelligence while a screen capture is still active', () => {
    expect(sidecar).toMatch(/if \(!onOpenIntelligence \|\| capturing \|\| intelligence\.status === 'opening'\) return/)
    expect(sidecar).toMatch(/disabled=\{intelligence\.status === 'opening' \|\| capturing\}/)
    expect(app).toMatch(/const openIntelligenceDashboard = useCallback\(async[\s\S]*?if \(capturing \|\| capturingRef\.current\) return \{ ok: false, error: 'Wait for screen capture to finish before opening Mantu Intelligence\.' \}/)
  })
})
