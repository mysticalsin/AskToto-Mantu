import { describe, expect, it } from 'vitest'
import { compare, fitsInside, formatFailureSummary, pngSize, screenshotCoversBox } from './settings-section-visual-compare.mjs'

type Section = {
  key: string
  tab: string
  index: number
  title: string
  width: number
  height: number
  clipped: boolean
  sha256: string
  bytes: number
  file: string
}

function section(overrides: Partial<Section> = {}): Section {
  return {
    key: 'brain-01-models',
    tab: 'Brain',
    index: 0,
    title: 'Models',
    width: 320,
    height: 180,
    clipped: false,
    sha256: 'a'.repeat(64),
    bytes: 1234,
    file: 'before/brain-01-models.png',
    ...overrides
  }
}

function capture(sections: Section[]) {
  return {
    label: 'before',
    status: 'CAPTURED',
    sectionCount: sections.length,
    sections
  }
}

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0)
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

describe('settings-section-visual-compare compare', () => {
  it('passes when every section identity, dimensions and pixels match', () => {
    const before = capture([section()])
    const after = capture([section({ file: 'after/brain-01-models.png' })])

    expect(compare(before, after)).toMatchObject({
      status: 'PASS',
      sectionCount: { before: 1, after: 1 },
      rows: [{ key: 'brain-01-models', status: 'PASS', failures: [] }]
    })
  })

  it('fails when a section is missing from either side', () => {
    expect(compare(capture([]), capture([section()])).rows).toEqual([
      expect.objectContaining({ key: 'brain-01-models', status: 'FAIL', failures: ['missing_before'] })
    ])
    expect(compare(capture([section()]), capture([])).rows).toEqual([
      expect.objectContaining({ key: 'brain-01-models', status: 'FAIL', failures: ['missing_after'] })
    ])
  })

  it('fails for pixel or size changes', () => {
    const changed = compare(capture([section()]), capture([section({ width: 321, sha256: 'b'.repeat(64) })]))

    expect(changed.status).toBe('FAIL')
    expect(changed.rows).toEqual([
      expect.objectContaining({
        status: 'FAIL',
        failures: ['dimensions_changed', 'pixels_changed']
      })
    ])
  })

  it('fails zero-section and unequal-count captures', () => {
    expect(compare(capture([]), capture([])).status).toBe('FAIL')
    expect(compare(capture([section()]), capture([section(), section({ key: 'audio-01-inputs', tab: 'Audio' })])).status).toBe('FAIL')
  })

  it('fails a clipped section even when the pixels match', () => {
    const compared = compare(capture([section()]), capture([section({ clipped: true })]))

    expect(compared.status).toBe('FAIL')
    expect(compared.rows[0]).toEqual(expect.objectContaining({ status: 'FAIL', failures: ['clipped'] }))
  })

  it('keeps viewport clipping diagnostic-only when the PNG covers the whole section', () => {
    const sectionBox = { x: 24, y: 40, width: 820, height: 900 }
    const panelBox = { x: 16, y: 32, width: 850, height: 640 }

    expect(fitsInside(sectionBox, panelBox)).toBe(false)
    expect(screenshotCoversBox(png(820, 900), sectionBox)).toBe(true)
    expect(compare(capture([section()]), capture([section()]))).toMatchObject({
      status: 'PASS',
      rows: [{ key: 'brain-01-models', status: 'PASS', failures: [] }]
    })
  })

  it('detects when the uploaded section PNG is smaller than the section box', () => {
    const sectionBox = { x: 24, y: 40, width: 820, height: 900 }

    expect(pngSize(png(819, 900))).toEqual({ width: 819, height: 900 })
    expect(screenshotCoversBox(png(818, 900), sectionBox)).toBe(false)
    expect(screenshotCoversBox(png(820, 898), sectionBox)).toBe(false)
  })

  it('prints failing rows so hosted CI logs name the section that changed', () => {
    const report = {
      result: 'fail',
      comparison: compare(capture([section()]), capture([section({ sha256: 'b'.repeat(64) })]))
    }

    expect(formatFailureSummary(report)).toContain('brain-01-models')
    expect(formatFailureSummary(report)).toContain('pixels_changed')
  })
})
