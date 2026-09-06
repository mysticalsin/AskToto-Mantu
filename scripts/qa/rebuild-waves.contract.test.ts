import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Wave 0–6 / QA approval — source contracts that the rebuild's critical seams stay wired.
 * Physical CDP suite coverage for these is still expanding; these pins prevent silent regressions
 * of routingMode, consolidation, MCP confidential skip, SUMMARY→actionItems, and failover notice.
 */
const ROOT = join(__dirname, '..', '..')

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

describe('QA rebuild contracts — Wave 2 routing + failover notice', () => {
  it('exposes routingMode and lastFailover on PublicSettings; dismiss IPC exists', () => {
    const ipc = read('src/shared/ipc.ts')
    expect(ipc).toMatch(/routingMode: z\.enum\(\['local', 'api', 'auto'\]\)/)
    expect(ipc).toMatch(/lastFailover:/)
    expect(ipc).toMatch(/dismissFailoverNotice:/)
  })

  it('failover() records lastFailoverNotice and auditLog provider.failover', () => {
    const main = read('src/main/index.ts')
    expect(main).toMatch(/lastFailoverNotice = \{/)
    expect(main).toMatch(/auditLog\('provider\.failover'/)
    expect(main).toMatch(/IPC\.dismissFailoverNotice/)
  })

  it('App renders a dismissible failover chip', () => {
    const app = read('src/renderer/src/App.tsx')
    expect(app).toMatch(/settings\?\.lastFailover/)
    expect(app).toMatch(/dismissFailoverNotice/)
  })
})

describe('QA rebuild contracts — Wave 3 consolidation', () => {
  it('saveTranscript defers ingest when brainConsolidation.enabled', () => {
    const main = read('src/main/index.ts')
    expect(main).toMatch(/deferred:\s*getSettings\(\)\.brainConsolidation\.enabled/)
    expect(main).toMatch(/scheduleIntelligenceIndex|runIntelligenceIndex|runConsolidationIfDue/)
  })
})

describe('QA rebuild contracts — Wave 4 confidential MCP', () => {
  it('Review blocks CRM and task push when confidentialFlag is on', () => {
    const review = read('src/renderer/src/components/Review.tsx')
    expect(review).toMatch(/confidential\. CRM push is blocked/)
    expect(review).toMatch(/confidential\. Task push is blocked/)
    expect(review).toMatch(/!confidentialFlag/)
  })

  it('pushQueue skips confidential outbound actions', () => {
    const q = read('src/main/mcp/pushQueue.ts')
    expect(q).toMatch(/confidential/)
    expect(q).toMatch(/skipped_confidential|skip.*confidential/i)
  })
})

describe('QA rebuild contracts — Wave 1D SUMMARY headings', () => {
  it('parseRecapMarkdown aliases Next steps into actionItems', () => {
    const src = read('src/main/transcripts.ts')
    expect(src).toMatch(/sections\['next steps'\]/)
    expect(src).toMatch(/sections\['action items'\]/)
  })

  it('SUMMARY_PROMPT uses ## Next steps / ## Decisions', () => {
    const prompts = read('src/shared/prompts.ts')
    expect(prompts).toMatch(/## Next steps:/)
    expect(prompts).toMatch(/## Decisions:/)
  })
})

describe('QA rebuild contracts — Wave 1 provisional strip', () => {
  it('stripProvisionalLines exists and save paths use it', () => {
    const ipc = read('src/shared/ipc.ts')
    expect(ipc).toMatch(/stripProvisionalLines/)
    expect(ipc).toMatch(/provisional: z\.boolean\(\)\.optional\(\)/)
  })
})
