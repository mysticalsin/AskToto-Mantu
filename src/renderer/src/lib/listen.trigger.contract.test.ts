import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

const listenSrc = readModuleSource(__dirname, './listen').text.replace(/\r\n/g, '\n')

describe('listen.ts trigger seam', () => {
  it('listen.ts fires onQuestion with the classifyTurn result and consumes the run', () => {
    expect(listenSrc).toContain('classifyTurn(themRunRef.current)')
    expect(listenSrc).toMatch(/if \(trigger\) \{\s*themRunRef\.current = ''\s*onQRef\.current\?\.\(line, trigger\)/)
    expect(listenSrc).toContain('onQuestion?: (line: TranscriptLine, trigger: TurnTrigger) => void')
  })
})
