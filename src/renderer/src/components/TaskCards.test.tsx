import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TaskCardView } from '@shared/task-card'
import { TaskCards } from './TaskCards'

const view = (n: number, over: Partial<TaskCardView> = {}): TaskCardView => ({
  cardId: n.toString(16).padStart(32, '0'),
  actionId: 'desktop.create_note',
  phase: 'running',
  stoppable: true,
  dismissible: false,
  ...over
})
const render = (cards: TaskCardView[]): string =>
  renderToStaticMarkup(<TaskCards cards={cards} onStop={vi.fn()} onDismiss={vi.fn()} />)

describe('TaskCards (G33)', () => {
  it('renders nothing without live tasks', () => {
    expect(render([])).toBe('')
  })

  it('names the task, states its phase and offers Stop only while it can be stopped', () => {
    const running = render([view(1)])
    expect(running).toContain('Create note')
    expect(running).toContain('Working…')
    expect(running).toContain('aria-label="Stop Create note"')
    expect(running).toContain('data-task-card="running"')

    const stopping = render([view(1, { phase: 'stopping', stoppable: false })])
    expect(stopping).toContain('Stopping. Anything already done stays done.')
    expect(stopping).not.toContain('Stop Create note')
  })

  it('keeps an uncertain card until it is dismissed, with the honest sentence', () => {
    const html = render([view(1, { phase: 'uncertain', stoppable: false, dismissible: true })])
    expect(html).toContain('Métis can&#x27;t confirm this finished. Check before trying again.')
    expect(html).toContain('aria-label="Dismiss Create note"')
  })

  it('is a labelled group per card with title and status wired for assistive technology', () => {
    const html = render([view(7)])
    const id = view(7).cardId
    expect(html).toContain(
      `role="group" aria-labelledby="task-card-${id}-title" aria-describedby="task-card-${id}-status"`
    )
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-live="assertive"')
  })

  it('shows at most three cards and folds the rest into a count', () => {
    const html = render([view(1), view(2), view(3), view(4)])
    expect(html.match(/data-task-card=/g)).toHaveLength(3)
    expect(html).toContain('1 more task')
  })

  it('never renders an argument: views carry none, and the copy is the action label only', () => {
    expect(render([view(1)])).not.toMatch(/Groceries|argsHash|desktop-action:/)
  })
})
