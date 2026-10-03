import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignSurface } from '../DesignSurface'
import { resolveDesignState } from '../states'

// No DOM render harness is installed in this repository (vitest runs in the node environment), so these
// tests render the real surface to markup, the way the other renderer component tests do.

function render(id: string): string {
  const state = resolveDesignState(`?state=${id}`)
  if (!state) throw new Error(`state ${id} does not resolve`)
  return renderToStaticMarkup(<DesignSurface state={state} />)
}

const unescape = (s: string): string => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"')

function headings(html: string): string[] {
  return [...html.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/g)].map((m) => unescape(m[1]))
}

function rowIds(html: string): string[] {
  return [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Settings design-capture states', () => {
  const destinationHeading: Record<string, string> = {
    'S01-general': 'General',
    'S02-voice-ready': 'Voice & meetings',
    'S07-knowledge': 'Knowledge & skills',
    'S10-advanced': 'General',
    'S11-search': 'Voice & meetings',
    'S15-narrow': 'Voice & meetings',
    'S16-migrated': 'General',
    'S17-connected-apps': 'Privacy & account'
  }

  it.each(Object.entries(destinationHeading))('%s renders the %s heading without console errors', (id, heading) => {
    const error = vi.spyOn(console, 'error')
    const html = render(id)
    expect(headings(html)).toContain(heading)
    expect(headings(html)).toContain('Settings')
    expect(error).not.toHaveBeenCalled()
  })

  it('shows the four destinations with a readiness label in the sidebar of every Settings state', () => {
    for (const id of Object.keys(destinationHeading)) {
      const html = render(id)
      const nav = /<nav[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? ''
      const labels = [...nav.matchAll(/class="dc-nav-label">(.*?)</g)].map((m) => unescape(m[1]))
      expect(labels, id).toEqual(['General', 'Voice & meetings', 'Knowledge & skills', 'Privacy & account', 'Advanced'])
      expect([...nav.matchAll(/class="dc-nav-readiness"/g)], id).toHaveLength(4)
      expect(html, id).toContain('aria-label="Search settings"')
    }
  })

  it("S11 searches 'mic' and lists the microphone, input-device and speech rows only", () => {
    const html = render('S11-search')
    expect(html).toContain('value="mic"')
    expect(headings(html)).toContain('Search results')
    expect(rowIds(html)).toEqual(['mic-access', 'input-device', 'speech'])
    expect(unescape(html)).toContain(
      '3 settings match “mic”, including related words: microphone, input device, speech.'
    )
  })

  it('S01 and S16 leave speech unchosen while S02 shows cloud speech ready', () => {
    expect(render('S01-general')).toContain('Needs a choice')
    expect(render('S02-voice-ready')).toContain('Cloud speech, ready')
    expect(render('S02-voice-ready')).not.toContain('Needs a choice')
  })

  it('S16 shows the two upgrade banners above General, and other states show none', () => {
    const html = render('S16-migrated')
    const banner = /<section class="dc-banner" role="status"[^>]*><strong>(.*?)<\/strong><span>(.*?)<\/span>/g
    const banners = [...html.matchAll(banner)]
    expect(banners.map((m) => [unescape(m[1]), unescape(m[2])])).toEqual([
      [
        'Settings now live in four places',
        'Find each setting under General, Voice & meetings, Knowledge & skills, or Privacy & account.'
      ],
      ['Choose how speech is processed', 'Nothing changes until you choose.']
    ])
    expect(html.indexOf('dc-banner')).toBeLessThan(html.indexOf('<h2 class="dc-settings-heading">General</h2>'))
    expect(render('S01-general')).not.toContain('dc-banner')
  })

  it('S10 opens the Advanced drawer and marks its sidebar entry expanded', () => {
    const html = render('S10-advanced')
    expect(html).toContain('<aside class="dc-drawer" aria-label="Advanced">')
    expect(headings(html)).toContain('Advanced')
    expect(html).toContain('aria-expanded="true"')
    expect(rowIds(html)).toEqual(
      expect.arrayContaining(['diagnostic-logging', 'hardware-acceleration', 'export-diagnostics', 'reset'])
    )
    expect(render('S01-general')).not.toContain('dc-drawer')
  })

  it('S17 lists the connected apps with neutral names', () => {
    const html = render('S17-connected-apps')
    expect(headings(html)).toContain('Connected apps')
    expect(rowIds(html)).toEqual(
      expect.arrayContaining(['organisation', 'signed-in', 'app-workspace-agent', 'app-task', 'app-calendar'])
    )
    for (const name of ['Example Org', 'Member A', 'Workspace agent', 'Task app', 'Calendar app']) {
      expect(html).toContain(name)
    }
  })
})
