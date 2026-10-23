import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

/**
 * G43 contract: the annotation window never takes focus, never takes a click, never shows up in Métis's own
 * captures, and never carries the app's full preload.
 */
const src = readModuleSource(__dirname, './annotation-window').text
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('annotation window never steals focus (G43)', () => {
  it('is constructed hidden, unfocusable and frameless', () => {
    expect(code).toMatch(/show:\s*false/)
    expect(code).toMatch(/focusable:\s*false/)
    expect(code).toMatch(/frame:\s*false/)
    expect(code).toMatch(/skipTaskbar:\s*true/)
    expect(code).toMatch(/transparent:\s*true/)
  })

  it('is click-through and re-asserts that it cannot be focused', () => {
    expect(code).toMatch(/win\.setIgnoreMouseEvents\(true\)/)
    expect(code).toMatch(/win\.setFocusable\(false\)/)
  })

  it('only ever shows with showInactive and never calls show(), focus() or moveTop()', () => {
    expect(code).toMatch(/win\.showInactive\(\)/)
    expect(code).not.toMatch(/\.show\(\s*\)/)
    expect(code).not.toMatch(/\.focus\(/)
    expect(code).not.toMatch(/\.moveTop\(/)
    expect(code).not.toMatch(/app\.focus\(/)
    expect(code).not.toMatch(/webContents\.focus\(/)
  })

  it('is content-protected unconditionally (R038: Métis never captures its own marks)', () => {
    expect(code).toMatch(/win\.setContentProtection\(true\)/)
    expect(code).not.toMatch(/setContentProtection\(\s*opts\./)
  })

  it('is sandboxed with a dedicated minimal preload and blocks navigation and popups', () => {
    expect(code).toMatch(/sandbox:\s*true/)
    expect(code).toMatch(/contextIsolation:\s*true/)
    expect(code).toMatch(/nodeIntegration:\s*false/)
    expect(code).toMatch(/setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
    expect(code).toMatch(/will-navigate/)
  })
})

describe('annotation preload exposes only the mark feed (G43)', () => {
  const preload = readModuleSource(__dirname, '../../preload/annotation').text
  it('has one inbound channel and no invoke or send', () => {
    expect(preload).toContain("'annotation:marks'")
    expect(preload).not.toMatch(/ipcRenderer\.(invoke|send|sendSync)\(/)
  })
})
