/**
 * The History design-evidence matrix (M2-0032) and its automated checks, kept free of any app or browser
 * so they are unit-tested (history-design-capture.test.ts). scripts/qa/history-design-capture.mjs drives
 * the real packaged renderer through every state below in every variant and judges each capture here.
 *
 * Invariants:
 *   - Every state is captured in every variant: light/dark appearance x 1x/2x x motion allowed/reduced.
 *   - Contrast follows WCAG 2.2 AA: 4.5:1 for text, 3:1 for large text (>= 24 px, or >= 18.66 px bold) and
 *     for a named icon (1.4.11). An inactive control is exempt (1.4.3); a background the DOM cannot reduce
 *     to solid colours (an image or a multi-colour gradient) is reported indeterminate, never passed.
 *   - The overlay window is transparent, so what sits behind its glass is the desktop. Each appearance
 *     composites the page over its own backdrop (the screenshot and the contrast maths use the same one):
 *     white for light, the dark window background for dark.
 *   - Clipping fails text cut off without an ellipsis, text partly outside the window, and text partly
 *     outside the nearest ancestor that hides its overflow. Text truncated with an ellipsis is reported,
 *     not failed; an element entirely outside its clipping ancestor is hidden, not clipped.
 *   - The verdict is PASS only when every capture ran and every check passed.
 */

/** IPC channel names from src/shared/ipc.ts (IPC.recallList and the rest); the test pins them. */
export const IPC_CHANNELS = Object.freeze({
  recallList: 'recall:list',
  recallSearch: 'recall:search',
  recallRead: 'recall:read',
  recallOpen: 'recall:open',
  recallHydration: 'recall:hydration'
})

/** list-status.ts's HISTORY_DEGRADED_MS: the list is past 'loading' this long after its request. */
export const HISTORY_DEGRADED_MS = 2000

export const BACKDROPS = Object.freeze({
  light: Object.freeze([255, 255, 255]),
  dark: Object.freeze([30, 30, 30])
})

export const DESIGN_VARIANTS = Object.freeze(
  ['light', 'dark'].flatMap((appearance) =>
    [1, 2].flatMap((scale) =>
      ['no-preference', 'reduce'].map((motion) => Object.freeze({ id: `${appearance}-${scale}x-${motion === 'reduce' ? 'reduced-motion' : 'motion'}`, appearance, scale, motion }))
    )
  )
)

/** The variant whose captures also walk the keyboard Tab order (keyboard reach does not depend on colour). */
export const KEYBOARD_VARIANT_ID = 'dark-1x-motion'

const DOWNLOAD_ACTION = /^Download and open /
const RETRY_DOWNLOAD_ACTION = /^Retry downloading /
const RETRY_LIST_ACTION = 'Retry loading meetings'

/**
 * Every state this ticket designs. `list`/`search` answer History's recallList/recallSearch with the real
 * rows (`rows`), the real rows plus one cloud-only row (`rows+notDownloaded`) or one unreadable row
 * (`rows+unavailable`), never (`pending`) or with an error (`failed`). `read` is what an explicit open
 * reports: a download that keeps running, or one that fails. `roles` must be in the History view's
 * accessibility tree; `keyboard` must be reachable with Tab.
 */
export const HISTORY_DESIGN_STATES = Object.freeze([
  {
    id: 'loading',
    title: `Loading, captured before ${HISTORY_DEGRADED_MS} ms`,
    list: 'pending',
    roles: [],
    keyboard: []
  },
  {
    id: 'slow',
    title: 'Source slow past 2 s: degraded banner, no spinner, no claim of an empty list',
    list: 'pending',
    roles: [{ role: 'status', text: 'OneDrive is slow to answer' }],
    keyboard: []
  },
  {
    id: 'slow-with-rows',
    title: 'Search slow past 2 s: degraded banner over the rows already shown',
    list: 'rows',
    search: 'pending',
    roles: [{ role: 'status', text: 'OneDrive is slow to answer' }],
    keyboard: []
  },
  {
    id: 'failed',
    title: 'Source failed: alert banner with Retry',
    list: 'failed',
    roles: [
      { role: 'alert', text: 'Could not load your meetings' },
      { role: 'button', name: RETRY_LIST_ACTION }
    ],
    keyboard: [RETRY_LIST_ACTION]
  },
  {
    id: 'rows',
    title: 'Local meetings, no degraded state',
    list: 'rows',
    roles: [],
    keyboard: []
  },
  {
    id: 'not-downloaded',
    title: "Row 'In OneDrive, not downloaded' with its explicit Download action",
    list: 'rows+notDownloaded',
    roles: [
      { role: 'img', name: 'In OneDrive, not downloaded' },
      { role: 'button', name: DOWNLOAD_ACTION }
    ],
    keyboard: [DOWNLOAD_ACTION]
  },
  {
    id: 'hydrating',
    title: 'Explicit open downloading one file: progress chip, action disabled',
    list: 'rows+notDownloaded',
    read: 'hydrating',
    open: true,
    roles: [{ role: 'status', text: 'Downloading…' }],
    keyboard: []
  },
  {
    id: 'download-failed',
    title: 'Explicit open failed: Download failed chip with Retry',
    list: 'rows+notDownloaded',
    read: 'failed',
    open: true,
    roles: [
      { role: 'status', text: 'Download failed' },
      { role: 'button', name: RETRY_DOWNLOAD_ACTION }
    ],
    keyboard: [RETRY_DOWNLOAD_ACTION]
  },
  {
    id: 'unavailable',
    title: "Row 'Unavailable' with the degraded banner and Retry",
    list: 'rows+unavailable',
    roles: [
      { role: 'img', name: 'Unavailable' },
      { role: 'status', text: 'could not be read right now' },
      { role: 'button', name: RETRY_LIST_ACTION }
    ],
    keyboard: [RETRY_LIST_ACTION]
  }
])

/** The two synthetic rows that stand in for a cloud provider's files (no hosted runner has one). */
export function fixtureRows(nowMs) {
  const day = 24 * 60 * 60 * 1000
  const base = { mode: 'general', durationMin: 0, participants: [], locked: true }
  return {
    notDownloaded: { ...base, file: '2026-01-05_100000-weekly-sync.md', title: 'Weekly sync', date: new Date(nowMs - day).toISOString(), notDownloaded: true },
    unavailable: { ...base, file: '2026-01-04_090000-design-review.md', title: 'Design review', date: new Date(nowMs - 2 * day).toISOString(), unavailable: true }
  }
}

/** What recallList answers in `mode`, given the real rows the app listed. */
export function listAnswer(mode, realRows, nowMs) {
  const extra = fixtureRows(nowMs)
  if (mode === 'rows') return { kind: 'rows', rows: realRows }
  if (mode === 'rows+notDownloaded') return { kind: 'rows', rows: [...realRows, extra.notDownloaded] }
  if (mode === 'rows+unavailable') return { kind: 'rows', rows: [...realRows, extra.unavailable] }
  if (mode === 'pending' || mode === 'failed') return { kind: mode }
  throw new Error(`unknown list mode ${JSON.stringify(mode)}`)
}

/** The loading state is judged against a 2 s request window, so harness resize settling must not spend it. */
export function captureNeedsResizeSettle(state) {
  return state.id !== 'loading'
}

/**
 * A computed `background-image` as solid colour layers, topmost first: [] for 'none', null when any layer
 * is not one colour (a real gradient, an image). The overlay glass paints each translucent fill as
 * linear-gradient(c, c), so such a layer is one colour; a `none` entry (the image of a colour-only final
 * layer in the `background` shorthand) paints nothing and is skipped. A colour token is a whole colour function with its
 * nested parentheses (rgb(28 11 52 / calc(0.8 * 1)), color-mix(in oklab, ...)), a hex colour or
 * `transparent`. `toRgba` turns a CSS colour into [r, g, b, alpha], with a non-finite channel for one it
 * cannot read, which makes the layer unknown (null). Self-contained: the capture also runs it inside the
 * renderer.
 */
export function solidGradientLayers(backgroundImage, toRgba) {
  if (!backgroundImage || backgroundImage === 'none') return []
  const layers = []
  let depth = 0
  let start = 0
  for (let i = 0; i <= backgroundImage.length; i++) {
    const ch = backgroundImage[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (i === backgroundImage.length || (ch === ',' && depth === 0)) {
      layers.push(backgroundImage.slice(start, i).trim())
      start = i + 1
    }
  }
  const colors = []
  for (const layer of layers) {
    if (layer === 'none') continue
    if (!/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/.test(layer)) return null
    const tokens = []
    const colorStart = /(?<![\w-])(?:rgba?|hsla?|color-mix|color|oklab|oklch|lab|lch|hwb)\(|#[0-9a-fA-F]{3,8}\b|\btransparent\b/g
    for (let match = colorStart.exec(layer); match; match = colorStart.exec(layer)) {
      let end = colorStart.lastIndex
      if (match[0].endsWith('(')) {
        for (let open = 1; end < layer.length && open > 0; end++) {
          if (layer[end] === '(') open++
          else if (layer[end] === ')') open--
        }
        colorStart.lastIndex = end
      }
      tokens.push(layer.slice(match.index, end))
    }
    if (tokens.length === 0) return null
    const values = tokens.map(toRgba)
    if (!values.every((value) => value.length === 4 && value.every(Number.isFinite))) return null
    if (!values.every((value) => value.every((c, i) => Math.abs(c - values[0][i]) < 1e-6))) return null
    colors.push(values[0])
  }
  return colors
}

function channel(value) {
  return value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of an sRGB colour [r, g, b] (0-255). */
export function relativeLuminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `top` [r, g, b, alpha 0-1] painted over the opaque `bottom` [r, g, b]. */
export function composite(top, bottom) {
  const alpha = top[3] ?? 1
  return [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha))
}

function isLargeText(sample) {
  return sample.fontSizePx >= 24 || (sample.fontSizePx >= 18.66 && sample.fontWeight >= 700)
}

export function requiredRatio(sample) {
  return sample.kind === 'icon' || isLargeText(sample) ? 3 : 4.5
}

/**
 * One sample's contrast: `fg` and `layers` (outermost first) are [r, g, b, alpha]; `opacity` is the
 * product of the element's and its ancestors' opacity.
 */
export function judgeContrast(sample, backdrop) {
  if (sample.disabled) return { status: 'exempt', reason: 'inactive control (WCAG 1.4.3)' }
  if (sample.bgImage) {
    const behind = typeof sample.bgImage === 'string' ? `: ${sample.bgImage.slice(0, 160)}` : ''
    return { status: 'indeterminate', reason: `background image or gradient behind the text${behind}` }
  }
  const bg = sample.layers.reduce((under, layer) => composite(layer, under), [...backdrop])
  const fg = composite([sample.fg[0], sample.fg[1], sample.fg[2], (sample.fg[3] ?? 1) * (sample.opacity ?? 1)], bg)
  const ratio = contrastRatio(fg, bg)
  const required = requiredRatio(sample)
  return { status: ratio >= required ? 'pass' : 'fail', ratio: Math.round(ratio * 100) / 100, required }
}

const HIDES_OVERFLOW = new Set(['hidden', 'clip'])
const EDGE_PX = 1

/** One sample's clipping failures and whether it is ellipsis-truncated (reported, allowed). */
export function judgeClipping(sample, viewport) {
  const failures = []
  let truncated = false
  const { rect, box, clipAncestor } = sample
  if (box && HIDES_OVERFLOW.has(box.overflowX) && box.scrollWidth > box.clientWidth + EDGE_PX) {
    if (box.textOverflow === 'ellipsis') truncated = true
    else failures.push('clipped-x')
  }
  if (box && HIDES_OVERFLOW.has(box.overflowY) && box.scrollHeight > box.clientHeight + EDGE_PX) failures.push('clipped-y')
  if (rect.left < -EDGE_PX || rect.right > viewport.width + EDGE_PX) failures.push('outside-window')
  if (clipAncestor) {
    const a = clipAncestor
    const hidden = rect.right <= a.left || rect.left >= a.right || rect.bottom <= a.top || rect.top >= a.bottom
    const outX = HIDES_OVERFLOW.has(a.overflowX) && (rect.left < a.left - EDGE_PX || rect.right > a.right + EDGE_PX)
    const outY = HIDES_OVERFLOW.has(a.overflowY) && (rect.top < a.top - EDGE_PX || rect.bottom > a.bottom + EDGE_PX)
    if (!hidden && (outX || outY)) {
      if (outX && !outY && a.textOverflow === 'ellipsis') truncated = true
      else failures.push('clipped-by-ancestor')
    }
  }
  return { failures, truncated }
}

/** Judges one capture's collected samples, roles and Tab order. */
export function judgeCapture({ state, variant, collected, roles, tabOrder, drive }) {
  const backdrop = BACKDROPS[variant.appearance]
  const contrast = { checked: 0, failures: [], exempt: 0, indeterminate: [] }
  const clipping = { checked: 0, failures: [], truncated: 0 }
  for (const sample of collected?.samples ?? []) {
    const c = judgeContrast(sample, backdrop)
    contrast.checked++
    if (c.status === 'fail') contrast.failures.push({ label: sample.label, kind: sample.kind, ratio: c.ratio, required: c.required })
    else if (c.status === 'exempt') contrast.exempt++
    else if (c.status === 'indeterminate') contrast.indeterminate.push({ label: sample.label, reason: c.reason })
    const k = judgeClipping(sample, collected.viewport)
    clipping.checked++
    if (k.truncated) clipping.truncated++
    if (k.failures.length > 0) clipping.failures.push({ label: sample.label, failures: k.failures })
  }
  const missingRoles = (roles ?? []).filter((role) => !role.found).map(({ role, name, text }) => ({ role, name: name === undefined ? undefined : String(name), text }))
  const missingKeyboard =
    tabOrder === null
      ? []
      : state.keyboard.filter((wanted) => !tabOrder.some((stop) => (typeof wanted === 'string' ? stop.name === wanted : wanted.test(stop.name)))).map(String)
  const problems = []
  if (drive?.error) problems.push(`state not reached: ${drive.error}`)
  if (state.id === 'loading' && drive && !drive.error && !(drive.capturedAfterMs < HISTORY_DEGRADED_MS)) {
    problems.push(`loading captured ${drive.capturedAfterMs} ms after the request, past ${HISTORY_DEGRADED_MS} ms`)
  }
  if (!collected || collected.samples.length === 0) problems.push('no text was found in the History view')
  if (contrast.failures.length > 0) problems.push(`${contrast.failures.length} contrast failure(s)`)
  if (contrast.indeterminate.length > 0) {
    const [first] = contrast.indeterminate
    problems.push(`${contrast.indeterminate.length} contrast sample(s) indeterminate, first "${first.label}": ${first.reason}`)
  }
  if (clipping.failures.length > 0) {
    const [first] = clipping.failures
    problems.push(`${clipping.failures.length} clipped element(s), first "${first.label}": ${first.failures.join(', ')}`)
  }
  if (missingRoles.length > 0) problems.push(`${missingRoles.length} accessibility role(s) missing`)
  if (missingKeyboard.length > 0) problems.push(`${missingKeyboard.length} action(s) not reachable by keyboard`)
  return { state: state.id, variant: variant.id, verdict: problems.length === 0 ? 'PASS' : 'FAIL', problems, contrast, clipping, missingRoles, missingKeyboard }
}

/** The renderer's committed History transitions, read from the profile's audit records. */
export function historyTransitions(auditRecords) {
  return auditRecords
    .filter((record) => record.event === 'history.transition')
    .map(({ from, to, committedAtMs }) => ({ from, to, committedAtMs }))
}

/** Rows a hosted runner cannot exercise, with the exact step that unblocks each. */
export const BLOCKED_EXTERNAL_ROWS = Object.freeze([
  {
    row: 'real-cloud-not-downloaded',
    verdict: 'BLOCKED_EXTERNAL',
    reason:
      "The 'not downloaded', 'hydrating' and 'download failed' captures render a synthetic cloud-only row served through History's own IPC; a hosted runner has no signed-in cloud provider with evicted files.",
    unblockStep:
      'On the macOS QA account with OneDrive signed in and a folder of evicted (Free up space) meeting files, run scripts/qa/st-1.mjs against the verified candidate with --fixtures dataless --history --cloud-dir <that folder> --main-log <candidate main.log>, which proves main lists them as not downloaded; then, in the same candidate pointed at that folder, open History, select Download on one row, and attach light and dark screenshots of the row before and during its download to the evidence record.'
  }
])

/** The report's verdict: INCOMPLETE until every state ran in every variant, then FAIL on any problem. */
export function designVerdict({ captures, transitions, expected }) {
  if (captures.length < expected) return 'INCOMPLETE'
  if (captures.some((capture) => capture.verdict !== 'PASS')) return 'FAIL'
  if (!transitions.some((transition) => transition.to === 'history')) return 'FAIL'
  return 'PASS'
}
