import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLICK_BODY_HZ, CLICK_DURATION_S, CLICK_OVERTONE_RATIO, CLICK_PEAK, playClick, setSoundsEnabled } from './sound'

describe('playClick tactile tap', () => {
  it('is not a lone 880Hz sine — body stays under 500Hz with a short dark envelope', () => {
    expect(CLICK_BODY_HZ).toBeGreaterThanOrEqual(180)
    expect(CLICK_BODY_HZ).toBeLessThanOrEqual(240)
    expect(CLICK_BODY_HZ).toBeLessThan(500)
    expect(CLICK_OVERTONE_RATIO).toBeGreaterThanOrEqual(2)
    expect(CLICK_OVERTONE_RATIO).toBeLessThanOrEqual(3)
    expect(CLICK_DURATION_S).toBeGreaterThanOrEqual(0.045)
    expect(CLICK_DURATION_S).toBeLessThanOrEqual(0.07)
    expect(CLICK_PEAK).toBeGreaterThan(0)
    expect(CLICK_PEAK).toBeLessThanOrEqual(0.04)
    const src = readFileSync(join(__dirname, 'sound.ts'), 'utf8')
    const click = src.slice(src.indexOf('export function playClick'), src.indexOf('export function playCue'))
    expect(click).not.toMatch(/frequency\.value\s*=\s*880/)
    expect(click).toMatch(/triangle/)
    expect(click).toMatch(/createBuffer/)
    expect(click).toMatch(/if \(!soundsOn\) return/)
  })

  it('stays silent when the master gate is off', () => {
    setSoundsEnabled(false)
    expect(() => playClick()).not.toThrow()
    setSoundsEnabled(true)
  })
})
