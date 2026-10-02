import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isInsideResourceBase, realResourceBase } from './asr-model-path'

/**
 * Mirrors the asr-model:// handler's resolve → realpath → guard sequence in src/main/index.ts, so the
 * decision proven here is the same decision that serves (or 403s) a bundled model asset.
 * Returns 403 / 404 / the served path, exactly like the handler's exit branches.
 */
function serve(resBase: string, rel: string): '403' | '404' | string {
  const baseReal = realResourceBase(resBase)
  const abs = resolve(resBase, rel)
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    return '404'
  }
  return isInsideResourceBase(baseReal, real) ? real : '403'
}

describe('asr-model:// resource-base guard', () => {
  let root: string
  let realBase: string
  /** The same resources dir reached through a junction (win32) / symlink (posix) — an install path
   *  that does not spell itself the way realpath does. */
  let linkedBase: string

  beforeAll(() => {
    // realpathSync the tmp root itself: macOS hands out /var/... which is a symlink to /private/var, and
    // this fixture must isolate the junction under test, not the OS's own aliasing.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'asr-model-path-')))
    realBase = join(root, 'install', 'resources')
    mkdirSync(join(realBase, 'models', 'Xenova', 'whisper-base'), { recursive: true })
    writeFileSync(join(realBase, 'models', 'Xenova', 'whisper-base', 'config.json'), '{"model":"whisper"}')

    mkdirSync(join(root, 'outside'), { recursive: true })
    writeFileSync(join(root, 'outside', 'secret.txt'), 'not a model')

    symlinkSync(join(root, 'install'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    linkedBase = join(root, 'linked', 'resources')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('serves a bundled model asset when the install path is reached through a junction/symlink', () => {
    // Regression: the target went through realpathSync but the base did not, so relative() returned
    // `..\..\install\resources\...` and the guard 403'd EVERY asset — ASR died silently on any Windows
    // install sitting behind a junction.
    expect(serve(linkedBase, 'models/Xenova/whisper-base/config.json')).toBe(
      join(realBase, 'models', 'Xenova', 'whisper-base', 'config.json')
    )
  })

  it('serves the same asset when the resource root needs no resolving', () => {
    expect(serve(realBase, 'models/Xenova/whisper-base/config.json')).toBe(
      join(realBase, 'models', 'Xenova', 'whisper-base', 'config.json')
    )
  })

  it('still rejects ../ escapes out of the resource root', () => {
    for (const base of [realBase, linkedBase]) {
      expect(serve(base, 'models/../../../outside/secret.txt')).toBe('403')
      expect(serve(base, '../../outside/secret.txt')).toBe('403')
    }
  })

  it('still rejects a symlink inside the resource root that points outside it', () => {
    // Junction/dir link, not a file symlink: Windows refuses file symlinks (EPERM) without elevation or
    // Developer Mode, and the escape being tested is the same one either way.
    const escape = join(realBase, 'models', 'escape')
    symlinkSync(join(root, 'outside'), escape, process.platform === 'win32' ? 'junction' : 'dir')
    for (const base of [realBase, linkedBase]) {
      expect(serve(base, 'models/escape/secret.txt')).toBe('403')
    }
    rmSync(escape, { recursive: true, force: true })
  })

  it('rejects a sibling directory whose name merely starts with the resource root', () => {
    mkdirSync(join(root, 'install', 'resources-extra'), { recursive: true })
    writeFileSync(join(root, 'install', 'resources-extra', 'app.asar'), 'source bytes')
    for (const base of [realBase, linkedBase]) {
      expect(serve(base, '../resources-extra/app.asar')).toBe('403')
    }
  })

  it('404s a path that does not exist instead of resolving it', () => {
    expect(serve(linkedBase, 'models/Xenova/whisper-base/nope.json')).toBe('404')
  })

  it('falls back to the raw base when the resource root itself cannot be resolved', () => {
    const missing = join(root, 'no-such-install', 'resources')
    expect(realResourceBase(missing)).toBe(missing)
  })
})
