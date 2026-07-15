import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
const answer = readFileSync(join(__dirname, 'components', 'Answer.tsx'), 'utf8')

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

  it('lets a typed chat question fall back to a text answer when Screen Recording is denied (chat is never blocked)', () => {
    // Tony 2026-07-15: with Screen Recording off, a typed chat question was swallowed by the permission
    // notice and the user could do nothing. The first typed question routes through askScreen with
    // allowTextFallback so a denied grant degrades to a text ask (with the notice still shown), instead of
    // wedging chat. The bare "look at my screen" (blank Enter) path deliberately does NOT set the flag.
    const submitStart = app.indexOf('const submit = useCallback')
    const submitEnd = app.indexOf('const factCheck = useCallback', submitStart)
    const submitBlock = app.slice(submitStart, submitEnd)
    expect(submitStart).toBeGreaterThan(-1)
    // The typed-question askScreen call carries allowTextFallback: true …
    expect(submitBlock).toMatch(/askScreen\(q, \{[^}]*allowTextFallback: true[^}]*\}\)/)
    // … while the blank "look at my screen" call must NOT (nothing to answer without the screen).
    expect(submitBlock).toMatch(/askScreen\('Help me with what is on my screen\.', \{\s*history: historyRef\.current,\s*record: 'Help me with what is on my screen\.'\s*\}\)/)
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
