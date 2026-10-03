import { describe, expect, it } from 'vitest'
import {
  compositeColors,
  contrastRatio,
  detectedFailureKinds,
  hasClippedTextBox,
  isLargeText,
  pageHasHorizontalScroll,
  boxExtendsHorizontallyOutsideViewport,
  summarizeAudits,
  textContrastRequirement
} from './capture-audit.mjs'

describe('WCAG contrast helpers', () => {
  it('computes the black-on-white maximum contrast ratio', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 4)
  })

  it('keeps the AA body-text boundary honest for adjacent grays on white', () => {
    expect(contrastRatio('#767676', '#fff')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#777777', '#fff')).toBeLessThan(4.5)
  })

  it('alpha-composites text before measuring contrast', () => {
    const composited = compositeColors('rgba(0, 0, 0, 0.5)', '#fff')
    expect(composited).toMatchObject({ r: 127.5, g: 127.5, b: 127.5, a: 1 })
    expect(contrastRatio(composited, '#fff')).toBeCloseTo(3.98, 2)
  })

  it('uses the WCAG large-text boundary exactly', () => {
    expect(isLargeText({ fontSizePx: 23.99, fontWeight: 400 })).toBe(false)
    expect(isLargeText({ fontSizePx: 24, fontWeight: 400 })).toBe(true)
    expect(isLargeText({ fontSizePx: 18.65, fontWeight: 700 })).toBe(false)
    expect(isLargeText({ fontSizePx: 18.66, fontWeight: 700 })).toBe(true)
    expect(textContrastRequirement({ fontSizePx: 18.66, fontWeight: 700 })).toBe(3)
    expect(textContrastRequirement({ fontSizePx: 18.65, fontWeight: 700 })).toBe(4.5)
  })
})

describe('clipping predicates', () => {
  it('fails visible text-bearing boxes clipped by hidden overflow or ellipsis', () => {
    expect(
      hasClippedTextBox({
        visible: true,
        textBearing: true,
        overflowX: 'hidden',
        overflowY: 'visible',
        textOverflow: 'clip',
        scrollWidth: 112,
        clientWidth: 100,
        scrollHeight: 20,
        clientHeight: 20
      })
    ).toBe(true)
    expect(
      hasClippedTextBox({
        visible: true,
        textBearing: true,
        overflowX: 'visible',
        overflowY: 'visible',
        textOverflow: 'ellipsis',
        scrollWidth: 100,
        clientWidth: 100,
        scrollHeight: 24,
        clientHeight: 20
      })
    ).toBe(true)
  })

  it('does not fail invisible, non-text or unclipped boxes', () => {
    const base = {
      visible: true,
      textBearing: true,
      overflowX: 'visible',
      overflowY: 'visible',
      textOverflow: 'clip',
      scrollWidth: 112,
      clientWidth: 100,
      scrollHeight: 20,
      clientHeight: 20
    }
    expect(hasClippedTextBox(base)).toBe(false)
    expect(hasClippedTextBox({ ...base, visible: false, overflowX: 'hidden' })).toBe(false)
    expect(hasClippedTextBox({ ...base, textBearing: false, overflowX: 'hidden' })).toBe(false)
  })

  it('detects page and element horizontal overflow with a one-pixel tolerance', () => {
    expect(pageHasHorizontalScroll({ documentWidth: 962, viewportWidth: 960 })).toBe(true)
    expect(pageHasHorizontalScroll({ documentWidth: 961, viewportWidth: 960 })).toBe(false)
    expect(boxExtendsHorizontallyOutsideViewport({ visible: true, left: -2, right: 100 }, 960)).toBe(true)
    expect(boxExtendsHorizontallyOutsideViewport({ visible: true, left: 0, right: 962 }, 960)).toBe(true)
    expect(boxExtendsHorizontallyOutsideViewport({ visible: true, left: -1, right: 961 }, 960)).toBe(false)
  })
})

describe('audit summaries', () => {
  it('summarizes per-kind checks, failures, unverifiable rows and the negative control', () => {
    const negativeControl = { detected: true, kinds: ['clipping', 'nonText', 'text'] }
    const summary = summarizeAudits(
      [
        {
          audit: {
            pass: false,
            text: { checked: 2, failures: [{ kind: 'contrast' }] },
            nonText: { checked: 1, failures: [] },
            clipping: { checked: 3, failures: [{ kind: 'text-clipped' }] },
            unverifiable: [{ kind: 'text', reason: 'background-image' }]
          }
        }
      ],
      negativeControl
    )
    expect(summary).toMatchObject({
      failures: 2,
      text: { checked: 2, failures: 1 },
      nonText: { checked: 1, failures: 0 },
      clipping: { checked: 3, failures: 1 },
      unverifiable: 1,
      negativeControl
    })
  })

  it('reports detected negative-control failure kinds without text content', () => {
    expect(
      detectedFailureKinds({
        text: { failures: [{ selector: 'p.low' }] },
        nonText: { failures: [{ selector: 'button.low' }] },
        clipping: { failures: [{ selector: 'span.clip' }] }
      })
    ).toEqual(['clipping', 'nonText', 'text'])
  })
})
