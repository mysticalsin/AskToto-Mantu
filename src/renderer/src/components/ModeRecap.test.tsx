import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { modeRecapSections, ModeRecapView } from './ModeRecap'

const render = (markdown: string, mode = 'meeting') =>
  renderToStaticMarkup(<ModeRecapView mode={mode} sections={modeRecapSections(markdown, mode)} />)

describe('MQA-325 mode lookup rendering', () => {
  it.each(['__proto__', 'constructor', 'toString'])('renders inherited property mode %s with the custom-mode fallback', (mode) => {
    const html = render('## Overview\nThe pilot launches Friday.\n## Action items\nDeliver the proposal by Tuesday — Alex.', mode)
    expect(html).toContain('Métis summary')
    expect(html).toContain('The pilot launches Friday.')
    expect(html).toContain('Deliver the proposal by Tuesday — Alex.')
  })

  it('keeps the normal built-in and custom summary labels', () => {
    expect(render('## Outcome\nReady.', 'meeting')).toContain('Meeting summary')
    expect(render('## Overview\nReady.', 'custom-review')).toContain('Métis summary')
  })
})

describe('MQA-324 lossless recap display', () => {
  it('preserves every nonempty section of an imported recap in the meeting view', () => {
    const sections = ['Title', 'Tags', 'Overview', 'Topics', 'Key Q&A', 'Decisions', 'Action items', 'Next steps', 'Open questions', 'Notable quotes']
    const html = render(sections.map((heading, i) => `## ${heading}\nUNIQUE_CONTENT_${i}.`).join('\n'))
    for (let i = 0; i < sections.length; i++) expect(html).toContain(`UNIQUE_CONTENT_${i}.`)
  })

  it('renders inline heading content, including a final heading without a newline', () => {
    const text = '## Decisions: Launch Friday.\n## Action items: Send the proposal by Tuesday — Alex.\n## Open questions: Weekend coverage.'
    expect(modeRecapSections(text, 'meeting')).toEqual([
      { heading: 'Decisions', body: 'Launch Friday.' },
      { heading: 'Action items', body: 'Send the proposal by Tuesday — Alex.' },
      { heading: 'Open questions', body: 'Weekend coverage.' }
    ])
    const html = render(text)
    expect(html).toContain('Launch Friday.')
    expect(html).toContain('Send the proposal by Tuesday — Alex.')
    expect(html).toContain('Weekend coverage.')
  })

  it('keeps standard mode ordering and appends unrecognized nonempty sections in source order', () => {
    const html = render('## Vendor note\nEXTRA_ONE\n## Open questions\nOPEN\n## Décisions\nEXTRA_TWO\n## Action items\nACTION\n## Outcome\nOUTCOME\n## Decisions\nDECISION')
    const bodies = ['OUTCOME', 'DECISION', 'ACTION', 'OPEN', 'EXTRA_ONE', 'EXTRA_TWO']
    for (let i = 1; i < bodies.length; i++) expect(html.indexOf(bodies[i - 1])).toBeLessThan(html.indexOf(bodies[i]))
    for (const body of bodies) expect(html).toContain(body)
  })

  it('does not overwrite earlier bodies when a heading repeats', () => {
    const html = render('## Action items\nFIRST_ACTION\n## Action items\nSECOND_ACTION\n## Appendix\nFIRST_APPENDIX\n## Appendix\nSECOND_APPENDIX')
    for (const body of ['FIRST_ACTION', 'SECOND_ACTION', 'FIRST_APPENDIX', 'SECOND_APPENDIX']) expect(html).toContain(body)
  })

  it('retains prose before headings and custom inline text without silently dropping it', () => {
    const html = render('Important caveat before the recap.\n\n## Decisions\nNone.\n## Custom note: Reviewer caveat.\nAdditional detail.')
    expect(html).toContain('Important caveat before the recap.')
    expect(html).toContain('Reviewer caveat.')
    expect(html).toContain('Additional detail.')
  })

  it('preserves normal sales and unknown-mode recaps and escapes model-provided HTML', () => {
    const sales = render('## Next steps\nNEXT\n## Deal snapshot\nDEAL\n## Custom note\n<script>bad()</script>', 'sales')
    expect(sales.indexOf('DEAL')).toBeLessThan(sales.indexOf('NEXT'))
    expect(sales).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(sales).not.toContain('<script>')
    expect(render('## Overview\nCUSTOM_MODE_BODY', 'my-mode')).toContain('CUSTOM_MODE_BODY')
  })
})
