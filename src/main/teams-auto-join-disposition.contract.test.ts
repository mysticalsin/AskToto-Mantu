import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// D-18: Teams auto-join is excluded from 2.12. This is a source/doc scan only; it imports no runtime code.
const repoRoot = join(__dirname, '..', '..')
const srcRoot = join(repoRoot, 'src')
const readRepo = (...parts: string[]): string => readFileSync(join(repoRoot, ...parts), 'utf8')

function productionSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...productionSources(full))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full)
  }
  return out
}

const sources = productionSources(srcRoot).map((file) => ({
  file: relative(repoRoot, file),
  text: readFileSync(file, 'utf8')
}))

function offenders(pattern: RegExp): string[] {
  return sources.filter((s) => pattern.test(s.text)).map((s) => s.file)
}

describe('Teams auto-join disposition (D-18)', () => {
  const notes = readRepo('docs', 'RELEASE-NOTES-2.12.md')
  const section = notes.split(/^## Not in 2\.12\s*$/m)[1]?.split(/^## /m)[0] ?? ''

  it('release notes state that Teams auto-join is not in 2.12', () => {
    expect(section).toMatch(/does not join Microsoft Teams meetings by itself/)
  })

  it('release notes keep post-meeting speaker enrichment', () => {
    expect(section).toMatch(/speaker names from the Teams transcript/)
  })

  it('decision record D-18 exists and says excluded', () => {
    const record = readRepo('docs', 'decisions', 'D-18-teams-auto-join.md')
    expect(record).toMatch(/Excluded from 2\.12/)
    expect(record).toMatch(/app registration/)
  })

  it('no source file calls a Teams join or calling API', () => {
    const pattern =
      /\/communications\/calls|\/communications\/onlineMeetings|joinMeeting|Calls\.JoinGroupCall|Calls\.InitiateGroupCall|OnlineMeetings\.ReadWrite/
    expect(offenders(pattern)).toEqual([])
  })

  it('main process never opens a meeting join URL programmatically', () => {
    const mainPrefix = join('src', 'main') + '/'
    const hits = sources
      .filter((s) => s.file.startsWith(mainPrefix))
      .filter((s) =>
        s.text.split('\n').some((line) => line.includes('shell.openExternal') && /joinUrl|meetup-join/.test(line))
      )
      .map((s) => s.file)
    expect(hits).toEqual([])
  })

  it('no auto-join setting key exists', () => {
    expect(offenders(/\b(teamsAutoJoin|autoJoin)\b/i)).toEqual([])
  })

  it('Agenda Join stays a user-click link', () => {
    const agenda = readRepo('src', 'renderer', 'src', 'components', 'AgendaView.tsx')
    expect(agenda).toContain('safeHref(ev.joinUrl)')
    expect(agenda).toMatch(/<a\s[^>]*href=\{joinHref\}/s)
  })
})
