import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { buildStandSnapshot, buildStandLayers } from './stand-snapshot'
import type { DashboardData } from '../types/data'

describe('Cap3 stand repro', () => {
  it('runs on data.example.json without throw', () => {
    const data = JSON.parse(
      readFileSync(new URL('../../dist/data.example.json', import.meta.url), 'utf8')
    ) as DashboardData
    const snap = buildStandSnapshot(data)
    expect(snap.answers).toHaveLength(7)
    expect(buildStandLayers(data).deterministic.answers).toHaveLength(7)
  })

  it('survives weird deal shapes', () => {
    const data = JSON.parse(
      readFileSync(new URL('../../dist/data.example.json', import.meta.url), 'utf8')
    ) as DashboardData
    ;(data.deals[0] as { velocity?: unknown }).velocity = null
    delete (data.deals[0] as { commitments?: unknown }).commitments
    delete (data as { going_cold?: unknown }).going_cold
    expect(() => buildStandSnapshot(data)).not.toThrow()
  })
})
