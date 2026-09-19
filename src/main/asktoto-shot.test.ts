import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRealRendererShotUrl } from './asktoto-shot'

const expectedUrl = 'file:///fixture/renderer/index.html'

describe('isRealRendererShotUrl', () => {
  it('rejects about:blank and empty', () => {
    expect(isRealRendererShotUrl('about:blank', expectedUrl)).toBe(false)
    expect(isRealRendererShotUrl('', expectedUrl)).toBe(false)
    expect(isRealRendererShotUrl(expectedUrl, '')).toBe(false)
  })

  it('accepts the exact expected renderer index.html URL', () => {
    expect(isRealRendererShotUrl(expectedUrl, expectedUrl)).toBe(true)
  })

  it('rejects unrelated URLs even if loaded', () => {
    expect(isRealRendererShotUrl('https://evil.example/', expectedUrl)).toBe(false)
  })

  it('does not treat a different origin or file path as the renderer merely because both end in index.html', () => {
    expect(isRealRendererShotUrl('https://evil.example/renderer/index.html', expectedUrl)).toBe(false)
    expect(isRealRendererShotUrl('file:///other-user/renderer/index.html', expectedUrl)).toBe(false)
    expect(isRealRendererShotUrl('file://other-host/fixture/renderer/index.html', expectedUrl)).toBe(false)
  })
})

describe('MQA-338 — renderer diagnostics never capture or export private renderer content', () => {
  const shot = readFileSync(join(__dirname, './asktoto-shot.ts'), 'utf8')
  const main = readFileSync(join(__dirname, './index.ts'), 'utf8')
  const rendererMain = readFileSync(join(__dirname, '../renderer/src/main.tsx'), 'utf8')
  const rendererStyles = readFileSync(join(__dirname, '../renderer/src/styles.css'), 'utf8')
  const app = readFileSync(join(__dirname, '../renderer/src/App.tsx'), 'utf8')

  it('keeps the shared URL matcher but removes raw screenshot, DOM, and caller-selected file output', () => {
    expect(shot).toContain('isRealRendererShotUrl')
    expect(shot).not.toMatch(/\bcapturePage\b/)
    expect(shot).not.toMatch(/\bexecuteJavaScript\b/)
    expect(shot).not.toMatch(/\bwriteFileSync\b/)
    expect(shot).not.toMatch(/\bbodyText\b/)
    expect(shot).not.toMatch(/\brootHTML\b/)
    expect(shot).not.toMatch(/\bshotPath\b/)
  })

  it('treats screenshot and demo switches as unpackaged-only, while retaining the bounded launch gate', () => {
    expect(main).not.toMatch(/process\.env\.ASKTOTO_SHOT/)
    expect(main).not.toMatch(/process\.env\.ASKTOTO_DEMO/)
    expect(main).not.toMatch(/ASKTOTO_SHOTBG/)
    expect(main).not.toMatch(/bindAskTotoShot/)
    expect(main).toMatch(/devEnv\('ASKTOTO_SHOT'\)/)
    expect(main).toMatch(/devEnv\('ASKTOTO_DEMO'\)/)
    expect(main).toMatch(/process\.env\.ASKTOTO_MAC_LAUNCH_GATE === '1'/)
  })

  it('does not leave a production renderer-side screenshot backdrop behind after the capture hook is removed', () => {
    expect(rendererMain).not.toMatch(/shotbg/)
    expect(rendererStyles).not.toMatch(/shot-bg/)
  })

  it('keeps the renderer demo seed unavailable in a production bundle even if a URL is manipulated', () => {
    expect(app).toMatch(/import\.meta\.env\.DEV/)
  })
})
