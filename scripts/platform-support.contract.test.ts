import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIN_MACOS } from '../src/shared/platform-support'

/** D-26: the minimum OS the installer declares is the one the runtime gate enforces — one typed source. */
const root = join(__dirname, '..')
const read = (name: string): string => readFileSync(join(root, name), 'utf8').replace(/\r\n/g, '\n')

function macSection(yml: string): string[] {
  const lines = yml.split('\n')
  const start = lines.findIndex((line) => line === 'mac:')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, i) => i > start && /^\S/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

describe('minimum OS declaration (D-26)', () => {
  it('electron-builder mac.minimumSystemVersion equals the typed MIN_MACOS constant', () => {
    const line = macSection(read('electron-builder.yml')).find((l) => /^ {2}minimumSystemVersion:/.test(l))
    expect(line, 'mac.minimumSystemVersion').toBeDefined()
    expect(
      line
        ?.split(':')[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, '')
    ).toBe(MIN_MACOS.label)
  })

  it('the Windows overlay does not weaken the macOS declaration', () => {
    expect(read('electron-builder.win.yml')).not.toMatch(/minimumSystemVersion/)
  })
})
