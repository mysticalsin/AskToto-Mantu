import { describe, expect, it } from 'vitest'
import { mapCloudFinalToLine, mapCloudFinalsToLines } from './cloud-stt-line-map'

const base = {
  id: 'seg1',
  text: 'Bonjour',
  startMs: 0,
  endMs: 500,
  cluster: '0',
  language: 'fr'
}

describe('mapCloudFinalToLine', () => {
  it('maps mic finals to profile name (honest You fallback)', () => {
    expect(mapCloudFinalToLine(base, 'you', { profile: { name: 'Tony' } })).toMatchObject({
      speaker: 'you',
      text: 'Bonjour',
      name: 'Tony',
      language: 'fr'
    })
    expect(mapCloudFinalToLine(base, 'you', { profile: { name: '' } })?.name).toBe('You')
    expect(mapCloudFinalToLine(base, 'you')?.name).toBe('You')
  })

  it('maps remote finals to Speaker N from cluster (never invents person names)', () => {
    expect(mapCloudFinalToLine(base, 'them')).toMatchObject({
      speaker: 'them',
      text: 'Bonjour',
      name: 'Speaker 1',
      cluster: '0'
    })
    expect(mapCloudFinalToLine({ ...base, cluster: 'unknown' }, 'them')?.name).toMatch(/^Unknown speaker/)
  })


  it('appends mic role onto profile name when present', () => {
    expect(mapCloudFinalToLine(base, 'you', { profile: { name: 'Tony', role: 'CEO' } })?.name).toBe(
      'Tony · CEO'
    )
  })

  it('drops empty / whitespace-only finals', () => {
    expect(mapCloudFinalToLine({ ...base, text: '   ' }, 'you')).toBeNull()
  })
})

describe('mapCloudFinalsToLines', () => {
  it('maps a normalizer finals array for a channel', () => {
    const lines = mapCloudFinalsToLines(
      [
        { ...base, id: 'a', text: 'Hello', cluster: '0' },
        { ...base, id: 'b', text: 'world', cluster: '1' }
      ],
      'them'
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]?.name).toBe('Speaker 1')
    expect(lines[1]?.name).toBe('Speaker 2')
  })
})
