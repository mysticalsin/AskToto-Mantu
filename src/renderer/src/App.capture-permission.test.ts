import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
const answer = readFileSync(join(__dirname, 'components', 'Answer.tsx'), 'utf8')

describe('screen-capture permission recovery', () => {
  it('does not turn a denied Screen Recording request into a text-only provider ask', () => {
    const catchStart = app.indexOf('const needsScreenPermission = isScreenCapturePermissionError(raw)')
    const catchEnd = app.indexOf('} finally {', catchStart)
    const catchBlock = app.slice(catchStart, catchEnd)

    expect(catchStart).toBeGreaterThan(-1)
    expect(catchEnd).toBeGreaterThan(catchStart)
    expect(catchBlock.indexOf('if (needsScreenPermission) return null')).toBeGreaterThan(-1)
    expect(catchBlock.indexOf('if (needsScreenPermission) return null')).toBeLessThan(catchBlock.indexOf("ask.run({ mode: 'answer'"))
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
