import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

/** G55 contract: the artifact preview window has no bridge, no node, no scripts and cannot navigate or open windows. */
const src = readModuleSource(__dirname, './artifact-preview-window').text
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('artifact preview window (G55)', () => {
  it('is sandboxed, isolated, script-free and has no preload or node', () => {
    expect(code).toMatch(/sandbox:\s*true/)
    expect(code).toMatch(/contextIsolation:\s*true/)
    expect(code).toMatch(/nodeIntegration:\s*false/)
    expect(code).toMatch(/javascript:\s*false/)
    expect(code).toMatch(/webviewTag:\s*false/)
    expect(code).toMatch(/webSecurity:\s*true/)
    expect(code).not.toMatch(/preload/i)
    expect(code).not.toMatch(/allowRunningInsecureContent:\s*true/)
  })

  it('uses its own in-memory partition, never the app session', () => {
    expect(code).toMatch(/partition:\s*['"`]artifact-preview['"`]/)
    expect(code).not.toMatch(/persist:/)
  })

  it('denies every popup and every navigation, and loads only the supplied document', () => {
    expect(code).toMatch(/setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/)
    expect(code).toMatch(/'will-navigate'[\s\S]*preventDefault/)
    expect(code).toMatch(/'will-redirect'[\s\S]*preventDefault/)
    expect(code).toMatch(/data:text\/html/)
  })

  it('is content-protected and cannot be retitled by the page', () => {
    expect(code).toMatch(/setContentProtection\(true\)/)
    expect(code).toMatch(/page-title-updated/)
  })
})
