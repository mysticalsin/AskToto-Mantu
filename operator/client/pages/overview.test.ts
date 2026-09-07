/**
 * Coverage for the Overview client's Connectors card loader (QA finding: "root.innerHTML is
 * never cleared on the error branch, so the loading skeleton stays in the DOM under the error
 * text forever"). operator/src/render/pages/overview.test.ts only exercises the pure
 * renderConnectorsCardRows() -- this is the async, DOM-mutating loadConnectorsCard() itself,
 * driven directly with `api()` mocked so no network call happens.
 */
import { describe, expect, it, vi } from 'vitest'

// `hasBackend` mocked `true` (a real Worker is behind the route) for every test below: these
// cases are all about how loadConnectorsCard() reacts to what `api()` resolves with, not about
// the standalone-preview short-circuit (see api.ts's own doc comment) that skips calling `api()`
// at all -- covered instead by that short-circuit's own truth table (hasBackend() itself), not
// by re-deriving it here against a fake `document`.
vi.mock('../api', () => ({ api: vi.fn(), hasBackend: () => true }))

import { api } from '../api'
import { loadConnectorsCard } from './overview'

/** A minimal stand-in for the two elements loadConnectorsCard() touches -- not a full DOM (this
 *  repo has no jsdom/happy-dom dependency), just enough of the Element surface the function under
 *  test actually calls: querySelector, setAttribute/getAttribute, innerHTML, hidden, textContent. */
function fakeSection() {
  const root = {
    innerHTML: '<div class="card pad-b10 connector-group" role="status" aria-label="Loading connectors">SKELETON</div>',
    attrs: new Map<string, string>([['data-ov-connectors-state', 'loading']]),
    setAttribute(name: string, value: string) {
      this.attrs.set(name, value)
    },
    getAttribute(name: string) {
      return this.attrs.get(name) ?? null
    }
  }
  const errorEl = { hidden: true, textContent: '' }
  const section = {
    querySelector(sel: string) {
      if (sel === '[data-ov-connectors-root]') return root
      if (sel === '[data-ov-connectors-error]') return errorEl
      return null
    }
  }
  return { section: section as unknown as HTMLElement, root, errorEl }
}

describe('loadConnectorsCard', () => {
  it('clears the loading skeleton and shows the server error once the fetch fails', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: false, error: 'Connection reset.' })
    const { section, root, errorEl } = fakeSection()

    await loadConnectorsCard(section)

    expect(root.innerHTML).toBe('')
    expect(root.getAttribute('data-ov-connectors-state')).toBe('error')
    expect(errorEl.hidden).toBe(false)
    expect(errorEl.textContent).toBe('Connection reset.')
  })

  it('falls back to a named message and still clears the skeleton when the response carries none', async () => {
    vi.mocked(api).mockResolvedValueOnce(null)
    const { section, root, errorEl } = fakeSection()

    await loadConnectorsCard(section)

    expect(root.innerHTML).toBe('')
    expect(errorEl.textContent).toBe('Could not load connectors. Reopen this page to retry.')
  })
})
