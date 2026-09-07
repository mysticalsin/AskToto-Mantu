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
  // `.ev-head` alone (spa/css.ts) is the whole layout this needs: a flex row, title+subtitle on
  // the left, `opts.action` on the right. It used to also carry `.page-hero`, a `display: grid`
  // rule declared later in the same file that -- same selector specificity, later wins per
  // property -- silently overrode `.ev-head`'s `display: flex`, dropping the action button onto
  // its own row below the subtitle instead of beside it. `.page-hero` was never used anywhere but
  // here, so it is dropped rather than patched: no page actually wants two competing layout modes
  // on one element.
  return `<div class="ev-head">
    <div>
      <h1 class="page-title">${esc(opts.title)}</h1>
      ${subtitle}
    </div>
    ${opts.action || ''}
  </div>
  ${tabs}`
}
