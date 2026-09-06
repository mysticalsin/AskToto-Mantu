/** Toolbar family (reference Toolbar.tsx): a bordered pill button, a search pill, a sortable
 * "View" pill, and the row that lays left/right groups out with a sticky-header background. */
import { esc } from './index'
import { iconSvg, NAV_ICON_PATHS } from './icons'

export function toolbarButton(opts: {
  label: string
  attrs?: string
  icon?: string
  active?: boolean
  disabled?: boolean
}): string {
  const icon = opts.icon ? iconSvg(opts.icon, { class: 'tool-ic' }) : ''
  const cls = `tool${opts.active ? ' on' : ''}`
  const disabled = opts.disabled ? ' disabled aria-disabled="true"' : ''
  return `<button type="button" class="${cls}" ${opts.attrs || ''}${disabled}>${icon}<span>${esc(opts.label)}</span></button>`
}

export function toolbarSearch(opts: { id?: string; placeholder: string; attrs?: string }): string {
  const idAttr = opts.id ? ` id="${esc(opts.id)}"` : ''
  return `<div class="search-wrap">${iconSvg(NAV_ICON_PATHS.search, { class: 'tool-ic' })}<input${idAttr} class="toolbar-search" type="search" placeholder="${esc(opts.placeholder)}" autocomplete="off" ${opts.attrs || ''}></div>`
}

export function viewButton(opts: { attrs?: string }): string {
  return `<button type="button" class="tool page-view" ${opts.attrs || ''}>${iconSvg(NAV_ICON_PATHS['chevrons-up-down'], { class: 'tool-ic' })}<span>View</span></button>`
}

/** The full sticky toolbar row: left group, optional search, right group (defaults to a
 * `viewButton()` when `right` is omitted). */
export function toolbar(opts: { left?: string; right?: string; search?: string }): string {
  const right = opts.right ?? viewButton({})
  return `<div class="page-toolbar sticky-header">
    <div class="top-left">${opts.left || ''}</div>
    ${opts.search || ''}
    <div class="top-right">${right}</div>
  </div>`
}
