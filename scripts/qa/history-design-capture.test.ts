import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import { HISTORY_DEGRADED_MS as RENDERER_DEGRADED_MS } from '../../src/renderer/src/components/history/list-status'
import { NOT_DOWNLOADED_TEXT, UNAVAILABLE_TEXT } from '../../src/renderer/src/components/history/hydration'
import { driveState, STATE_TIMEOUT_MS, warmUp } from './history-design-capture.mjs'
import {
  BACKDROPS,
  BLOCKED_EXTERNAL_ROWS,
  DESIGN_VARIANTS,
  HISTORY_DEGRADED_MS,
  HISTORY_DESIGN_STATES,
  IPC_CHANNELS,
  KEYBOARD_VARIANT_ID,
  composite,
  contrastRatio,
  designVerdict,
  deviceMetricsForVariant,
  historyTransitions,
  judgeCapture,
  judgeClipping,
  judgeContrast,
  listAnswer,
  solidGradientLayers
} from './lib/history-design.mjs'

const WHITE = [255, 255, 255]
const BLACK = [0, 0, 0]

function textSample(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'text',
    label: 'sample',
    fg: [255, 255, 255, 1],
    opacity: 1,
    layers: [[0, 0, 0, 1]],
    bgImage: false,
    disabled: false,
    fontSizePx: 13,
    fontWeight: 400,
    rect: { left: 10, right: 110, top: 10, bottom: 30 },
    box: { overflowX: 'visible', overflowY: 'visible', textOverflow: 'clip', scrollWidth: 100, clientWidth: 100, scrollHeight: 20, clientHeight: 20 },
    clipAncestor: null,
    ...overrides
  }
}

const viewport = { width: 400, height: 600 }
const dark = DESIGN_VARIANTS.find((variant) => variant.id === KEYBOARD_VARIANT_ID)!

afterEach(() => {
  vi.restoreAllMocks()
})

describe('History design matrix (M2-0032)', () => {
  it('captures every state in light and dark, at 1x and 2x, with motion allowed and reduced', () => {
    expect(DESIGN_VARIANTS).toHaveLength(8)
    for (const appearance of ['light', 'dark']) {
      for (const scale of [1, 2]) {
        for (const motion of ['no-preference', 'reduce']) {
          expect(DESIGN_VARIANTS.filter((v) => v.appearance === appearance && v.scale === scale && v.motion === motion)).toHaveLength(1)
        }
      }
    }
    expect(new Set(DESIGN_VARIANTS.map((v) => v.id)).size).toBe(8)
    expect(dark).toMatchObject({ appearance: 'dark', scale: 1, motion: 'no-preference' })
  })

  it("covers the ticket's states: not downloaded, unavailable, explicit download progress and its failure, and the degraded banners", () => {
    expect(HISTORY_DESIGN_STATES.map((s) => s.id)).toEqual([
      'loading',
      'slow',
      'slow-with-rows',
      'failed',
      'rows',
      'not-downloaded',
      'hydrating',
      'download-failed',
      'unavailable'
    ])
    const names = (id: string) => HISTORY_DESIGN_STATES.find((s) => s.id === id)!.roles.map((r) => ('name' in r ? r.name : undefined))
    expect(names('not-downloaded')).toContain(NOT_DOWNLOADED_TEXT)
    expect(names('unavailable')).toContain(UNAVAILABLE_TEXT)
  })

  it("drives History through its own IPC channels and the renderer's degraded threshold", () => {
    expect(IPC_CHANNELS).toEqual({
      recallList: IPC.recallList,
      recallSearch: IPC.recallSearch,
      recallRead: IPC.recallRead,
      recallOpen: IPC.recallOpen,
      recallHydration: IPC.recallHydration
    })
    expect(HISTORY_DEGRADED_MS).toBe(RENDERER_DEGRADED_MS)
  })

  it('answers the list with the real rows, plus one flagged row where the state needs it', () => {
    const real = [{ file: 'a.md', title: 'A', date: '', mode: 'general', durationMin: 1, participants: [] }]
    expect(listAnswer('rows', real, 0)).toEqual({ kind: 'rows', rows: real })
    const cloud = listAnswer('rows+notDownloaded', real, 0) as { rows: { notDownloaded?: boolean; unavailable?: boolean }[] }
    expect(cloud.rows.slice(0, 1)).toEqual(real)
    expect(cloud.rows.filter((row) => row.notDownloaded)).toHaveLength(1)
    const unreadable = listAnswer('rows+unavailable', real, 0) as { rows: { unavailable?: boolean }[] }
    expect(unreadable.rows.filter((row) => row.unavailable)).toHaveLength(1)
    expect(listAnswer('pending', real, 0)).toEqual({ kind: 'pending' })
    expect(listAnswer('failed', real, 0)).toEqual({ kind: 'failed' })
    expect(() => listAnswer('bogus', real, 0)).toThrow(/unknown list mode/)
  })

  it('anchors the slow search degraded cue to the search request, not the typed character', async () => {
    const state = HISTORY_DESIGN_STATES.find((candidate) => candidate.id === 'slow-with-rows')!
    const calls: string[] = []
    const history = { requests: 0, requestedAt: 0 }
    let searchFillPending = false
    let searchRequestSeen = false
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const main = vi.fn(async (expression: string) => {
      if (expression === 'globalThis.__historyDesign.requests') return history.requests
      if (expression.includes('requests, requestedAt')) return { ...history }
      return true
    })
    const noteRequest = (requestedAt: number) => {
      history.requests += 1
      history.requestedAt = requestedAt
    }
    const wait = vi.fn(async (ms: number) => {
      now += ms
      if (searchFillPending && !searchRequestSeen) {
        searchRequestSeen = true
        noteRequest(now)
      }
    })
    const page = {
      getByText: vi.fn((text: string) => ({
        first: () => ({
          waitFor: vi.fn(async () => {
            calls.push(`text:${text}`)
          })
        })
      })),
      getByRole: vi.fn((role: string) => ({
        filter: ({ hasText }: { hasText: string }) => ({
          first: () => ({
            waitFor: vi.fn(async ({ timeout }: { timeout: number }) => {
              calls.push(`role:${role}:${hasText}:${timeout}`)
              expect(searchRequestSeen).toBe(true)
              now += HISTORY_DEGRADED_MS
            })
          })
        })
      })),
      getByLabel: vi.fn(() => ({
        fill: vi.fn(async () => {
          searchFillPending = true
        })
      }))
    }

    const drive = await driveState(page as never, main as never, state, [{ title: 'Quarterly planning sample' }], {
      wait,
      ensureIdleBar: async () => undefined,
      clickHistory: async () => noteRequest(now)
    })

    expect(drive.requestedAt).toBe(500)
    expect(drive.closedBeforeArm).toBe(true)
    expect(drive.timingsMs).toMatchObject({
      toggleGuard: 450,
      searchFillToSearchRequest: 50,
      searchRequestToCue: HISTORY_DEGRADED_MS
    })
    expect(calls).toContain(`role:status:OneDrive is slow to answer:${STATE_TIMEOUT_MS}`)
  })

  it('warms the first fixture-driven open and screenshot before the judged matrix starts', async () => {
    const events: string[] = []
    const variant = DESIGN_VARIANTS[0]
    const cdp = {
      send: vi.fn(async (command: string, payload?: unknown) => {
        events.push(`cdp:${command}`)
        if (command === 'Emulation.setDeviceMetricsOverride') expect(payload).toEqual({ width: 0, height: 0, deviceScaleFactor: variant.scale, mobile: false })
      })
    }
    const page = {
      emulateMedia: vi.fn(),
      getByLabel: vi.fn(() => ({
        first: () => ({
          isVisible: vi.fn(async () => false)
        })
      })),
      getByText: vi.fn(() => ({
        first: () => ({
          waitFor: vi.fn(async () => {
            events.push('state-reached')
          })
        })
      })),
      getByRole: vi.fn(() => ({
        filter: () => ({
          first: () => ({
            waitFor: vi.fn(async () => {
              events.push('state-reached')
            })
          })
        })
      })),
      screenshot: vi.fn(async () => {
        events.push('screenshot')
      }),
      waitForFunction: vi.fn(async () => {
        events.push('settle-window')
      }),
      evaluate: vi.fn(async () => undefined)
    }
    let requests = 0
    const main = vi.fn(async (expression: string) => {
      if (expression === 'globalThis.__historyDesign.requests') return requests
      if (expression.includes('requests, requestedAt')) return { requests, requestedAt: 100 }
      events.push('apply-or-arm')
      return true
    })

    await warmUp({
      page: page as never,
      cdp: cdp as never,
      main: main as never,
      realRows: [{ title: 'Quarterly planning sample' }],
      deps: {
        wait: async () => undefined,
        ensureIdleBar: async () => events.push('idle'),
        clickHistory: async () => {
          events.push('open-history')
          requests += 1
        }
      }
    })

    expect(page.screenshot).toHaveBeenCalledWith({ scale: 'device' })
    expect(events).toEqual([
      'apply-or-arm',
      'cdp:Emulation.setDefaultBackgroundColorOverride',
      'idle',
      'apply-or-arm',
      'open-history',
      'cdp:Emulation.setDeviceMetricsOverride',
      'settle-window',
      'screenshot',
      'cdp:Emulation.clearDeviceMetricsOverride'
    ])
  })

  it('starts each capture from a closed History view before arming fixtures and reopening it', async () => {
    const state = HISTORY_DESIGN_STATES.find((candidate) => candidate.id === 'slow-with-rows')!
    const events: string[] = []
    const history = { requests: 0, requestedAt: 0 }
    let historyOpen = true
    let searchFillPending = false
    let searchRequestSeen = false

    const main = vi.fn(async (expression: string) => {
      if (expression === 'globalThis.__historyDesign.requests') {
        events.push('read-requests')
        return history.requests
      }
      if (expression.includes('requests, requestedAt')) return { ...history }
      events.push('arm-fixture')
      return true
    })
    const noteRequest = (requestedAt: number) => {
      history.requests += 1
      history.requestedAt = requestedAt
    }
    const wait = vi.fn(async () => {
      if (searchFillPending && !searchRequestSeen) {
        searchRequestSeen = true
        events.push('search-request')
        noteRequest(3_000)
      }
    })
    const searchLocator = {
      first: () => ({
        isVisible: vi.fn(async () => historyOpen)
      }),
      fill: vi.fn(async () => {
        events.push('fill-search')
        searchFillPending = true
      })
    }
    const page = {
      getByText: vi.fn((text: string) => ({
        first: () => ({
          waitFor: vi.fn(async () => {
            events.push(`text:${text}`)
          })
        })
      })),
      getByRole: vi.fn((role: string, options?: { name?: string | RegExp }) => {
        if (role === 'button' && options?.name === 'History') {
          return {
            first: () => ({
              click: vi.fn(async () => {
                events.push('close-history')
                historyOpen = false
              })
            })
          }
        }
        return {
          filter: ({ hasText }: { hasText: string }) => ({
            first: () => ({
              waitFor: vi.fn(async () => {
                events.push(`role:${role}:${hasText}`)
              })
            })
          })
        }
      }),
      getByLabel: vi.fn(() => searchLocator)
    }

    const drive = await driveState(page as never, main as never, state, [{ title: 'Quarterly planning sample' }], {
      wait,
      ensureIdleBar: async () => {
        events.push('idle')
        if (historyOpen) {
          events.push('close-history')
          historyOpen = false
        }
      },
      clickHistory: async () => {
        events.push('open-history')
        historyOpen = true
        noteRequest(2_000)
      }
    })

    expect(events).toEqual([
      'idle',
      'close-history',
      'arm-fixture',
      'read-requests',
      'open-history',
      'text:Quarterly planning sample',
      'read-requests',
      'fill-search',
      'search-request',
      'role:status:OneDrive is slow to answer'
    ])
    expect(drive.closedBeforeArm).toBe(true)
    expect(drive.timingsMs).toEqual(
      expect.objectContaining({
        toggleGuard: expect.any(Number),
        ensureIdle: expect.any(Number),
        closeCheck: expect.any(Number),
        armFixture: expect.any(Number),
        openToListRequest: expect.any(Number),
        listRequestToSearchFill: expect.any(Number),
        searchFillToSearchRequest: expect.any(Number),
        searchRequestToCue: expect.any(Number)
      })
    )
    expect(history.requests).toBe(2)
  })

  it('fails fast instead of arming fixtures while History is still open', async () => {
    const state = HISTORY_DESIGN_STATES.find((candidate) => candidate.id === 'slow-with-rows')!
    const main = vi.fn(async () => true)
    const page = {
      getByLabel: vi.fn(() => ({
        first: () => ({
          isVisible: vi.fn(async () => true)
        })
      }))
    }

    await expect(
      driveState(page as never, main as never, state, [{ title: 'Quarterly planning sample' }], {
        wait: async () => undefined,
        ensureIdleBar: async () => undefined,
        clickHistory: async () => undefined
      })
    ).rejects.toThrow('History was still open before fixture arm')
    expect(main).not.toHaveBeenCalled()
  })

  it("uses the real window size with only the variant's device scale overridden", () => {
    expect(deviceMetricsForVariant(DESIGN_VARIANTS.find((v) => v.id === 'dark-2x-motion')!)).toEqual({
      width: 0,
      height: 0,
      deviceScaleFactor: 2,
      mobile: false
    })
  })
})

describe('WCAG AA contrast (judgeContrast)', () => {
  it('computes the WCAG ratio: 21:1 for black on white, about 4.48:1 for #777 on white', () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5)
    expect(contrastRatio([119, 119, 119], WHITE)).toBeCloseTo(4.48, 2)
  })

  it('needs 4.5:1 for body text, so #777 on white fails and #767676 passes', () => {
    const layers = [[255, 255, 255, 1]]
    expect(judgeContrast(textSample({ fg: [119, 119, 119, 1], layers }), WHITE)).toMatchObject({ status: 'fail', required: 4.5 })
    expect(judgeContrast(textSample({ fg: [118, 118, 118, 1], layers }), WHITE)).toMatchObject({ status: 'pass' })
  })

  it('needs 3:1 for large text and for a named icon', () => {
    const layers = [[255, 255, 255, 1]]
    const grey = [140, 140, 140, 1] // about 3.4:1 on white
    expect(judgeContrast(textSample({ fg: grey, layers }), WHITE).status).toBe('fail')
    expect(judgeContrast(textSample({ fg: grey, layers, fontSizePx: 24 }), WHITE)).toMatchObject({ status: 'pass', required: 3 })
    expect(judgeContrast(textSample({ fg: grey, layers, fontSizePx: 19, fontWeight: 700 }), WHITE).status).toBe('pass')
    expect(judgeContrast(textSample({ fg: grey, layers, fontSizePx: 19, fontWeight: 400 }), WHITE).status).toBe('fail')
    expect(judgeContrast(textSample({ kind: 'icon', fg: grey, layers }), WHITE)).toMatchObject({ status: 'pass', required: 3 })
  })

  it('composites translucent glass over the backdrop, so light ink on thin glass fails over a white desktop', () => {
    const glass = textSample({ fg: [255, 255, 255, 0.74], layers: [[20, 20, 30, 0.2]] })
    expect(judgeContrast(glass, BACKDROPS.dark).status).toBe('pass')
    expect(judgeContrast(glass, BACKDROPS.light).status).toBe('fail')
    expect(composite([0, 0, 0, 0.5], WHITE)).toEqual([127.5, 127.5, 127.5])
  })

  // History's purple pills (Intelligence, related-note chips): the soft accent fill on the panel glass
  // (tokens.css: scrim, strong fill, white tint). The bright accent is a fill colour; the accent text
  // colour is the one that clears AA as text on it, over either backdrop.
  it('fails the bright accent as small text on the accent pill over the panel glass, and passes the accent text colour', () => {
    const layers = [
      [13, 4, 28, 0.68],
      [28, 11, 52, 0.8],
      [255, 255, 255, 0.06],
      [127, 0, 218, 0.18]
    ]
    for (const backdrop of [BACKDROPS.light, BACKDROPS.dark]) {
      expect(judgeContrast(textSample({ fg: [166, 77, 255, 1], layers, fontSizePx: 11, fontWeight: 600 }), backdrop).status).toBe('fail')
      expect(judgeContrast(textSample({ fg: [179, 136, 240, 1], layers, fontSizePx: 11, fontWeight: 600 }), backdrop).status).toBe('pass')
    }
  })

  it('applies inherited opacity to the text', () => {
    const sample = textSample({ fg: [255, 255, 255, 1], layers: [[0, 0, 0, 1]] })
    expect(judgeContrast(sample, BLACK).status).toBe('pass')
    expect(judgeContrast({ ...sample, opacity: 0.2 }, BLACK).status).toBe('fail')
  })

  it('exempts an inactive control and never passes text on an image or gradient', () => {
    const faint = textSample({ fg: [40, 40, 40, 1] })
    expect(judgeContrast({ ...faint, disabled: true }, BLACK).status).toBe('exempt')
    expect(judgeContrast({ ...faint, bgImage: true }, BLACK).status).toBe('indeterminate')
  })
})

describe('glass background layers (solidGradientLayers)', () => {
  // Enough of a CSS colour parser for computed rgb()/rgba() values.
  const toRgba = (css: string): number[] => {
    if (css === 'transparent') return [0, 0, 0, 0]
    const [r, g, b, a = 1] = css.replace(/^rgba?\(|\)$/g, '').split(',').map(Number)
    return [r, g, b, a]
  }

  it("reduces the overlay glass's linear-gradient(c, c) fills to their colours, topmost first", () => {
    const glass = 'linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04)), linear-gradient(rgba(40, 30, 60, 0.6), rgba(40, 30, 60, 0.6))'
    expect(solidGradientLayers(glass, toRgba)).toEqual([
      [255, 255, 255, 0.04],
      [40, 30, 60, 0.6]
    ])
    expect(solidGradientLayers('linear-gradient(90deg, rgb(1, 2, 3) 0%, rgb(1, 2, 3) 100%)', toRgba)).toEqual([[1, 2, 3, 1]])
  })

  it('reads a whole colour function with nested parentheses as one colour (calc() alpha, color-mix)', () => {
    // What the probe resolves each whole token to; anything else (a fragment like `calc(0.8 * 1)`) is unreadable.
    const resolved: Record<string, number[]> = {
      'rgb(28 11 52 / calc(0.8 * 1))': [28, 11, 52, 0.8],
      'color-mix(in oklab, rgb(255, 255, 255) 6%, transparent)': [255, 255, 255, 0.06]
    }
    const probe = (css: string): number[] => resolved[css] ?? [Number.NaN, Number.NaN, Number.NaN, Number.NaN]
    const glass =
      'linear-gradient(color-mix(in oklab, rgb(255, 255, 255) 6%, transparent), color-mix(in oklab, rgb(255, 255, 255) 6%, transparent)), linear-gradient(rgb(28 11 52 / calc(0.8 * 1)), rgb(28 11 52 / calc(0.8 * 1)))'
    expect(solidGradientLayers(glass, probe)).toEqual([
      [255, 255, 255, 0.06],
      [28, 11, 52, 0.8]
    ])
  })

  it("skips the empty image of the glass's final colour-only layer (computed as `none`)", () => {
    // `background: linear-gradient(tint), linear-gradient(fill), var(--glass-scrim-bar)` computes its
    // background-image with one entry per layer; the last layer is only a colour, so its image is `none`.
    const glass = 'linear-gradient(rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.06)), linear-gradient(rgba(28, 11, 52, 0.8), rgba(28, 11, 52, 0.8)), none'
    expect(solidGradientLayers(glass, toRgba)).toEqual([
      [255, 255, 255, 0.06],
      [28, 11, 52, 0.8]
    ])
    expect(solidGradientLayers('none, url("noise.png")', toRgba)).toBeNull()
  })

  it('gives up on a layer whose colour cannot be read', () => {
    const unreadable = (): number[] => [Number.NaN, Number.NaN, Number.NaN, Number.NaN]
    expect(solidGradientLayers('linear-gradient(rgb(1, 2, 3), rgb(1, 2, 3))', unreadable)).toBeNull()
  })

  it('names the background it could not read in the indeterminate reason', () => {
    const sample = textSample({ bgImage: 'conic-gradient(red, blue)' })
    expect(judgeContrast(sample, BLACK)).toEqual({ status: 'indeterminate', reason: 'background image or gradient behind the text: conic-gradient(red, blue)' })
  })

  it('has no layers for none, and gives up on a real gradient or an image', () => {
    expect(solidGradientLayers('none', toRgba)).toEqual([])
    expect(solidGradientLayers('linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))', toRgba)).toBeNull()
    expect(solidGradientLayers('url("noise.png")', toRgba)).toBeNull()
    expect(solidGradientLayers('linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0)), url("noise.png")', toRgba)).toBeNull()
  })
})

describe('clipping (judgeClipping)', () => {
  it('passes text that fits', () => {
    expect(judgeClipping(textSample(), viewport)).toEqual({ failures: [], truncated: false })
  })

  it('fails text cut off without an ellipsis, and reports an ellipsis truncation without failing it', () => {
    const box = { overflowX: 'hidden', overflowY: 'visible', textOverflow: 'clip', scrollWidth: 180, clientWidth: 100, scrollHeight: 20, clientHeight: 20 }
    expect(judgeClipping(textSample({ box }), viewport).failures).toEqual(['clipped-x'])
    expect(judgeClipping(textSample({ box: { ...box, textOverflow: 'ellipsis' } }), viewport)).toEqual({ failures: [], truncated: true })
    expect(judgeClipping(textSample({ box: { ...box, scrollWidth: 100, overflowY: 'hidden', scrollHeight: 40 } }), viewport).failures).toEqual(['clipped-y'])
  })

  it('fails text partly outside the window', () => {
    expect(judgeClipping(textSample({ rect: { left: 350, right: 420, top: 0, bottom: 20 } }), viewport).failures).toEqual(['outside-window'])
  })

  it('fails text partly outside an ancestor that hides overflow, unless that ancestor ellipsizes; ignores text it hides entirely', () => {
    const clipAncestor = { left: 0, right: 80, top: 0, bottom: 100, overflowX: 'hidden', overflowY: 'hidden', textOverflow: 'clip' }
    expect(judgeClipping(textSample({ clipAncestor }), viewport).failures).toEqual(['clipped-by-ancestor'])
    expect(judgeClipping(textSample({ clipAncestor: { ...clipAncestor, textOverflow: 'ellipsis' } }), viewport)).toEqual({ failures: [], truncated: true })
    expect(judgeClipping(textSample({ clipAncestor, rect: { left: 90, right: 150, top: 10, bottom: 30 } }), viewport).failures).toEqual([])
  })
})

describe('one capture (judgeCapture) and the report verdict (designVerdict)', () => {
  const notDownloaded = HISTORY_DESIGN_STATES.find((s) => s.id === 'not-downloaded')!
  const loading = HISTORY_DESIGN_STATES.find((s) => s.id === 'loading')!
  const collected = { viewport, samples: [textSample()] }
  const roles = notDownloaded.roles.map((role) => ({ ...role, found: true }))
  const tabOrder = [{ name: 'Download and open Weekly sync', role: 'button' }]

  it('passes a state whose text, roles and keyboard actions all check out', () => {
    expect(judgeCapture({ state: notDownloaded, variant: dark, collected, roles, tabOrder, drive: {} })).toMatchObject({ verdict: 'PASS', problems: [] })
  })

  it('fails on a contrast failure, a clipped element, a missing role or an action Tab cannot reach', () => {
    const faint = { viewport, samples: [textSample({ fg: [30, 30, 30, 1] })] }
    expect(judgeCapture({ state: notDownloaded, variant: dark, collected: faint, roles, tabOrder, drive: {} }).contrast.failures).toHaveLength(1)
    const clipped = { viewport, samples: [textSample({ rect: { left: -20, right: 50, top: 0, bottom: 20 } })] }
    expect(judgeCapture({ state: notDownloaded, variant: dark, collected: clipped, roles, tabOrder, drive: {} }).verdict).toBe('FAIL')
    const noIcon = roles.map((role) => (role.role === 'img' ? { ...role, found: false } : role))
    expect(judgeCapture({ state: notDownloaded, variant: dark, collected, roles: noIcon, tabOrder, drive: {} }).missingRoles).toEqual([
      { role: 'img', name: NOT_DOWNLOADED_TEXT, text: undefined }
    ])
    const unreachable = judgeCapture({ state: notDownloaded, variant: dark, collected, roles, tabOrder: [], drive: {} })
    expect(unreachable.verdict).toBe('FAIL')
    expect(unreachable.missingKeyboard).toHaveLength(1)
  })

  it('judges the same text against each appearance backdrop', () => {
    const light = DESIGN_VARIANTS.find((v) => v.id === 'light-1x-motion')!
    const thin = { viewport, samples: [textSample({ fg: [255, 255, 255, 0.74], layers: [[20, 20, 30, 0.2]] })] }
    expect(judgeCapture({ state: notDownloaded, variant: dark, collected: thin, roles, tabOrder, drive: {} }).verdict).toBe('PASS')
    expect(judgeCapture({ state: notDownloaded, variant: light, collected: thin, roles, tabOrder, drive: {} }).verdict).toBe('FAIL')
  })

  it(`fails a loading capture taken at or after ${HISTORY_DEGRADED_MS} ms, and a state that was never reached`, () => {
    expect(judgeCapture({ state: loading, variant: dark, collected, roles: [], tabOrder: null, drive: { capturedAfterMs: 600 } }).verdict).toBe('PASS')
    expect(judgeCapture({ state: loading, variant: dark, collected, roles: [], tabOrder: null, drive: { capturedAfterMs: 2000 } }).verdict).toBe('FAIL')
    const unreached = judgeCapture({ state: loading, variant: dark, collected: null, roles: [], tabOrder: null, drive: { error: 'History did not request its list' } })
    expect(unreached.problems).toContain('state not reached: History did not request its list')
  })

  it('reads the renderer History transitions {from, to, committedAtMs} from the audit records', () => {
    const records = [
      { event: 'app.started' },
      { event: 'history.transition', from: 'idle', to: 'history', committedAtMs: 5, ts: 'x' },
      { event: 'history.transition', from: 'history', to: 'history', committedAtMs: 9 }
    ]
    expect(historyTransitions(records)).toEqual([
      { from: 'idle', to: 'history', committedAtMs: 5 },
      { from: 'history', to: 'history', committedAtMs: 9 }
    ])
  })

  it('is INCOMPLETE until every capture ran, FAIL on any failed capture or no History transition, else PASS', () => {
    const pass = { verdict: 'PASS' }
    const transitions = [{ from: 'idle', to: 'history', committedAtMs: 1 }]
    expect(designVerdict({ captures: [pass], transitions, expected: 2 })).toBe('INCOMPLETE')
    expect(designVerdict({ captures: [pass, { verdict: 'FAIL' }], transitions, expected: 2 })).toBe('FAIL')
    expect(designVerdict({ captures: [pass, pass], transitions: [], expected: 2 })).toBe('FAIL')
    expect(designVerdict({ captures: [pass, pass], transitions, expected: 2 })).toBe('PASS')
  })

  it('reports the real cloud row as BLOCKED_EXTERNAL with an unblock step', () => {
    expect(BLOCKED_EXTERNAL_ROWS).toEqual([expect.objectContaining({ verdict: 'BLOCKED_EXTERNAL', unblockStep: expect.stringContaining('scripts/qa/st-1.mjs') })])
  })
})
