import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const nav = readFileSync(resolve(__dirname, '../components/NavBar.tsx'), 'utf8')

describe('Intelligence window Update control', () => {
  it('shows Update Intelligence and starts the pass on click', () => {
    const btn = readFileSync(resolve(__dirname, '../components/IntelligenceUpdateButton.tsx'), 'utf8')
    expect(nav).toContain('IntelligenceUpdateButton')
    expect(btn).toContain('data-intelligence-update')
    expect(btn).toContain('Update Intelligence')
    expect(btn).toContain('backfill')
    expect(btn).toContain('runIntelligenceUpdateClick')
    expect(nav).not.toMatch(/Run agent|Trigger pass/)
  })

  it('does not auto-start or auto-send', () => {
    expect(nav).not.toMatch(/useEffect/)
    expect(nav).not.toMatch(/mcpPush|sendMail|autoSend/)
  })
})
