import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

const source = readModuleSource(__dirname, './RecallView').text.replace(/\r\n/g, '\n')

describe('RecallView (Q08 wiring)', () => {
  it('caps the search box and says when results were cut', () => {
    expect(source).toMatch(/maxLength=\{RECALL_SEARCH_MAX_CHARS\}/)
    expect(source).toMatch(/searchCapNotice\(/)
  })

  it('re-lists on window focus while no search is active, through the shared ordering guard', () => {
    expect(source).toMatch(/useRelistOnFocus\(refreshList/)
    expect(source).toMatch(/qRef\.current\.trim\(\) === ''/)
  })

  it('rows are keyboard-navigable: Arrow keys, Enter opens, one roving Tab stop, focus moves on delete', () => {
    expect(source).toMatch(/onKeyDown=\{rowKeyDown\}/)
    expect(source).toMatch(/data-meeting-row=\{m\.file\}/)
    expect(source).toMatch(/isTabStop=\{/)
    expect(source).toMatch(/focusAfterRemoval\(file\)/)
  })

  it('shows the connections panel from the module that handles a failed request', () => {
    expect(source).toMatch(/from '\.\/history\/Related'/)
    expect(source).not.toMatch(/function Related\(/)
  })
})
