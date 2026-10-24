import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

const here = __dirname
const source = (specifier: string): string => readModuleSource(here, specifier).text

describe('G86 update seams', () => {
  it('index.ts never relaunches into an installer itself', () => {
    expect(source('../index')).not.toContain('quitAndInstall')
  })

  it('only updater.ts calls quitAndInstall, behind requestInstall', () => {
    const updater = source('../updater')
    expect(updater.match(/quitAndInstall\(/g)?.length).toBe(1)
    const body = updater.slice(updater.indexOf('export async function requestInstall'))
    expect(body.indexOf('busyReasons()')).toBeGreaterThan(-1)
    expect(body.indexOf('busyReasons()')).toBeLessThan(body.indexOf('quitAndInstall('))
    expect(body.indexOf('writeInstallReceipt(')).toBeLessThan(body.indexOf('quitAndInstall('))
  })

  it('update channels live in the shared update contract, not in ipc.ts', () => {
    const ipc = source('../../shared/ipc')
    const keys = ipc.match(/'update:[a-z:]+'/g) ?? []
    expect(keys.sort()).toEqual(
      [
        "'update:check'",
        "'update:download'",
        "'update:downloaded'",
        "'update:error'",
        "'update:install'",
        "'update:progress'"
      ].sort()
    )
  })

  it('no update module raises a native notification outside the quiet gate', () => {
    for (const specifier of [
      '../updater',
      './update-composition',
      './helper-reverify',
      './update-lifecycle',
      '../ipc/update-ipc'
    ]) {
      expect(source(specifier), specifier).not.toMatch(/new Notification\(/)
    }
    expect(source('../updater')).toContain('showQuietNotification')
  })

  it('the preload bridge is composed in feature-apis, not inlined in index.ts', () => {
    expect(source('../../preload/feature-apis')).toContain('createUpdateLifecyclePreloadApi')
    expect(source('../../preload/index')).not.toContain('UPDATE_LIFECYCLE_IPC')
  })
})
