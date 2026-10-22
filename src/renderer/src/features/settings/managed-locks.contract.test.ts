/**
 * Managed locks on every Settings switch (Q10, D6-5, HIG S6: unavailable options are dimmed with a short reason).
 *
 * store.ts drops a managed (IT-locked) key from every write without telling the caller, so a ToggleRow that is still
 * enabled looks editable and snaps back after the click. ToggleRow already renders "Managed by your organization"
 * when it is disabled, so each row that patches a settings key must disable itself on that same top-level key.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = __dirname

type Row = { file: string; line: number; label: string; key: string | null; tag: string }

/** The opening `<ToggleRow ...>` tag of every row in a source file, found by brace depth (arrows hold a `>`). */
function toggleRows(file: string): Row[] {
  const source = readFileSync(join(dir, file), 'utf8')
  const rows: Row[] = []
  for (const match of source.matchAll(/<ToggleRow\b/g)) {
    const start = match.index ?? 0
    let depth = 0
    let end = start
    for (; end < source.length; end++) {
      const c = source[end]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0 && source[end - 1] !== '=') break
    }
    const tag = source.slice(start, end + 1)
    const key =
      /\b(?:reportedP|p)atch\(\{\s*(\w+)\s*:/.exec(tag)?.[1] ?? (/\bpatchTap\(/.test(tag) ? 'tapControl' : null)
    rows.push({
      file,
      line: source.slice(0, start).split('\n').length,
      label: /label=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag)?.slice(1).find(Boolean) ?? '?',
      key,
      tag
    })
  }
  return rows
}

const files = readdirSync(dir).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
const rows = files.flatMap(toggleRows)

describe('every ToggleRow that patches a settings key honours its managed lock', () => {
  it('finds the switches this contract is about', () => {
    expect(rows.length).toBeGreaterThan(30)
  })

  it('every row names the top-level settings key it writes', () => {
    const unknown = rows.filter((r) => r.key === null).map((r) => `${r.file}:${r.line} ${r.label}`)
    expect(unknown).toEqual([])
  })

  it('every row is disabled by the same top-level key store.ts checks', () => {
    const unlocked = rows
      .filter((r) => r.key !== null)
      .filter((r) => {
        // The tap-control card computes one `locked` flag from managedKeys.includes('tapControl').
        const lock =
          r.key === 'tapControl' ? /disabled=\{locked\}/ : new RegExp(`managedKeys\\.includes\\('${r.key}'\\)`)
        return !/disabled=\{/.test(r.tag) || !lock.test(r.tag)
      })
      .map((r) => `${r.file}:${r.line} ${r.label} (${r.key})`)
    expect(unlocked).toEqual([])
  })
})
