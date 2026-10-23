import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'
import { NATIVE_WINDOW_MATRIX } from '../shared/window-layering'

/**
 * R038 / G47: the real `new BrowserWindow` creation sites must match the typed layering and capture matrix.
 * A new window, a dropped setContentProtection call or a changed always-on-top level fails here until the matrix
 * (src/shared/window-layering.ts) is updated on purpose. content-protection.contract.test.ts holds the toggle
 * behaviour; this file holds the policy table to the code.
 */
const MAIN = __dirname
const MODULES = ['index', 'intelligence', 'windows/permission-helper-window'] as const
const mod = (name: string): string => readModuleSource(MAIN, `./${name}`).text
const sources = new Map<string, string>(MODULES.map((m) => [m, mod(m)]))
const NEW_WINDOW = /(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*new BrowserWindow\(/g

function optionsBlock(source: string, from: number): string {
  const open = source.indexOf('{', from)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  return source.slice(open)
}

describe('native windows follow the layering and capture matrix (R038)', () => {
  it('the BrowserWindow creation sites are exactly the matrix rows', () => {
    const found: string[] = []
    for (const [file, source] of sources) {
      for (const m of source.matchAll(NEW_WINDOW)) found.push(`${file}: ${m[1]}`)
    }
    const declared = NATIVE_WINDOW_MATRIX.map((w) => `${w.site.module}: ${w.site.variable}`)
    expect(found.sort()).toEqual(declared.sort())
  })

  for (const row of NATIVE_WINDOW_MATRIX) {
    it(`${row.id}: protection, visibility and level match the matrix`, () => {
      const source = sources.get(row.site.module)
      expect(source, row.site.module).toBeDefined()
      const src = source as string
      const site = [...src.matchAll(NEW_WINDOW)].find((m) => m[1] === row.site.variable)
      expect(site).toBeDefined()
      const options = optionsBlock(src, (site?.index ?? 0) + (site?.[0].length ?? 0) - 1)
      const v = row.site.variable
      const protects = new RegExp(`\\b${v}\\??\\.setContentProtection\\(`).test(src)
      const level = [...src.matchAll(new RegExp(`\\b${v}\\??\\.setAlwaysOnTop\\(true, '(\\w[\\w-]*)'\\)`, 'g'))].map(
        (m) => m[1]
      )
      const hasAlwaysOnTopOption = /alwaysOnTop:\s*true/.test(options)

      if (row.composited) {
        expect(protects, 'setContentProtection is called on this window').toBe(true)
      } else {
        expect(options).toMatch(/show:\s*false/)
        expect(protects).toBe(false)
        expect(level).toEqual([])
        expect(hasAlwaysOnTopOption).toBe(false)
      }
      // The permission helper reads its level from the matrix itself; the others set a literal level here.
      if (row.id === 'permission-helper') expect(src).toMatch(/windowPolicy\('permission-helper'\)\.alwaysOnTop/)
      if (row.alwaysOnTop === null) expect(level).toEqual([])
    })
  }

  it('the overlay takes the screen-saver level and the one content-protection decision', () => {
    const index = sources.get('index') as string
    expect(index).toMatch(/w\.setAlwaysOnTop\(true, 'screen-saver'\)/)
    expect(index).toMatch(/win\.setAlwaysOnTop\(true, 'screen-saver'\)/)
    expect(index).toMatch(/win\.setContentProtection\(contentProtectionOn\(\)\)/)
  })

  it('the Intelligence dashboard and the permission helper take the same setting, not a literal', () => {
    expect(sources.get('intelligence')).toMatch(/intelWin\.setContentProtection\(intelCpOn\(\)\)/)
    expect(sources.get('windows/permission-helper-window')).toMatch(
      /win\.setContentProtection\(opts\.contentProtection\)/
    )
    const ipc = mod('ipc/permission-helper-ipc')
    expect(ipc).toMatch(/contentProtection: !devEnv\('ASKTOTO_DISABLE_CP'\) && getSettings\(\)\.contentProtection/)
  })
})
