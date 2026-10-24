import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'
import { mayLeaveDevice } from './contracts/privacy-class'
import { DATA_DISCLOSURES, DataDisclosureSchema, LIVE_MEETING_JOURNAL_RETENTION_COPY } from './data-disclosure'

const repoRoot = join(__dirname, '..', '..')

describe('per-data-type disclosure table (G83)', () => {
  it('parses every row with the strict schema', () => {
    expect(DATA_DISCLOSURES.length).toBeGreaterThan(0)
    for (const row of DATA_DISCLOSURES) expect(DataDisclosureSchema.safeParse(row).success).toBe(true)
    expect(Object.isFrozen(DATA_DISCLOSURES)).toBe(true)
  })

  it('row ids are unique', () => {
    const ids = DATA_DISCLOSURES.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('P3 and P4 rows never leave the device', () => {
    for (const row of DATA_DISCLOSURES.filter((r) => r.privacyClass === 'P3' || r.privacyClass === 'P4')) {
      expect(mayLeaveDevice(row.privacyClass, { userConsented: true }), row.id).toBe(false)
      expect(row.leavesDevice, row.id).toBe('never')
    }
  })

  it("P2 rows leave only on consent or through the owner's cloud folder", () => {
    for (const row of DATA_DISCLOSURES.filter((r) => r.privacyClass === 'P2')) {
      if (row.leavesDevice === 'never' || row.leavesDevice === 'synced-by-your-cloud-folder') continue
      expect(['on-your-action', 'when-you-turn-it-on'], row.id).toContain(row.leavesDevice)
      expect(mayLeaveDevice('P2', { userConsented: false })).toBe(false)
      expect(mayLeaveDevice('P2', { userConsented: true })).toBe(true)
    }
    const synced = DATA_DISCLOSURES.filter((r) => r.leavesDevice === 'synced-by-your-cloud-folder')
    for (const row of synced) expect(row.privacyClass, row.id).toBe('P2')
  })

  it('secret rows are P4 and say how to remove the key', () => {
    const secrets = DATA_DISCLOSURES.filter((r) => r.kind === 'secret')
    expect(secrets.length).toBeGreaterThan(0)
    for (const row of secrets) {
      expect(row.privacyClass, row.id).toBe('P4')
      expect(row.howToDelete, row.id).toMatch(/Sign out|Disconnect/)
    }
  })

  it('never rows have empty detail; other rows explain where data goes', () => {
    for (const row of DATA_DISCLOSURES) {
      if (row.leavesDevice === 'never') expect(row.leavesDeviceDetail, row.id).toBe('')
      else expect(row.leavesDeviceDetail.length, row.id).toBeGreaterThan(20)
    }
  })

  it('every evidence path exists at the tip', () => {
    for (const row of DATA_DISCLOSURES) {
      expect(row.evidence.length, row.id).toBeGreaterThan(0)
      for (const specifier of row.evidence) {
        expect(() => readModuleSource(repoRoot, `./${specifier}`), `${row.id}: ${specifier}`).not.toThrow()
      }
    }
  })

  it('live meeting journal retention is rendered from LIVE_MEETING_JOURNAL_RETENTION', () => {
    // The constant lives in main, which shared may not import; read its source instead of restating it.
    const { text } = readModuleSource(repoRoot, './src/main/features/meetings/journal-recovery')
    const match =
      /LIVE_MEETING_JOURNAL_RETENTION = Object\.freeze\(\{ maxAgeMs: (\d+) \* 24 \* 60 \* 60 \* 1000, maxJournals: (\d+) \}\)/.exec(
        text
      )
    expect(match).not.toBeNull()
    const [, days, journals] = match as RegExpExecArray
    expect(LIVE_MEETING_JOURNAL_RETENTION_COPY).toBe(
      `Unsaved live-meeting journals: up to ${days} days, at most ${journals}.`
    )
    const transcripts = DATA_DISCLOSURES.find((r) => r.id === 'meeting-transcripts')
    expect(transcripts?.retention).toContain(LIVE_MEETING_JOURNAL_RETENTION_COPY)
  })

  it('rejects an unknown key (strict)', () => {
    expect(DataDisclosureSchema.safeParse({ ...DATA_DISCLOSURES[0], fallback: 1 }).success).toBe(false)
  })

  it('copy uses no em dash and never shows a path', () => {
    for (const row of DATA_DISCLOSURES) {
      for (const copy of [row.title, row.reads, row.storedAt, row.leavesDeviceDetail, row.retention, row.howToDelete]) {
        expect(copy, row.id).not.toMatch(/—|\/Users\/|~\/|[A-Z]:\\/)
      }
    }
  })
})
