import { describe, expect, it } from 'vitest'
import { blueBars } from './charts'

describe('#119 Unique seats sparkline is solid 30-min bars', () => {
  it('draws #2563EB rects only for minutes with unique seats', () => {
    const series = Array.from({ length: 30 }, (_, i) => ([8, 14, 15, 22].includes(i) ? 1 : 0))
    const svg = blueBars(series, 280, 56)
    expect(svg).toContain('fill="#2563EB"')
    expect((svg.match(/<rect /g) || []).length).toBe(4)
    expect(svg).not.toContain('stroke-dasharray')
    expect(svg).not.toContain('stroke="#EDEDED"')
    expect(svg).not.toMatch(/<rect[^>]*height="1\./)
  })

  it('draws no stub bars when every minute is empty', () => {
    const svg = blueBars(Array.from({ length: 30 }, () => 0), 280, 56)
    expect(svg).not.toContain('<rect')
    expect(svg).toContain('stroke="#EDEDED"')
    expect(svg).not.toContain('stroke-dasharray')
    expect(svg).not.toContain('fill="#2563EB"')
  })
})
