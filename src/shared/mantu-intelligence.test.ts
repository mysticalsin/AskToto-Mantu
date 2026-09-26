import { describe, expect, it } from 'vitest'
import {
  PREFERRED_BRAIN_FOLDER,
  PREFERRED_BRAIN_REL,
  brainConnectSettingsPatch,
  brainHitLabel,
  buildMeetingConnections,
  collectMarkerHits,
  connectionSentence,
  connectionsForMeeting,
  isAbsoluteBrainPath,
  isBrainMarkerName,
  isMantuGroupRoot,
  listOneDriveRoots,
  nameLooksLikeBrain,
  normalizeConnectPath,
  preferredBrainPaths,
  rankBrainHits,
  scoreBrainCandidate,
  uniqueConnectionPairs,
  type BrainScanHit
} from './mantu-intelligence'

describe('scan markers', () => {
  it('recognizes second-brain / LLM wiki names and files', () => {
    expect(isBrainMarkerName('AI Second Brain')).toBe(true)
    expect(isBrainMarkerName('wiki')).toBe(true)
    expect(isBrainMarkerName('wiki/')).toBe(true)
    expect(isBrainMarkerName('.brain')).toBe(true)
    expect(isBrainMarkerName('llms.txt')).toBe(true)
    expect(isBrainMarkerName('CLAUDE.md')).toBe(true)
    expect(isBrainMarkerName('.obsidian')).toBe(true)
    expect(isBrainMarkerName('Tony LLM wiki')).toBe(true)
    expect(isBrainMarkerName('Meetings')).toBe(false)
    expect(isBrainMarkerName('Documents')).toBe(false)
    expect(isBrainMarkerName('')).toBe(false)
  })

  it('collects only marker names from a directory listing', () => {
    expect(collectMarkerHits(['wiki', 'notes.md', '.brain', 'photos', 'llms.txt'])).toEqual([
      '.brain',
      'llms.txt',
      'wiki'
    ])
  })

  it('prefers the Mantu OneDrive AI Second Brain path', () => {
    expect(PREFERRED_BRAIN_FOLDER).toBe('AI Second Brain')
    expect([...PREFERRED_BRAIN_REL]).toEqual(['Documents', 'AI Second Brain'])
    expect(isMantuGroupRoot('/Users/tony/Library/CloudStorage/OneDrive-MantuGroup')).toBe(true)
    expect(isMantuGroupRoot('C:\\Users\\tony\\OneDrive - Mantu Group')).toBe(true)
    expect(isMantuGroupRoot('/Users/tony/Library/CloudStorage/OneDrive-Personal')).toBe(false)

    const roots = listOneDriveRoots({
      platform: 'darwin',
      homedir: '/Users/tony',
      env: {},
      cloudStorageNames: ['OneDrive-Personal', 'OneDrive-MantuGroup']
    })
    expect(roots[0]).toBe('/Users/tony/Library/CloudStorage/OneDrive-MantuGroup')
    expect(roots).toContain('/Users/tony/Library/CloudStorage/OneDrive-Personal')

    const preferred = preferredBrainPaths(roots)
    expect(preferred[0]).toBe(
      '/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/AI Second Brain'
    )
    expect(
      scoreBrainCandidate({
        path: preferred[0],
        folderName: 'AI Second Brain',
        markers: ['wiki', '.brain', 'llms.txt']
      })
    ).toBeGreaterThan(
      scoreBrainCandidate({
        path: '/Users/tony/Library/CloudStorage/OneDrive-Personal/Documents/Notes',
        folderName: 'Notes',
        markers: ['wiki']
      })
    )
  })

  it('lists Windows OneDrive env roots without breaking Mac path shape', () => {
    const win = listOneDriveRoots({
      platform: 'win32',
      homedir: 'C:\\Users\\tony',
      env: {
        OneDriveCommercial: 'C:\\Users\\tony\\OneDrive - Mantu Group',
        OneDrive: 'C:\\Users\\tony\\OneDrive'
      }
    })
    expect(win[0]).toBe('C:\\Users\\tony\\OneDrive - Mantu Group')
    expect(win).toContain('C:\\Users\\tony\\OneDrive')
    expect(preferredBrainPaths(win)[0]).toBe(
      'C:\\Users\\tony\\OneDrive - Mantu Group\\Documents\\AI Second Brain'
    )

    const mac = listOneDriveRoots({
      platform: 'darwin',
      homedir: '/Users/tony',
      env: {},
      cloudStorageNames: ['OneDrive-MantuGroup']
    })
    expect(mac[0]).toBe('/Users/tony/Library/CloudStorage/OneDrive-MantuGroup')
    expect(mac[0]).not.toMatch(/\\/)
  })

  it('ranks preferred hits first', () => {
    const hits: BrainScanHit[] = [
      {
        path: '/tmp/notes',
        label: 'notes',
        markers: ['wiki'],
        preferred: false,
        score: 25,
        connected: false
      },
      {
        path: '/Users/t/Library/CloudStorage/OneDrive-MantuGroup/Documents/AI Second Brain',
        label: 'AI Second Brain (Mantu OneDrive)',
        markers: ['.brain', 'wiki'],
        preferred: true,
        score: 140,
        connected: false
      }
    ]
    expect(rankBrainHits(hits)[0].preferred).toBe(true)
    expect(brainHitLabel(hits[1].path)).toBe('AI Second Brain (Mantu OneDrive)')
  })
})

describe('connect persistence', () => {
  it('rejects relative or empty paste and accepts an absolute path', () => {
    expect(isAbsoluteBrainPath('')).toBe(false)
    expect(isAbsoluteBrainPath('Documents/AI Second Brain')).toBe(false)
    expect(isAbsoluteBrainPath('/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/AI Second Brain')).toBe(
      true
    )
    expect(isAbsoluteBrainPath('C:\\Users\\tony\\OneDrive\\Documents\\AI Second Brain')).toBe(true)
    expect(normalizeConnectPath('   ').ok).toBe(false)
    expect(normalizeConnectPath('relative/wiki').ok).toBe(false)
    expect(normalizeConnectPath('/Users/tony/AI Second Brain')).toEqual({
      ok: true,
      path: '/Users/tony/AI Second Brain'
    })
  })

  it('persists the meetings/brain root as meetingsFolder only (no second index)', () => {
    const path = '/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/AI Second Brain'
    expect(brainConnectSettingsPatch(path)).toEqual({ meetingsFolder: path })
    expect(Object.keys(brainConnectSettingsPatch(path))).toEqual(['meetingsFolder'])
  })
})

describe('Connections edge building', () => {
  const people = [
    {
      name: 'Jane Doe',
      meetings: [
        { file: 'a.md', title: 'Q1 review' },
        { file: 'b.md', title: 'Pricing sync' }
      ]
    }
  ]
  const accounts = [
    {
      name: 'Acme',
      meetings: [
        { file: 'a.md', title: 'Q1 review' },
        { file: 'b.md', title: 'Pricing sync' }
      ]
    }
  ]
  const deals = [
    {
      name: 'Acme renewal',
      meetings: [
        { file: 'a.md', title: 'Q1 review' },
        { file: 'b.md', title: 'Pricing sync' }
      ]
    }
  ]
  const meetings = [
    { source_file: 'a.md', title24: 'Q1 review', topics: ['renewal'] },
    { source_file: 'b.md', title24: 'Pricing sync', topics: ['renewal'] },
    { source_file: 'c.md', title24: 'Internal standup', topics: ['staffing'] }
  ]

  it('builds named clickable edges both directions for person/account/deal/topic', () => {
    const edges = buildMeetingConnections({ people, accounts, deals, meetings })
    const kinds = new Set(edges.map((e) => e.kind))
    expect([...kinds].sort()).toEqual(['account', 'deal', 'person', 'topic'])

    const accountBoth = edges.filter((e) => e.kind === 'account' && e.via === 'Acme')
    expect(accountBoth).toHaveLength(2)
    expect(accountBoth.some((e) => e.a.file === 'a.md' && e.b.file === 'b.md')).toBe(true)
    expect(accountBoth.some((e) => e.a.file === 'b.md' && e.b.file === 'a.md')).toBe(true)

    expect(connectionsForMeeting(edges, 'a.md').some((e) => e.b.file === 'b.md')).toBe(true)
    expect(connectionsForMeeting(edges, 'b.md').some((e) => e.b.file === 'a.md')).toBe(true)

    const pairs = uniqueConnectionPairs(edges)
    expect(pairs.filter((e) => e.kind === 'account' && e.via === 'Acme')).toHaveLength(1)
    expect(pairs[0].sentence).toMatch(/Q1 review and Pricing sync share/)
    expect(connectionSentence({ kind: 'account', via: 'Acme', aTitle: 'Q1 review', bTitle: 'Pricing sync' })).toBe(
      'Q1 review and Pricing sync share account Acme.'
    )
  })

  it('does not invent edges for a single meeting or unmatched topics', () => {
    expect(
      buildMeetingConnections({
        people: [{ name: 'Solo', meetings: [{ file: 'only.md', title: 'Alone' }] }],
        meetings: [{ source_file: 'only.md', title24: 'Alone', topics: ['unique-topic'] }]
      })
    ).toEqual([])
    expect(
      buildMeetingConnections({
        meetings: [
          { source_file: 'a.md', title24: 'A', topics: ['alpha'] },
          { source_file: 'b.md', title24: 'B', topics: ['beta'] }
        ]
      })
    ).toEqual([])
  })

  it('is not an embeddings UI: every row names a kind, via, and two meeting destinations', () => {
    const edges = buildMeetingConnections({ people, accounts, deals, meetings })
    for (const e of edges) {
      expect(e.kind).toMatch(/^(person|account|deal|topic)$/)
      expect(e.via.length).toBeGreaterThan(0)
      expect(e.a.file).toMatch(/\.md$/)
      expect(e.b.file).toMatch(/\.md$/)
      expect(e.a.file).not.toBe(e.b.file)
      expect(e.sentence).not.toMatch(/embedding|similarity|cosine/i)
    }
  })
})

describe('name helpers', () => {
  it('treats second-brain language as a brain folder even without markers', () => {
    expect(nameLooksLikeBrain('AI Second Brain')).toBe(true)
    expect(nameLooksLikeBrain('My LLM wiki')).toBe(true)
    expect(nameLooksLikeBrain('Random Notes')).toBe(false)
  })
})
