/**
 * Reference VisitorsCard / LiveVisitorsCard / LiveFeed (realtime strip). `visitorsCard` draws
 * the 30-bar one-minute series (254x42 viewBox, 6px-wide bars, 8.1935px step — SPEC #142/276).
 * `liveCard` is the pinging-dot "Live" tile. `liveFeed` is the 44px-row activity list.
 */
import { esc } from './index'
import { kindBadge } from './primitives'

const BAR_STEP = 8.1935
const BAR_WIDTH = 6

/** 30 one-minute buckets -> a 254x42 SVG bar chart in --chart-0. */
export function visitorsBars(values: number[]): string {
  const data = values.slice(-30)
  while (data.length < 30) data.unshift(0)
  const max = Math.max(1, ...data)
  const bars = data
    .map((v, i) => {
      const h = Math.max(2, Math.round((v / max) * 40))
      const x = (i * BAR_STEP).toFixed(2)
      const y = 42 - h
      return `<rect x="${x}" y="${y}" width="${BAR_WIDTH}" height="${h}" rx="1" fill="var(--chart-0)"/>`
    })
    .join('')
  return `<svg class="visitors-bars" viewBox="0 0 254 42" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`
}

export function visitorsCard(opts: { title: string; value: number | string; bars: number[]; refreshing?: boolean }): string {
  const pulse = opts.refreshing ? '<i class="pulse-dot" aria-hidden="true"></i>' : ''
  return `<article class="card rt-unique" style="padding-bottom:14px">
    <div class="kpi-top"><h3 class="rt-h">${esc(opts.title)}</h3>${pulse}</div>
    <div class="n rt-n">${esc(String(opts.value))}</div>
    ${visitorsBars(opts.bars)}
  </article>`
}

export function liveCard(opts: { title: string; value: number | string; caption: string; refreshing?: boolean }): string {
  const pulse = opts.refreshing ? '<i class="pulse-dot" aria-hidden="true"></i>' : ''
  return `<article class="card rt-unique" style="padding-bottom:14px">
    <div class="kpi-top"><h3 class="rt-h">${esc(opts.title)}</h3><span class="live" aria-hidden="true"></span></div>
    <div class="n rt-n">${esc(String(opts.value))}</div>
    <div class="sub">${esc(opts.caption)}${pulse}</div>
  </article>`
}

export type LiveFeedRow = {
  id: string
  kind: string
  label: string
  flag?: string
  osChip?: string
  ageHtml: string
}

export function liveFeed(opts: { rows: LiveFeedRow[]; count?: number }): string {
  const count = opts.count ?? opts.rows.length
  const body = opts.rows.length
    ? opts.rows
        .map(
          (r) =>
            `<div class="rt-row" data-event="${esc(r.id)}">${kindBadge(r.kind)}<span class="event-name">${esc(r.label)}</span><span class="event-chips">${r.flag || ''}${r.osChip || ''}</span><span class="ago">${r.ageHtml}</span></div>`
        )
        .join('')
    : '<div class="empty">No live events yet. A heartbeat writes city and lands here.</div>'
  return `<article class="card activity-feed" style="padding-bottom:10px" data-live-feed>
    <div class="kpi-top"><p class="eyebrow" style="margin:0"><span class="live" aria-hidden="true"></span> Live events</p><span class="muted">${count}</span></div>
    <div id="rt-stream">${body}</div>
  </article>`
}
