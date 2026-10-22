import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkTeamFolder } from './team-folder-check'

const roots: string[] = []
async function tree(): Promise<{ meetings: string; team: string; other: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'metis-team-folder-')))
  roots.push(root)
  const meetings = join(root, 'meetings')
  const team = join(root, 'team')
  const other = join(root, 'other')
  for (const d of [meetings, join(meetings, '.brain'), team, other]) await mkdir(d, { recursive: true })
  return { meetings, team, other, root }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe('checkTeamFolder (D9-10)', () => {
  it('accepts a separate readable folder', async () => {
    const { meetings, team } = await tree()
    expect(await checkTeamFolder(team, { meetingsFolder: meetings, teamFolders: [] })).toBeNull()
  })

  it('refuses a folder equal to the meetings folder', async () => {
    const { meetings } = await tree()
    const refusal = await checkTeamFolder(meetings, { meetingsFolder: meetings, teamFolders: [] })
    expect(refusal?.reason).toBe('overlaps-meetings')
    expect(refusal?.message).toMatch(/already where your own meetings are saved/)
  })

  it('refuses a folder inside the meetings folder, including the brain folder, and one that contains it', async () => {
    const { meetings, root } = await tree()
    expect(
      (await checkTeamFolder(join(meetings, '.brain'), { meetingsFolder: meetings, teamFolders: [] }))?.reason
    ).toBe('overlaps-meetings')
    expect((await checkTeamFolder(root, { meetingsFolder: meetings, teamFolders: [] }))?.reason).toBe(
      'overlaps-meetings'
    )
  })

  it('compares real paths, so a symlink to the meetings folder is refused', async () => {
    const { meetings, root } = await tree()
    const link = join(root, 'link-to-meetings')
    try {
      await symlink(meetings, link, 'dir')
    } catch {
      return // symlink creation can need elevation on Windows; the other cases still run there
    }
    expect((await checkTeamFolder(link, { meetingsFolder: meetings, teamFolders: [] }))?.reason).toBe(
      'overlaps-meetings'
    )
  })

  it('refuses a folder that overlaps one already added', async () => {
    const { meetings, team } = await tree()
    expect((await checkTeamFolder(team, { meetingsFolder: meetings, teamFolders: [team] }))?.reason).toBe(
      'overlaps-team'
    )
    expect((await checkTeamFolder(join(team, 'sub'), { meetingsFolder: meetings, teamFolders: [team] }))?.reason).toBe(
      'overlaps-team'
    )
  })

  it('refuses a folder that cannot be read', async () => {
    const { meetings, root } = await tree()
    const refusal = await checkTeamFolder(join(root, 'missing'), { meetingsFolder: meetings, teamFolders: [] })
    expect(refusal?.reason).toBe('not-readable')
  })

  it('accepts an injected reader, for hosts where permission bits cannot be faked', async () => {
    const { meetings, team } = await tree()
    const refusal = await checkTeamFolder(team, {
      meetingsFolder: meetings,
      teamFolders: [],
      canRead: async () => false
    })
    expect(refusal?.reason).toBe('not-readable')
  })
})
