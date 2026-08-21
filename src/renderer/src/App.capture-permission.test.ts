import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Normalize CRLF → LF: on a Windows checkout these files have \r\n endings, and an anchor whose
// newline sits mid-string (e.g. "suggest.run({\n      mode: 'answer'") would never match "…({\r\n…".
const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')
const answer = readFileSync(join(__dirname, 'components', 'Answer.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('screen-capture permission recovery', () => {
  it('does not SILENTLY turn a bare (no-text) denied Screen Recording request into a text-only ask', () => {
    // A blank "look at my screen" ask has no allowTextFallback, so a denied grant still stops before the
    // text ask.run below — there is nothing to answer without the screen, and it must not become an
    // unannounced provider request. The guard is now conditional on allowTextFallback (see the typed-chat
    // test below), so it must appear BEFORE the fallback ask.run and gate on !opts?.allowTextFallback.
    const catchStart = app.indexOf('const needsScreenPermission = isScreenCapturePermissionError(raw)')
    const catchEnd = app.indexOf('} finally {', catchStart)
    const catchBlock = app.slice(catchStart, catchEnd)

    expect(catchStart).toBeGreaterThan(-1)
    expect(catchEnd).toBeGreaterThan(catchStart)
    const guard = 'if (needsScreenPermission && !opts?.allowTextFallback) return null'
    expect(catchBlock.indexOf(guard)).toBeGreaterThan(-1)
    expect(catchBlock.indexOf(guard)).toBeLessThan(catchBlock.indexOf("ask.run({ mode: 'answer'"))
  })

  it('MQA-236: a TYPED question never routes through askScreen — screen intent is always explicit', () => {
    // Supersedes the 2026-07-15 allowTextFallback pin: the first typed question of a session used to run
    // askScreen(q) — a silent screenshot the user never asked for, and under the shipped Cloudflare
    // default (vision: false) it routed the ask to the slow on-device vision model instead of the fast
    // Worker. Typed questions now ALWAYS go out as a plain mode:'answer' ask; the only askScreen call
    // left in submit is the blank-Enter "look at my screen", which is a deliberate screen gesture. The
    // permission-denied class the old pin protected (typed chat swallowed by the screen notice) is now
    // structurally impossible — a typed ask never touches the capture path at all.
    const submitStart = app.indexOf('const submit = useCallback')
    const submitEnd = app.indexOf('const factCheck = useCallback', submitStart)
    const submitBlock = app.slice(submitStart, submitEnd)
    expect(submitStart).toBeGreaterThan(-1)
    // No typed-question askScreen call survives …
    expect(submitBlock).not.toMatch(/askScreen\(q/)
    // … the blank "look at my screen" gesture is the ONLY askScreen call in submit …
    expect(submitBlock.match(/askScreen\(/g)?.length).toBe(1)
    expect(submitBlock).toMatch(/askScreen\('Help me with what is on my screen\.'/)
    // … and the typed branch answers plainly.
    expect(submitBlock).toMatch(/ask\.run\(\{ mode: 'answer', prompt: q, history: historyRef\.current \}\)/)
  })

  it('always announces the degrade — a text fallback still sets the capture notice (not silent)', () => {
    // The catch block sets captureError before the guard, so a text fallback answer renders WITH the amber
    // "Screen Recording is off" notice above it. That keeps the substitution announced, satisfying the
    // original privacy intent while unblocking chat.
    const catchStart = app.indexOf('const needsScreenPermission = isScreenCapturePermissionError(raw)')
    const catchBlock = app.slice(catchStart, app.indexOf('} finally {', catchStart))
    expect(catchBlock.indexOf('setCaptureError(')).toBeGreaterThan(-1)
    expect(catchBlock.indexOf('setCaptureError(')).toBeLessThan(catchBlock.indexOf('if (needsScreenPermission &&'))
  })

  it('makes the capture notice dismissible so a declined permission never wedges the UI', () => {
    expect(answer).toMatch(/onDismissNotice\?\: \(\) => void/)
    expect(answer).toMatch(/aria-label="Dismiss"/)
    expect(app).toMatch(/onDismissNotice=\{\(\) => setCaptureError\(null\)\}/)
  })

  it('uses the shared permission classifier so Windows denial cannot become a context-only ask', () => {
    expect(app).toMatch(/import \{ isScreenCapturePermissionError \} from '@shared\/screen-capture'/)
  })

  it('does not turn a Windows screen-permission failure during Assist into a transcript-only suggestion', () => {
    const assistStart = app.indexOf('const assist = useCallback')
    const assistEnd = app.indexOf('const submit = useCallback', assistStart)
    const assistBlock = app.slice(assistStart, assistEnd)
    const permissionIndex = assistBlock.indexOf('const needsScreenPermission = isScreenCapturePermissionError(raw)')
    const fallbackIndex = assistBlock.lastIndexOf("suggest.run({\n      mode: 'answer'")

    expect(permissionIndex).toBeGreaterThan(-1)
    expect(assistBlock.indexOf('if (needsScreenPermission) return', permissionIndex)).toBeGreaterThan(permissionIndex)
    expect(assistBlock.indexOf('if (needsScreenPermission) return', permissionIndex)).toBeLessThan(fallbackIndex)
  })

  it('offers a direct Screen Recording settings action in the screen-failure banner', () => {
    expect(answer).toMatch(/isScreenCapturePermissionError\(captureNotice\)/)
    expect(answer).toMatch(/window\.toto\.openPermissionSettings\('screenRecording'\)/)
    expect(answer).toMatch(/Open Screen Recording settings/)
  })
})

describe('MQA-236 (part 2) — nothing captures a frame without a screen gesture', () => {
  const bar = readFileSync(join(__dirname, 'components', 'Bar.tsx'), 'utf8').replace(/
/g, '
')
  const mainSrc = readFileSync(join(__dirname, '..', '..', 'main', 'index.ts'), 'utf8').replace(/
/g, '
')

  it('focusing the ask input never pre-warms capture (prewarmCapture takes a REAL frame)', () => {
    expect(bar).not.toMatch(/onFocus=\{[^}]*prewarmCapture/)
  })

  it('the warm rides hovering the Capture tool — the one place intent is signalled before the click', () => {
    expect(bar).toMatch(/onMouseEnter=\{\(\) => \{ if \(props\.canPrewarm\) void window\.toto\.prewarmCapture\(\) \}\}/)
  })

  it('signing in never captures a frame either', () => {
    // The old post-sign-in prewarmCapture() call took a screenshot the instant auth completed.
    const signin = mainSrc.slice(mainSrc.indexOf('MQA-236: no prewarmCapture() here anymore') - 200, mainSrc.indexOf('MQA-236: no prewarmCapture() here anymore') + 400)
    expect(signin).toBeTruthy()
    expect(signin).not.toMatch(/^\s*prewarmCapture\(\)/m)
  })
})
