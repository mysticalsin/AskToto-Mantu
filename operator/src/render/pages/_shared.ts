/**
 * Shared helpers for the page modules under operator/src/render/pages/ (plan P0.4). Moved
 * verbatim out of operator/src/ui.ts, which now composes shell() + these modules and nothing
 * else. Kept dependency-free the same way operator/src/render/index.ts is, so it bundles into
 * both the Worker and the browser client without change.
 *
 * design-lead owns operator/src/render/primitives.ts and the other primitive files; nothing
 * here duplicates a primitive that already exists there. Where a page needs something new
 * (percentBar below), it is added here rather than by editing their files.
 *
 * This file stays dev-shell's (the shell owner). During the P1 section wave, a page owner adds
 * a helper here only if it is genuinely generic (useful to more than one page, the way
 * percentBar/geoBar already are) -- anything specific to one page belongs in that page's own
 * operator/src/render/pages/<page>.ts instead, so no two page owners ever need to edit this
 * file in the same wave.
 */
import { esc } from '../index'
import { looksLikeSecret } from '../../redact'

export const MISSING: string = '—'

export function when(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16)
}

export function field(value: string | null | undefined): string {
  if (!value || looksLikeSecret(value)) return MISSING
  return esc(value)
}

export function approvalPill(approval: string): string {
  const v = approval.trim().toLowerCase() || 'pending'
  return `<span class="approval ${esc(v)}">${esc(v)}</span>`
}

export function kpiCard(opts: {
  title: string
  value: string
  sub: string
  spark: string
  pill?: string
}): string {
  return `<article class="card kpi">
    <div class="kpi-top"><h3>${esc(opts.title)}</h3>${opts.pill ?? ''}</div>
    <div class="n">${esc(opts.value)}</div>
    <div class="sub">${esc(opts.sub)}</div>
    ${opts.spark}
  </article>`
}

/**
 * A proportional bar with a continuous, unbucketed percentage (0-100) and zero inline `style=`
 * (plan D6 / gates.mjs gate 2). Renders an `<svg>` sized by its own `width`/`height` XML
 * presentation attributes -- not the HTML `style` attribute the gate greps for -- so the
 * existing CSS rule for `className` (a `background`, same as the `<span style="width:...">` it
 * replaces) still paints it solid at exactly that width. `className` stays the sole class so a
 * test asserting `class="X"` still matches verbatim.
 */
export function percentBar(pct: number, className: string): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct * 100) / 100))
  return `<svg class="${esc(className)}" width="${clamped}%" height="100%" aria-hidden="true"></svg>`
}

/** Overview/Realtime geo tables: a full-row proportional bar behind the label. */
export function geoBar(count: number, max: number): string {
  const pct = max <= 0 ? 0 : Math.max(6, Math.round((count / max) * 100))
  return percentBar(pct, 'geo-bar')
}
