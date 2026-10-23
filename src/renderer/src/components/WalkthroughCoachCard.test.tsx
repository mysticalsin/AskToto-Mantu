import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { IDLE_WALKTHROUGH_VIEW, type WalkthroughView } from '@shared/walkthrough-view'
import { WalkthroughCoachCard } from './WalkthroughCoachCard'

const render = (over: Partial<WalkthroughView>): string =>
  renderToStaticMarkup(<WalkthroughCoachCard view={{ ...IDLE_WALKTHROUGH_VIEW, ...over }} onAction={vi.fn()} />)

describe('WalkthroughCoachCard (G45)', () => {
  it('renders nothing while idle', () => {
    expect(render({})).toBe('')
  })

  it('shows the step, the instruction, the status and only working controls', () => {
    const html = render({
      runId: 'r',
      phase: 'awaiting',
      step: 1,
      stepCount: 3,
      instruction: 'Click Share in the toolbar.',
      status: 'Tell Métis when you have done it.',
      canCheck: true,
      canStop: true
    })
    expect(html).toContain('Step 1 of 3')
    expect(html).toContain('Click Share in the toolbar.')
    expect(html).toContain('I did it')
    expect(html).toContain('Stop')
    expect(html).not.toContain('Pause')
    expect(html).toContain('aria-live="polite"')
  })

  it('announces a pause assertively', () => {
    expect(
      render({ runId: 'r', phase: 'paused', step: 2, stepCount: 3, status: 'Paused while you are in a meeting.' })
    ).toContain('aria-live="assertive"')
  })
})

describe('WalkthroughCoachHost mounting (G45)', () => {
  it('is mounted in the sidecar directly above the task cards', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const text = readFileSync(resolve(__dirname, 'RightEdgeSidecar.tsx'), 'utf8')
    expect(text.indexOf('<WalkthroughCoachHost />')).toBeGreaterThan(0)
    expect(text.indexOf('<WalkthroughCoachHost />')).toBeLessThan(text.indexOf('<TaskCardsHost />'))
  })
})
