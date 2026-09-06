/** Reference PageHeader.tsx: title + subtitle, optional underline tabs, optional right-aligned
 * primary action. */
import { esc } from './index'

export function pageHeader(opts: {
  title: string
  subtitle?: string
  tabs?: { id: string; label: string; active?: boolean; inert?: boolean }[]
  action?: string
}): string {
  const tabs = opts.tabs?.length
    ? `<div class="page-tabs underline" role="tablist">${opts.tabs
        .map((t) =>
          t.inert
            ? `<span class="page-tab" data-inert title="Not part of this release" aria-disabled="true">${esc(t.label)}</span>`
            : `<button type="button" class="page-tab${t.active ? ' on' : ''}" data-page-tab="${esc(t.id)}" role="tab" aria-selected="${t.active ? 'true' : 'false'}">${esc(t.label)}</button>`
        )
        .join('')}</div>`
    : ''
  const subtitle = opts.subtitle ? `<p class="page-sub">${esc(opts.subtitle)}</p>` : ''
  return `<div class="ev-head page-hero">
    <div>
      <h1 class="page-title">${esc(opts.title)}</h1>
      ${subtitle}
    </div>
    ${opts.action || ''}
  </div>
  ${tabs}`
}
