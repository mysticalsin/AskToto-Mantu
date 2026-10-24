import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  AVAILABILITY,
  extractAvailabilitySection,
  privacyViolations,
  releaseBlockers,
  renderAvailabilityTable,
  REQUIRED_IDS,
  STATUSES,
  validateLedger
} from './dispositions.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')
const LEDGER_PATH = 'docs/release-2.12/dispositions.json'
const NOTES_PATH = 'docs/RELEASE-NOTES-2.12.md'

type Entry = {
  id: string
  title: string
  status: string
  evidence?: string[]
  reason?: string
  unblock?: string
  notRun?: string[]
}
type Ledger = { schemaVersion: number; release: string; derivedFrom: string; entries: Entry[] }

function fixture(overrides: Record<string, Partial<Entry>> = {}): Ledger {
  return {
    schemaVersion: 1,
    release: '2.12',
    derivedFrom: 'abcdef1',
    entries: REQUIRED_IDS.map((id: string) => ({
      id,
      title: `Title ${id}`,
      status: 'shipped',
      evidence: ['abcdef1'],
      ...overrides[id]
    }))
  }
}

const exists = () => true

describe('G92 requirement disposition ledger', () => {
  it('REQUIRED_IDS covers CAP-01..CAP-40 and NB-01..NB-08 exactly (48 ids)', () => {
    expect(REQUIRED_IDS).toHaveLength(48)
    expect(new Set(REQUIRED_IDS).size).toBe(48)
    expect(REQUIRED_IDS[0]).toBe('CAP-01')
    expect(REQUIRED_IDS).toContain('CAP-40')
    expect(REQUIRED_IDS).toContain('NB-08')
    expect(STATUSES).toEqual(['shipped', 'preview', 'deferred', 'owner-blocked', 'pending'])
    expect(AVAILABILITY.preview).toBe('Preview (off)')
  })

  it('accepts a fully disposed fixture', () => {
    expect(validateLedger(fixture(), { exists })).toEqual([])
  })

  it('validateLedger rejects a missing id', () => {
    const ledger = fixture()
    ledger.entries = ledger.entries.filter((e) => e.id !== 'CAP-07')
    expect(validateLedger(ledger, { exists }).join('\n')).toMatch(/missing.*CAP-07/i)
  })

  it('validateLedger rejects a duplicate id', () => {
    const ledger = fixture()
    ledger.entries.push({ ...ledger.entries[0] })
    expect(validateLedger(ledger, { exists }).join('\n')).toMatch(/duplicate.*CAP-01/i)
  })

  it('validateLedger rejects an unknown id', () => {
    const ledger = fixture()
    ledger.entries.push({ id: 'CAP-41', title: 'x', status: 'pending' })
    expect(validateLedger(ledger, { exists }).join('\n')).toMatch(/unknown.*CAP-41/i)
  })

  it('validateLedger rejects an unknown status', () => {
    const ledger = fixture({ 'CAP-02': { status: 'done' } })
    expect(validateLedger(ledger, { exists }).join('\n')).toMatch(/CAP-02.*status/i)
  })

  it('validateLedger requires a reason for deferred', () => {
    const ledger = fixture({ 'NB-02': { status: 'deferred', evidence: undefined } })
    expect(validateLedger(ledger, { exists }).join('\n')).toMatch(/NB-02.*reason/i)
  })

  it('validateLedger requires reason and unblock for owner-blocked', () => {
    const ledger = fixture({ 'CAP-36': { status: 'owner-blocked', evidence: undefined } })
    const errors = validateLedger(ledger, { exists }).join('\n')
    expect(errors).toMatch(/CAP-36.*reason/i)
    expect(errors).toMatch(/CAP-36.*unblock/i)
  })

  it('validateLedger requires evidence for shipped and preview', () => {
    const ledger = fixture({ 'CAP-03': { evidence: [] }, 'CAP-04': { status: 'preview', evidence: undefined } })
    const errors = validateLedger(ledger, { exists }).join('\n')
    expect(errors).toMatch(/CAP-03.*evidence/i)
    expect(errors).toMatch(/CAP-04.*evidence/i)
  })

  it('validateLedger rejects evidence that is neither a SHA nor an existing path', () => {
    const ledger = fixture({ 'CAP-05': { evidence: ['not a sha', 'docs/nowhere.md'] } })
    const errors = validateLedger(ledger, { exists: () => false }).join('\n')
    expect(errors).toMatch(/CAP-05.*evidence/i)
    expect(validateLedger(fixture({ 'CAP-05': { evidence: ['docs/here.md'] } }), { exists: () => true })).toEqual([])
  })

  it('renderAvailabilityTable maps statuses to Available, Preview (off), Not in 2.12, Pending qualification', () => {
    const table = renderAvailabilityTable(
      fixture({
        'CAP-02': { status: 'preview' },
        'CAP-03': { status: 'deferred', reason: 'Later.', evidence: undefined },
        'CAP-04': { status: 'owner-blocked', reason: 'Needs an account.', unblock: 'Provide it.', evidence: undefined },
        'CAP-05': { status: 'pending', evidence: undefined }
      })
    )
    expect(table).toContain('| Capability | Availability | Notes |')
    expect(table).toMatch(/\| CAP-01 .*\| Available \|/)
    expect(table).toMatch(/\| CAP-02 .*\| Preview \(off\) \|/)
    expect(table).toMatch(/\| CAP-03 .*\| Not in 2.12 \| Later\. \|/)
    expect(table).toMatch(/\| CAP-04 .*\| Not in 2.12 \| Needs an account\. Unblock: Provide it\. \|/)
    expect(table).toMatch(/\| CAP-05 .*\| Pending qualification \|/)
    expect(table.indexOf('CAP-01')).toBeLessThan(table.indexOf('CAP-02'))
  })

  it('renderAvailabilityTable emits one "Not run:" line per notRun item and escapes pipes', () => {
    const table = renderAvailabilityTable(
      fixture({
        'CAP-10': { notRun: ['Revoke and grant on a Mac', 'Second | item'] },
        'CAP-02': { title: 'A | B' }
      })
    )
    expect(table).toContain('- Not run: CAP-10 Revoke and grant on a Mac')
    expect(table).toContain('- Not run: CAP-10 Second \\| item')
    expect(table.match(/^- Not run:/gm)).toHaveLength(2)
    expect(table).toContain('A \\| B')
  })

  it('extractAvailabilitySection returns null without markers', () => {
    expect(extractAvailabilitySection('# Notes\n\nNo markers here.\n')).toBeNull()
    expect(extractAvailabilitySection('a\n<!-- availability:begin -->\nX\n<!-- availability:end -->\nb')).toBe('X')
  })

  it('releaseBlockers lists every pending id and is empty for a fully disposed fixture', () => {
    expect(releaseBlockers(fixture())).toEqual([])
    const blockers = releaseBlockers(
      fixture({
        'CAP-09': { status: 'pending', evidence: undefined },
        'CAP-01': { status: 'pending', evidence: undefined }
      })
    )
    expect(blockers).toEqual(['CAP-01', 'CAP-09'])
  })

  it('privacyViolations flags each forbidden pattern and passes clean text', () => {
    const bad = [
      'see _relay/notes',
      'in /Users/someone/x',
      'at ~/Documents',
      'mail a.b@example.com',
      'ticket G92 landed',
      'ticket V07 landed',
      'per D-28 rule',
      'M212-01 thing',
      'C212-02 thing',
      'GATE-09 thing',
      'E2E-04 thing',
      'JEV scenarios',
      'NEEDS_TONY file',
      'MASTER-PLAN doc',
      'Tony said',
      'Hindsight tool',
      'Perssua tool',
      'owner 17:20 decided'
    ]
    for (const text of bad) {
      expect(privacyViolations(text), text).not.toEqual([])
    }
    expect(privacyViolations('Screen context authorization and lifecycle. Evidence 1a2b3c4d.')).toEqual([])
  })

  describe('committed files', () => {
    const ledger = JSON.parse(read(LEDGER_PATH)) as Ledger

    it('the committed ledger validates', () => {
      expect(validateLedger(ledger, { exists: (p: string) => existsSync(join(REPO, p)) })).toEqual([])
    })

    it('the release notes availability section equals renderAvailabilityTable(ledger)', () => {
      const section = extractAvailabilitySection(read(NOTES_PATH))
      expect(section).not.toBeNull()
      expect(section).toBe(renderAvailabilityTable(ledger).trim())
    })

    it('neither file has privacy violations', () => {
      expect(privacyViolations(read(LEDGER_PATH))).toEqual([])
      expect(privacyViolations(read(NOTES_PATH))).toEqual([])
    })
  })
})
