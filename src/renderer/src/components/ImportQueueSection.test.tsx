import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ImportJobView } from '@shared/ipc'
import { ImportQueueSection } from './ImportQueueSection'

const heldJob: ImportJobView = {
  jobId: 'held-job',
  title: 'Saved import',
  state: 'policy-held',
  cursor: 0,
  totalChunks: 0,
  pct: null,
  createdAt: 0,
  updatedAt: 0
}

function render(policyBlocked: boolean): string {
  return renderToStaticMarkup(
    <ImportQueueSection
      jobs={[heldJob]}
      policyBlocked={policyBlocked}
      policyHeldJobIds={['held-job']}
      inventoryOverflow={false}
      policyHoldOverflow={false}
      error={null}
      assets={null}
      dragOver={false}
      onCancel={() => {}}
      onResume={() => {}}
      onDismiss={() => {}}
      onOpenMeeting={() => {}}
    />
  )
}

describe('summary-only import retention UI', () => {
  it('keeps a held import visible but disables Resume while policy blocks retention', () => {
    const html = render(true)
    expect(html).toContain('summary-only policy prevents import')
    expect(html).toContain('Your original recording is unchanged')
    expect(html).toContain('Saved import')
    expect(html).toMatch(/<button[^>]*disabled=""/)
  })

  it('shows a held import as resumable after policy permits full retention again', () => {
    const html = render(false)
    expect(html).toContain('Saved imports paused while your organization’s summary-only policy was active')
    expect(html).toContain('Resume this import from its last saved transcript checkpoint')
    expect(html).not.toMatch(/<button[^>]*disabled=""/)
  })
})
