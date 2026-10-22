import { describe, expect, it } from 'vitest'
import {
  RECALL_SEARCH_MAX_CHARS,
  RECALL_SEARCH_MAX_TERMS,
  RECALL_SEARCH_RESULT_CAP,
  searchCapNotice
} from './recall-search'

describe('History search limits', () => {
  it('shares one set of caps between the search box and the main process', () => {
    expect(RECALL_SEARCH_MAX_CHARS).toBe(200)
    expect(RECALL_SEARCH_MAX_TERMS).toBe(16)
    expect(RECALL_SEARCH_RESULT_CAP).toBe(25)
  })

  it('says the results were cut only when matches were left out', () => {
    expect(searchCapNotice(25, 40)).toBe('Showing the top 25 matches.')
    expect(searchCapNotice(25, 25)).toBeNull()
    expect(searchCapNotice(3, 3)).toBeNull()
    expect(searchCapNotice(0, 0)).toBeNull()
  })
})
