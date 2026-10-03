import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignSurface } from '../DesignSurface'
import { DESIGN_STATES, resolveDesignState } from '../states'

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

/** The markup of one settings row. */
function rowText(html: string, id: string): string {
  const match = new RegExp(`<li class="dc-row" data-row="${id}">(.*?)</li>`).exec(html)
  if (!match) throw new Error(`row ${id} is not rendered`)
  return match[1]
}

function rowValue(html: string, id: string): string | undefined {
  return /<span class="dc-row-value"[^>]*>(.*?)<\/span>/.exec(rowText(html, id))?.[1]
}

/** [title, body] of each banner, in order. */
function banners(html: string): string[][] {
  const banner = /<section class="dc-banner" role="[a-z]+"[^>]*><strong>(.*?)<\/strong><span>(.*?)<\/span>/g
  return [...html.matchAll(banner)].map((m) => [unescape(m[1]), unescape(m[2])])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Settings design-capture states', () => {
  const destinationHeading: Record<string, string> = {
    'S01-general': 'General',
    'S02-voice-ready': 'Voice & meetings',
    'S03-voice-unavailable': 'Voice & meetings',
    'S04-local-speech-review': 'Voice & meetings',
    'S05-local-speech-downloading': 'Voice & meetings',
    'S06-local-speech-installed': 'Voice & meetings',
    'S07-knowledge': 'Knowledge & skills',
    'S08-privacy-managed': 'Privacy & account',
    'S09-policy-sheet': 'Effective policy',
    'S10-advanced': 'General',
    'S11-search': 'Voice & meetings',
    'S12-search-empty': 'Search results',
    'S13-save-failed': 'General',
    'S14-policy-changed': 'Voice & meetings',
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

  it('covers every listed Settings state in these render tests', () => {
    const listed = DESIGN_STATES.filter((s) => s.kind === 'settings').map((s) => s.id)
    expect(Object.keys(destinationHeading)).toEqual(listed)
  })

  it('S03 shows cloud speech offline, typing still works, local speech not selected and a microphone-only row', () => {
    const html = unescape(render('S03-voice-unavailable'))
    expect(banners(html)).toEqual([
      [
        'Cloud speech unavailable',
        'This computer is offline. Typing still works, and Métis does not switch to local speech on its own.'
      ]
    ])
    expect(html).toContain('Cloud speech, offline')
    expect(html).toContain('Speech unavailable')
    expect(rowValue(html, 'local-speech')).toBe('Not selected')
    expect(html).toContain('Not selected, so Métis never switches to it on its own.')
    expect(rowValue(html, 'capture-issue')).toBe('Microphone only')
    expect(html).not.toContain('Cloud speech, ready')
  })

  it('S04 offers one recommended compatible pack, one unsupported for free memory and one macOS-only pack', () => {
    const html = unescape(render('S04-local-speech-review'))
    expect(headings(html)).toContain('Local speech (optional)')
    expect(rowIds(html)).toEqual(expect.arrayContaining(['pack-standard', 'pack-large', 'pack-system']))
    expect(rowValue(html, 'pack-standard')).toBe('Compatible')
    expect(rowText(html, 'pack-standard')).toContain('Recommended for this computer.')
    expect(rowText(html, 'pack-standard')).toContain('>Download</button>')
    expect(rowValue(html, 'pack-large')).toBe('Not supported')
    expect(rowText(html, 'pack-large')).toContain('Needs 12 GB of free memory; this computer has 6 GB free.')
    expect(rowValue(html, 'pack-system')).toBe('macOS only')
    expect(html).not.toContain('role="progressbar"')
  })

  it('S05 shows the recommended pack downloading at 38% and pausing during meetings', () => {
    const html = unescape(render('S05-local-speech-downloading'))
    const pack = rowText(html, 'pack-standard')
    expect(pack).toContain('role="progressbar"')
    expect(pack).toContain('aria-valuenow="38"')
    expect(pack).toContain('style="width:38%"')
    expect(rowValue(html, 'pack-standard')).toBe('Downloading, 38%. Pauses during meetings.')
    expect([...html.matchAll(/role="progressbar"/g)]).toHaveLength(1)
  })

  it('S06 shows the pack installed while speech stays on cloud speech', () => {
    const html = unescape(render('S06-local-speech-installed'))
    expect(rowValue(html, 'pack-standard')).toBe('Installed, not selected')
    expect(rowText(html, 'pack-standard')).toContain('>Use for speech</button>')
    expect(rowValue(html, 'speech')).toBe('Cloud speech, ready')
  })

  it('S08 locks three Privacy settings, each owned by Example Org IT with a reason', () => {
    const html = unescape(render('S08-privacy-managed'))
    const locks = [...html.matchAll(/data-row="([^"]+)"(?:(?!<\/li>).)*?data-lock="locked"><strong>(.*?)<\/strong> (.*?)<\/span>/g)]
    expect(locks.map((m) => [m[1], m[2], m[3]])).toEqual([
      ['encrypt', 'Locked by Example Org IT.', 'Every organisation computer keeps notes encrypted.'],
      ['screen-share', 'Locked by Example Org IT.', 'Notes must never appear in a shared screen.'],
      ['app-calendar', 'Locked by Example Org IT.', 'Calendar access waits for a security review.']
    ])
    // A locked row shows its value and offers nothing to change it.
    expect(rowValue(html, 'encrypt')).toBe('On')
    expect(rowText(html, 'app-calendar')).not.toContain('<button')
    expect(html).toContain('>Managed<')
    expect(banners(html).map((b) => b[0])).toEqual(['Some settings are managed by Example Org IT'])
    expect(html).not.toContain('role="dialog"')
    expect(render('S17-connected-apps')).not.toContain('data-lock')
  })

  it('S09 opens the effective-policy sheet with setting, value, source and why for every managed control', () => {
    const html = unescape(render('S09-policy-sheet'))
    expect(html).toContain('<aside class="dc-drawer dc-sheet" role="dialog" aria-label="Effective policy">')
    const head = [...html.matchAll(/<th scope="col">(.*?)<\/th>/g)].map((m) => m[1])
    expect(head).toEqual(['Setting', 'Value', 'Source', 'Why'])
    const rows = [
      ...html.matchAll(/<tr data-policy-row="[^"]+"><th scope="row">(.*?)<\/th><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)
    ].map((m) => m.slice(1, 5))
    expect(rows).toEqual([
      ['Encrypt notes', 'On', 'Example Org IT', 'Every organisation computer keeps notes encrypted.'],
      ['Hide from screen sharing', 'On', 'Example Org IT', 'Notes must never appear in a shared screen.'],
      ['Calendar app', 'Not allowed', 'Example Org IT', 'Calendar access waits for a security review.'],
      ['Diagnostic logging', 'Hidden', 'Example Org IT', 'Detailed logs stay off on organisation computers.'],
      ['Export diagnostics', 'Hidden', 'Example Org IT', 'Support reports go through the IT team.']
    ])
    expect(headings(html)).toContain('Privacy & account')
  })

  it('S12 searches a neutral query and explains the organisation hides the matching controls', () => {
    const html = unescape(render('S12-search-empty'))
    expect(html).toContain('value="diagnostic"')
    expect(rowIds(html)).toEqual([])
    expect(html).toContain('No settings match “diagnostic”. Example Org IT hides 2 matching controls on this computer.')
    expect(html).toContain('<section class="dc-empty" role="status" aria-label="Hidden by your organisation">')
    expect(html).toContain('These controls are not shown on this computer.')
  })

  it('S13 shows an inline save failure on the theme row with the value reverted', () => {
    const html = unescape(render('S13-save-failed'))
    const theme = rowText(html, 'theme')
    expect(theme).toContain('<span class="dc-row-value" data-reverted="true">Match system</span>')
    expect(theme).toContain('<p class="dc-row-error" role="alert">Couldn’t save “Dark”. Theme is back to Match system.</p>')
    expect([...html.matchAll(/data-reverted=/g)]).toHaveLength(1)
    expect(render('S01-general')).not.toContain('dc-row-error')
  })

  it('S14 records a meeting, warns of a policy change and locks speech only from the next meeting', () => {
    const html = unescape(render('S14-policy-changed'))
    expect(html).toContain('<p class="dc-recording" role="status">')
    expect(html).toContain('Recording a meeting, 00:42')
    expect(html).toContain('<section class="dc-banner" role="alert"')
    expect(html).toContain('data-tone="warning"')
    expect(html).toContain(
      'Speech processing becomes Local speech only from your next meeting. This meeting keeps its current speech setting.'
    )
    const speech = rowText(html, 'speech')
    expect(speech).toContain('data-lock="pending"')
    expect(speech).toContain('From your next meeting: Local speech only, locked by Example Org IT.')
    // The current meeting keeps its speech setting, and it cannot be changed mid-meeting.
    expect(rowValue(html, 'speech')).toBe('Cloud speech, ready')
    expect(speech).not.toContain('<button')
    expect(render('S02-voice-ready')).not.toContain('dc-recording')
  })
})
