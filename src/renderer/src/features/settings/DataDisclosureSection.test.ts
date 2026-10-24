import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DATA_DISCLOSURES, LEAVES_DEVICE_LABEL } from '@shared/data-disclosure'
import { DataDisclosureSection } from './DataDisclosureSection'

const html = renderToStaticMarkup(createElement(DataDisclosureSection))
const decoded = html
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&')

describe('Settings › Privacy › Your data (G83)', () => {
  it('renders one disclosure per DATA_DISCLOSURES row with title, stored, leaves device, kept, delete', () => {
    expect(html.match(/<details/g)?.length).toBe(DATA_DISCLOSURES.length)
    for (const row of DATA_DISCLOSURES) {
      expect(decoded).toContain(row.title)
      expect(decoded).toContain(row.storedAt)
      expect(decoded).toContain(LEAVES_DEVICE_LABEL[row.leavesDevice])
      expect(decoded).toContain(row.retention)
      expect(decoded).toContain(row.howToDelete)
    }
    for (const label of ['Reads', 'Stored', 'Leaves this Mac', 'Kept', 'Delete'])
      expect(html).toContain(`>${label}</dt>`)
  })

  it('each row is a native summary, so it is keyboard reachable with its title as the accessible name', () => {
    expect(html.match(/<summary/g)?.length).toBe(DATA_DISCLOSURES.length)
    expect(html).not.toMatch(/tabindex="-1"/)
  })

  it('shows no absolute path, home directory or store file name', () => {
    expect(decoded).not.toMatch(/(\/Users\/|C:\\|~\/)/)
    // Single plain words ('graph', 'logs') are ordinary copy; file-like names (a dot or a hyphen) must never show.
    const fileNames = DATA_DISCLOSURES.flatMap((row) => row.userDataEntries).filter((e) => /[.-]/.test(e))
    for (const name of fileNames) expect(decoded).not.toContain(name)
  })
})
