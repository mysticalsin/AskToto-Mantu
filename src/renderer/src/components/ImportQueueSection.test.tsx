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

function render(
  policyState: 'allowed' | 'summary-only' | 'unavailable',
  persistenceState: 'configured' | 'unconfigured' | 'invalid' = 'configured'
): string {
  return renderToStaticMarkup(
    <ImportQueueSection
      jobs={[heldJob]}
      policyState={policyState}
      capabilityState="available"
      persistenceState={persistenceState}
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
    const html = render('summary-only')
    expect(html).toContain('summary-only policy prevents import')
    expect(html).toContain('Your original recording is unchanged')
    expect(html).toContain('Saved import')
    expect(html).toMatch(/<button[^>]*disabled=""/)
  })

  it('shows a held import as resumable after policy permits full retention again', () => {
    const html = render('allowed')
    expect(html).toContain('Saved imports paused while your organization’s summary-only policy was active')
    expect(html).toContain('Resume this import from its last saved transcript checkpoint')
    expect(html).not.toMatch(/<button[^>]*disabled=""/)
  })

  it('does not describe unreadable settings as summary-only', () => {
    const html = render('unavailable')
    expect(html).toContain('settings could not be verified')
    expect(html).not.toContain('summary-only policy')
    expect(html).toMatch(/<button[^>]*disabled=""/)
  })

  it('keeps a cloud-only unsupported capability separate from policy state', () => {
    const html = renderToStaticMarkup(
      <ImportQueueSection
        jobs={[heldJob]}
        policyState="allowed"
        capabilityState="cloud-only-unsupported"
        persistenceState="configured"
        policyHeldJobIds={[]}
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
    expect(html).toContain('configured cloud-only speech route')
    expect(html).not.toContain('summary-only policy')
    expect(html).toMatch(/<button[^>]*disabled=""/)
  })

  it('keeps checkpointed imports held when bounded persistence is unconfigured', () => {
    const html = render('allowed', 'unconfigured')
    expect(html).toContain('bounded checkpoint recovery is not configured')
    expect(html).toContain('Saved import')
    expect(html).toMatch(/<button[^>]*disabled=""/)
    expect(html).not.toContain('summary-only policy')
  })

  it('reports invalid checkpoint configuration without describing a retention-policy refusal', () => {
    const html = render('allowed', 'invalid')
    expect(html).toContain('configuration could not be validated')
    expect(html).toContain('Saved import')
    expect(html).toMatch(/<button[^>]*disabled=""/)
    expect(html).not.toContain('summary-only policy')
  })
})
