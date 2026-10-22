import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'

// The settings migration must be committed before any settings writer exists: a save landing between its last
// check and its rename would be overwritten. index.ts therefore awaits it first thing in whenReady.
describe('settings migration boot order', () => {
  const { text } = readModuleSource(__dirname, './index')
  const ready = text.slice(text.indexOf('.whenReady()'))
  const at = (needle: string): number => ready.search(new RegExp(needle))

  it('is awaited before the window, the IPC handlers and the deferred boot work', () => {
    const migrate = at(String.raw`await migrateSettingsFileOnBoot\(\)`)
    expect(migrate).toBeGreaterThan(-1)
    for (const later of [
      String.raw`registerIpc\(`,
      String.raw`createWindow`,
      String.raw`createBootWork\(`,
      String.raw`bootWork\.run\(`
    ]) {
      expect(at(later), later).toBeGreaterThan(migrate)
    }
  })

  it('is not queued as deferred boot work', () => {
    expect(text).not.toMatch(/bootWork\.run\(\s*'migrateSettingsFile'/)
  })
})
