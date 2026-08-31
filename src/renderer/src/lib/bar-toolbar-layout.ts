/**
 * Bar toolbar reserved-box layout. Production overlay width is BAR_WIDTH 880.
 * Overlap is a ship blocker. See DESIGN.md and docs/design/BAR-PILL.md.
 */

/** main `BAR_WIDTH` — Tony's live Bar overlay. */
export const BAR_OVERLAY_WIDTH_PX = 880

export const BAR_TOOLBAR_PAD_X_PX = 20
export const BAR_TOOLBAR_GAP_PX = 10
export const BAR_TOOLBAR_ACTIONS_GAP_PX = 6
export const BAR_TOOLBAR_TIMER_GAP_PX = 8
export const BAR_TOOLBAR_ROW_HEIGHT_PX = 41

/** Locked Settings M. Must stay 30×30 on idle and listen. */
export const BAR_TOOLBAR_MARK_PX = 30

/** Intrinsic listening chrome that must not shrink under the icon cluster. */
export const BAR_TOOLBAR_TIMER_MIN_PX = 72
export const BAR_TOOLBAR_TRANSCRIPT_MIN_PX = 108
export const BAR_TOOLBAR_TRANSCRIPT_ICON_PX = 32
export const BAR_TOOLBAR_ORB_PX = 41
export const BAR_TOOLBAR_CHEVRON_PX = 36
export const BAR_TOOLBAR_HISTORY_MIN_PX = 88

export type ToolbarRect = {
  name: string
  x: number
  y: number
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
  getBoundingClientRect(): ToolbarRect
}

export type ToolbarChild = {
  name: string
  getBoundingClientRect(): ToolbarRect
}

function box(name: string, left: number, width: number, height = BAR_TOOLBAR_ROW_HEIGHT_PX): ToolbarRect {
  const rect: ToolbarRect = {
    name,
    x: left,
    y: 0,
    width,
    height,
    left,
    right: left + width,
    top: 0,
    bottom: height,
    getBoundingClientRect() {
      return rect
    }
  }
  return rect
}

/** Axis-aligned overlap. Touching edges do not count (flex gap is a reserved empty strip). */
export function rectsIntersect(
  a: Pick<ToolbarRect, 'left' | 'right' | 'top' | 'bottom'>,
  b: Pick<ToolbarRect, 'left' | 'right' | 'top' | 'bottom'>
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

export function overlappingPairs(rects: ToolbarRect[]): Array<[string, string]> {
  const hits: Array<[string, string]> = []
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsIntersect(rects[i], rects[j])) hits.push([rects[i].name, rects[j].name])
    }
  }
  return hits
}

function actionsWidth(listening: boolean, transcriptCopy: boolean): number {
  if (!listening) {
    return BAR_TOOLBAR_HISTORY_MIN_PX + BAR_TOOLBAR_ACTIONS_GAP_PX + BAR_TOOLBAR_ORB_PX + BAR_TOOLBAR_ACTIONS_GAP_PX + BAR_TOOLBAR_CHEVRON_PX
  }
  const transcript = transcriptCopy ? BAR_TOOLBAR_TRANSCRIPT_MIN_PX : BAR_TOOLBAR_TRANSCRIPT_ICON_PX
  return (
    BAR_TOOLBAR_TIMER_MIN_PX +
    BAR_TOOLBAR_ACTIONS_GAP_PX +
    transcript +
    BAR_TOOLBAR_ACTIONS_GAP_PX +
    BAR_TOOLBAR_ORB_PX +
    BAR_TOOLBAR_ACTIONS_GAP_PX +
    BAR_TOOLBAR_CHEVRON_PX
  )
}

/**
 * Flex the production toolbar at `overlayWidth`.
 * Mark is locked. Actions are flex-none. Tools take leftover space.
 * If actions would overflow, Transcript drops to icon-only before anything may overlap.
 */
export function layoutToolbarRow(opts: {
  listening: boolean
  overlayWidth?: number
}): { children: ToolbarChild[]; rects: ToolbarRect[]; transcriptCopy: boolean } {
  const overlayWidth = opts.overlayWidth ?? BAR_OVERLAY_WIDTH_PX
  const inner = overlayWidth - BAR_TOOLBAR_PAD_X_PX * 2
  const gaps = BAR_TOOLBAR_GAP_PX * 2
  const toolsMin = 0

  let transcriptCopy = true
  let actions = actionsWidth(opts.listening, transcriptCopy)
  let leftover = inner - BAR_TOOLBAR_MARK_PX - actions - gaps
  if (opts.listening && leftover < toolsMin) {
    transcriptCopy = false
    actions = actionsWidth(true, false)
    leftover = inner - BAR_TOOLBAR_MARK_PX - actions - gaps
  }

  if (leftover < 0) {
    throw new Error(
      `Bar toolbar overflows at ${overlayWidth}px (leftover ${leftover}). Overlap is a ship blocker.`
    )
  }

  let x = BAR_TOOLBAR_PAD_X_PX
  const rects: ToolbarRect[] = []

  rects.push(box('mark', x, BAR_TOOLBAR_MARK_PX, BAR_TOOLBAR_MARK_PX))
  x += BAR_TOOLBAR_MARK_PX + BAR_TOOLBAR_GAP_PX

  rects.push(box('tools', x, leftover))
  x += leftover + BAR_TOOLBAR_GAP_PX

  if (opts.listening) {
    rects.push(box('timer', x, BAR_TOOLBAR_TIMER_MIN_PX))
    x += BAR_TOOLBAR_TIMER_MIN_PX + BAR_TOOLBAR_ACTIONS_GAP_PX
    const transcriptW = transcriptCopy ? BAR_TOOLBAR_TRANSCRIPT_MIN_PX : BAR_TOOLBAR_TRANSCRIPT_ICON_PX
    rects.push(box('transcript', x, transcriptW))
    x += transcriptW + BAR_TOOLBAR_ACTIONS_GAP_PX
  } else {
    rects.push(box('history', x, BAR_TOOLBAR_HISTORY_MIN_PX))
    x += BAR_TOOLBAR_HISTORY_MIN_PX + BAR_TOOLBAR_ACTIONS_GAP_PX
  }

  rects.push(box('orb', x, BAR_TOOLBAR_ORB_PX, BAR_TOOLBAR_ORB_PX))
  x += BAR_TOOLBAR_ORB_PX + BAR_TOOLBAR_ACTIONS_GAP_PX
  rects.push(box('chevron', x, BAR_TOOLBAR_CHEVRON_PX))

  return {
    transcriptCopy,
    rects,
    children: rects.map((rect) => ({
      name: rect.name,
      getBoundingClientRect: () => rect.getBoundingClientRect()
    }))
  }
}

export const TOOLBAR_MEASURE_SELECTOR = [
  '[data-bar-mark]',
  '[data-bar-tools]',
  '[data-bar-listen-timer]',
  '[data-bar-transcript]',
  '[data-bar-history]',
  '[data-bar-pill-orb]',
  '[data-bar-chevron]'
].join(',')

export type MeasuredToolbarChild = {
  name: string
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

/** Browser helper: reserved toolbar boxes via getBoundingClientRect. */
export function measureToolbarChildren(root: ParentNode): MeasuredToolbarChild[] {
  const nodes = root.querySelectorAll(TOOLBAR_MEASURE_SELECTOR)
  return Array.from(nodes).map((node) => {
    const el = node as Element & { getBoundingClientRect(): DOMRect }
    const r = el.getBoundingClientRect()
    const name =
      (el.getAttribute('data-bar-mark') !== null && 'mark') ||
      (el.getAttribute('data-bar-tools') !== null && 'tools') ||
      (el.getAttribute('data-bar-listen-timer') !== null && 'timer') ||
      (el.getAttribute('data-bar-transcript') !== null && 'transcript') ||
      (el.getAttribute('data-bar-history') !== null && 'history') ||
      (el.getAttribute('data-bar-pill-orb') !== null && 'orb') ||
      (el.getAttribute('data-bar-chevron') !== null && 'chevron') ||
      el.getAttribute('data-bar-slot') ||
      el.tagName.toLowerCase()
    return {
      name,
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height
    }
  })
}

/** Listening fixture HTML at production overlay width. Same reserved slots as production CSS. */
export function listeningToolbarFixtureHtml(overlayWidth = BAR_OVERLAY_WIDTH_PX): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #0b0b12; }
  .aw-toolbar {
    display: flex;
    align-items: center;
    gap: ${BAR_TOOLBAR_GAP_PX}px;
    padding: 4px ${BAR_TOOLBAR_PAD_X_PX}px;
    box-sizing: border-box;
    width: ${overlayWidth}px;
    background: #16161f;
    container-type: inline-size;
    container-name: aw-toolbar;
  }
  .aw-bar-mark {
    flex: 0 0 ${BAR_TOOLBAR_MARK_PX}px;
    width: ${BAR_TOOLBAR_MARK_PX}px;
    height: ${BAR_TOOLBAR_MARK_PX}px;
    min-width: ${BAR_TOOLBAR_MARK_PX}px;
    min-height: ${BAR_TOOLBAR_MARK_PX}px;
    max-width: ${BAR_TOOLBAR_MARK_PX}px;
    max-height: ${BAR_TOOLBAR_MARK_PX}px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 0;
    background: #7F00DA;
  }
  .aw-toolbar__tools {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    align-items: center;
    justify-content: center;
    gap: 16px;
    height: ${BAR_TOOLBAR_ROW_HEIGHT_PX}px;
  }
  .aw-toolbar__actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: ${BAR_TOOLBAR_ACTIONS_GAP_PX}px;
  }
  .aw-toolbar__timer {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: ${BAR_TOOLBAR_TIMER_GAP_PX}px;
    min-width: ${BAR_TOOLBAR_TIMER_MIN_PX}px;
    height: ${BAR_TOOLBAR_ROW_HEIGHT_PX}px;
    color: #f0717a;
    font: 500 12px ui-monospace, monospace;
  }
  .aw-toolbar__transcript {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    background: rgba(255,255,255,0.05);
    color: #c8c8d4;
    font: 600 13px system-ui;
    white-space: nowrap;
  }
  .aw-orb {
    flex: 0 0 ${BAR_TOOLBAR_ORB_PX}px;
    width: ${BAR_TOOLBAR_ORB_PX}px;
    height: ${BAR_TOOLBAR_ORB_PX}px;
    border-radius: 50%;
    border: 0;
    background: #2a2a36;
  }
  .aw-toolbar__chevron {
    flex: 0 0 ${BAR_TOOLBAR_CHEVRON_PX}px;
    width: ${BAR_TOOLBAR_CHEVRON_PX}px;
    height: 32px;
    border: 0;
    background: transparent;
    color: #888;
  }
  @container aw-toolbar (max-width: 720px) {
    .aw-toolbar__transcript-copy { display: none; }
  }
</style></head><body>
  <div class="aw-toolbar" data-bar-toolbar data-bar-listening="true">
    <button type="button" class="aw-bar-mark" data-bar-mark aria-label="Settings"></button>
    <div class="aw-toolbar__tools" data-bar-tools>
      <span data-bar-slot="capture" style="width:27px;height:27px;background:#333;border-radius:8px"></span>
      <span data-bar-slot="spotlight" style="width:27px;height:27px;background:#333;border-radius:8px"></span>
      <span data-bar-slot="mode" style="width:27px;height:27px;background:#333;border-radius:8px"></span>
      <span data-bar-slot="think" style="width:27px;height:27px;background:#333;border-radius:8px"></span>
      <span data-bar-slot="stealth" style="width:27px;height:27px;background:#333;border-radius:8px"></span>
      <span data-bar-slot="listen" style="width:12px;height:12px;background:#e23;border-radius:50%"></span>
    </div>
    <div class="aw-toolbar__actions" data-bar-actions>
      <div class="aw-toolbar__timer" data-bar-listen-timer>
        <span>0:47</span>
        <button type="button" aria-label="Pause recording" style="width:24px;height:24px;border:0;background:#222;color:#ccc">||</button>
      </div>
      <button type="button" class="aw-toolbar__transcript" data-bar-transcript title="Show the live transcript">
        <span aria-hidden="true">☰</span>
        <span class="aw-toolbar__transcript-copy">Transcript</span>
      </button>
      <button type="button" class="aw-orb" data-bar-pill-orb aria-label="Minimize to the orb"></button>
      <button type="button" class="aw-toolbar__chevron" data-bar-chevron aria-label="Expand">⌃</button>
    </div>
  </div>
</body></html>`
}
