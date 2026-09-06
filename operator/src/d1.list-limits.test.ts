import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_PACKS_LIMIT,
  DASHBOARD_PROPOSALS_LIMIT,
  DASHBOARD_PULSES_LIMIT,
  DASHBOARD_SEATS_LIMIT
} from './d1'

const src = readFileSync(join(__dirname, 'd1.ts'), 'utf8')

describe('D1 dashboard lists are bounded (MED)', () => {
  it('exports generous but finite caps', () => {
    expect(DASHBOARD_SEATS_LIMIT).toBe(2000)
    expect(DASHBOARD_PULSES_LIMIT).toBe(5000)
    expect(DASHBOARD_PROPOSALS_LIMIT).toBe(500)
    expect(DASHBOARD_PACKS_LIMIT).toBe(500)
  })

  it('seats/pulses/proposals/packs SELECT statements carry LIMIT ?', () => {
    expect(src).toMatch(/SELECT \* FROM seats ORDER BY last_seen DESC LIMIT \?/)
    expect(src).toMatch(/SELECT \* FROM pulses WHERE ts >= \? ORDER BY ts ASC LIMIT \?/)
    expect(src).toMatch(/SELECT \* FROM proposals ORDER BY created_at DESC LIMIT \?/)
    expect(src).toMatch(/SELECT \* FROM packs ORDER BY pushed_at DESC LIMIT \?/)
    // no unbounded SELECT * FROM seats/pulses/proposals/packs left
    expect(src).not.toMatch(/prepare\('SELECT \* FROM seats'\)/)
    expect(src).not.toMatch(/prepare\('SELECT \* FROM packs'\)/)
  })
})
