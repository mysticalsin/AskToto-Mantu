import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * M2-0420 — Electron titles a new BrowserWindow with the package name ("asktoto") until the renderer's
 * <title> loads. That flashes in the Windows taskbar and made the packaged launch gate judge a healthy
 * slow start as a failure. Every window therefore names itself in its constructor options.
 */

const MAIN_DIR = __dirname
const NEW_WINDOW = /(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*new BrowserWindow\(/g

/** Substring from the `{` at `open` through its matching `}` (the option literals hold no braces in strings). */
function braceBlock(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  return source.slice(open)
}

/** `file: variable` for every constructed window whose constructor options do not carry a real title. */
function untitledWindows(files: { file: string; source: string }[]): { windows: string[]; untitled: string[] } {
  const windows: string[] = []
  const untitled: string[] = []
  for (const { file, source } of files) {
    for (const match of source.matchAll(NEW_WINDOW)) {
      const label = `${file}: ${match[1]}`
      windows.push(label)
      const open = source.indexOf('{', (match.index ?? 0) + match[0].length - 1)
      const options = (open === -1 ? '' : braceBlock(source, open))
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      const title = /\btitle:\s*(['"`])(.*?)\1/.exec(options)?.[2]
      if (!title || /^asktoto$/i.test(title)) untitled.push(label)
    }
  }
  return { windows, untitled }
}

function mainSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry))
        out.push({ file: relative(MAIN_DIR, full).replace(/\\/g, '/'), source: readFileSync(full, 'utf8') })
    }
  }
  walk(MAIN_DIR)
  return out
}

describe('M2-0420 — no window is ever titled with the package name', () => {
  it('every new BrowserWindow in src/main sets its own title in the constructor', () => {
    const audit = untitledWindows(mainSources())
    expect(audit.windows.sort()).toEqual([
      'index.ts: decoderWin',
      'index.ts: pdfWin',
      'index.ts: win',
      'intelligence.ts: intelWin'
    ])
    expect(audit.untitled).toEqual([])
  })

  it('the overlay is titled Métis', () => {
    const src = readFileSync(join(MAIN_DIR, 'index.ts'), 'utf8')
    const open = src.indexOf('{', src.indexOf('win = new BrowserWindow('))
    expect(/\btitle:\s*'Métis'/.test(braceBlock(src, open))).toBe(true)
  })

  it('the audit rejects a window with no title or the package name', () => {
    const added = `
  a = new BrowserWindow({ width: 1 })
  b = new BrowserWindow({ title: 'asktoto', width: 1 })
  c = new BrowserWindow({ title: 'Métis', width: 1 })
`
    expect(untitledWindows([{ file: 'x.ts', source: added }]).untitled).toEqual(['x.ts: a', 'x.ts: b'])
  })
})
