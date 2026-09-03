import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '@shared/ipc'
import { discoverSecondBrains, inspectSecondBrainFolder } from './discover'

const baseSettings = (): Settings =>
  ({
    meetingsFolder: ''
  }) as Settings

describe('discoverSecondBrains', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('finds a folder with .brain and wiki next to a decoy', () => {
    root = mkdtempSync(join(tmpdir(), 'metis-brain-hunt-'))
    const brain = join(root, 'Métis Meetings')
    mkdirSync(join(brain, '.brain'), { recursive: true })
    writeFileSync(join(brain, '.brain', 'index.json'), '{"v":1}', 'utf8')
    mkdirSync(join(brain, 'wiki'), { recursive: true })
    writeFileSync(join(brain, 'wiki', 'CLAUDE.md'), '# second brain\n', 'utf8')
    writeFileSync(join(brain, '2026-01-01_meeting.md'), '# hello\n', 'utf8')
    mkdirSync(join(root, 'Random Photos'), { recursive: true })
    writeFileSync(join(root, 'Random Photos', 'note.md'), 'nope\n', 'utf8')

    const hits = discoverSecondBrains(baseSettings(), {
      roots: [root],
      currentFolder: join(root, 'other-current')
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].path).toBe(brain)
    expect(hits[0].hasBrain).toBe(true)
    expect(hits[0].hasWiki).toBe(true)
    expect(hits[0].meetingCount).toBe(1)
    expect(hits[0].isCurrent).toBe(false)
  })

  it('marks the active meetings folder as current', () => {
    root = mkdtempSync(join(tmpdir(), 'metis-brain-hunt-'))
    const brain = join(root, 'AskToto Meetings')
    mkdirSync(join(brain, '.brain'), { recursive: true })
    writeFileSync(join(brain, 'legacy.md'), '# old\n', 'utf8')

    const hits = discoverSecondBrains(baseSettings(), {
      roots: [root],
      currentFolder: brain
    })
    expect(hits[0]?.isCurrent).toBe(true)
  })

  it('ignores empty named folders without brain/wiki/meetings', () => {
    root = mkdtempSync(join(tmpdir(), 'metis-brain-hunt-'))
    mkdirSync(join(root, 'Métis Meetings'), { recursive: true })
    expect(
      discoverSecondBrains(baseSettings(), {
        roots: [root],
        currentFolder: join(root, 'x')
      })
    ).toEqual([])
  })

  it('inspectSecondBrainFolder rejects non-brain paths', () => {
    root = mkdtempSync(join(tmpdir(), 'metis-brain-hunt-'))
    mkdirSync(join(root, 'Desktop'), { recursive: true })
    expect(inspectSecondBrainFolder(join(root, 'Desktop'))).toBeNull()
  })
})
