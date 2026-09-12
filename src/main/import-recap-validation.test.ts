import { describe, expect, it } from 'vitest'
import { localImportRecapProblem } from './import-recap-validation'

const headings = ['Title', 'Tags', 'Overview', 'Topics', 'Key Q&A', 'Decisions', 'Action items', 'Next steps', 'Open questions', 'Notable quotes']
const prefix = headings.map((heading) => `## ${heading}: Follow the specific instruction for ${heading}.`).join('\n')
const valid = headings.map((heading) => `## ${heading}\nContent for ${heading}.`).join('\n')
const complete = { status: 'complete', reason: 'stop' } as const
const check = (text = valid, completion: Parameters<typeof localImportRecapProblem>[1] = complete, transcript = 'A synthetic meeting transcript.') =>
  localImportRecapProblem(text, completion, prefix, transcript)

describe('MQA-327 local imported recap containment', () => {
  it('accepts complete structured notes without claiming their facts are verified', () => {
    expect(check()).toBeNull()
    expect(check(valid.replace('Content for Decisions.', 'None.').replace('Content for Action items.', 'None.'))).toBeNull()
  })

  it.each([undefined, { status: 'incomplete', reason: 'length' }, { status: 'complete', reason: 'unknown' }, { status: 'complete' }] as const)(
    'requires explicit successful local terminal metadata: %j', (completion) => {
      expect(localImportRecapProblem(valid, completion, prefix, 'Synthetic transcript')).toBe('invalid_completion')
    }
  )

  it('rejects the shape of the observed complete-but-unrelated unstructured response', () => {
    expect(check('A long but unrelated lesson about geometry. It does not summarize the supplied meeting.')).toBe('invalid_format')
  })

  it('rejects missing, empty and repeated sections instead of accepting incomplete structure', () => {
    expect(check(valid.replace('## Topics\nContent for Topics.\n', ''))).toBe('invalid_format')
    expect(check(valid.replace('Content for Topics.', '   '))).toBe('invalid_format')
    expect(check(valid.replace('## Topics', '## Overview'))).toBe('invalid_format')
  })

  it('preserves inline bodies, CRLF, preamble and extra distinct content', () => {
    const inline = headings.map((heading) => `## ${heading}: Body for ${heading}.`).join('\r\n')
    expect(check(`Here are the notes.\r\n${inline}\r\n## Appendix: An additional caveat.`)).toBeNull()
  })

  it('does not require English/French heading names for other selected summary languages', () => {
    const translated = ['Titel', 'Stichwörter', 'Überblick', 'Themen', 'Fragen und Antworten', 'Entscheidungen', 'Aufgaben', 'Nächste Schritte', 'Offene Fragen', 'Zitate']
    expect(check(translated.map((heading) => `## ${heading}: Ein synthetischer Inhalt.`).join('\n'))).toBeNull()
    expect(check(translated.map((heading) => `## ${heading}： Ein synthetischer Inhalt.`).join('\n'))).toBeNull()
  })

  it('does not count heading-shaped text inside backtick or tilde fences as actual sections', () => {
    for (const marker of ['```', '~~~']) expect(check(`${marker}markdown\n${valid}\n${marker}`)).toBe('invalid_format')
    expect(check(valid.replace('## Topics\nContent for Topics.', '```markdown\n## Topics\nContent for Topics.\n```'))).toBe('invalid_format')
  })

  it('does not treat empty fenced blocks as nonempty section content', () => {
    for (const marker of ['```', '~~~']) {
      expect(check(headings.map((heading) => `## ${heading}\n${marker}\n   \n${marker}`).join('\n'))).toBe('invalid_format')
      expect(check(headings.map((heading) => `## ${heading}\n${marker}\nA genuine code example.\n${marker}`).join('\n'))).toBeNull()
    }
  })

  it('does not treat an inline backtick code span as an opening fenced block', () => {
    expect(check(`\`\`\`synthetic title\`\`\`\n${valid}`)).toBeNull()
  })

  it('rejects copied prompt instructions absent from the actual transcript', () => {
    const echo = valid.replace('Content for Title.', 'Follow the specific instruction for Title.')
    expect(check(echo)).toBe('template_echo')
    expect(check(echo, complete, 'We discussed this literal wording: Follow the specific instruction for Title.')).toBeNull()
  })

  it('fails closed for an empty declared contract', () => {
    expect(localImportRecapProblem(valid, complete, '', 'Synthetic transcript')).toBe('invalid_format')
  })
})
