/**
 * Task cards (Métis 2.12 G33): the renderer-safe view of a live desktop task and the words the card shows. Pure.
 *
 * Main owns the truth (DesktopActionTaskBridge, G32 scheduler) and projects each task to one card. A card carries an
 * opaque card id that main maps back to its task; the renderer never sees a task id, a grant, an args hash, an owner
 * or any argument (a note title, a query). Copy is sentence case, specific and never "Error" (V04 copy rules).
 * Design: _relay evidence G33-TASK-CARD-DESIGN.md.
 */
import { z } from 'zod'
import { desktopActionLabel } from './command-preview'

export const TASK_CARD_IPC = {
  /** main → owner window: the full card list whenever it changes. */
  cards: 'tasks:cards',
  /** renderer → main: the current list (on mount). */
  list: 'tasks:list',
  /** renderer → main: stop one card's task. */
  stop: 'tasks:stop',
  /** renderer → main: dismiss a finished card. */
  dismiss: 'tasks:dismiss'
} as const

export const TASK_CARD_PHASES = ['queued', 'running', 'stopping', 'done', 'not_done', 'uncertain'] as const
export type TaskCardPhase = (typeof TASK_CARD_PHASES)[number]

export const TASK_CARD_LIMIT = 32
/** A finished card that needs no decision leaves on its own after this long (the exit animation is extra). */
export const TASK_CARD_DONE_LINGER_MS = 4_000
export const TASK_CARD_NOT_DONE_LINGER_MS = 30_000

const CardIdSchema = z.string().regex(/^[0-9a-f]{32}$/)

const StepSchema = z
  .object({ done: z.number().int().min(0), total: z.number().int().min(1).max(64) })
  .strict()
  .refine((step) => step.done <= step.total)

export const TaskCardViewSchema = z
  .object({
    cardId: CardIdSchema,
    actionId: z.string().min(1).max(64),
    phase: z.enum(TASK_CARD_PHASES),
    /** Known only for a multi-step task; a single action has no step count and shows none. */
    step: StepSchema.optional(),
    /** Why a not_done card did nothing, when main knows. */
    reason: z.enum(['stopped_before_start', 'refused']).optional(),
    stoppable: z.boolean(),
    dismissible: z.boolean()
  })
  .strict()

export type TaskCardView = z.infer<typeof TaskCardViewSchema>

export const TaskCardListSchema = z.array(TaskCardViewSchema).max(TASK_CARD_LIMIT)

export const TaskCardIdInputSchema = z.object({ cardId: CardIdSchema }).strict()

export interface TaskCardCopy {
  title: string
  status: string
}

export function taskCardCopy(view: TaskCardView): TaskCardCopy {
  const title = desktopActionLabel(view.actionId) ?? 'Desktop action'
  return { title, status: statusOf(view) }
}

function statusOf(view: TaskCardView): string {
  switch (view.phase) {
    case 'queued':
      return 'Waiting for the current task'
    case 'running':
      return view.step && view.step.done < view.step.total
        ? `Step ${view.step.done + 1} of ${view.step.total}`
        : 'Working…'
    case 'stopping':
      return 'Stopping. Anything already done stays done.'
    case 'done':
      return 'Done.'
    case 'not_done':
      return view.reason === 'stopped_before_start' ? 'Stopped before it started.' : 'Nothing was done.'
    case 'uncertain':
      return "Métis can't confirm this finished. Check before trying again."
  }
}

/** What a live region says when a card changes. Uncertainty interrupts; everything else waits its turn. */
export function taskCardAnnouncement(view: TaskCardView): { politeness: 'polite' | 'assertive'; text: string } {
  const { title, status } = taskCardCopy(view)
  return { politeness: view.phase === 'uncertain' ? 'assertive' : 'polite', text: `${title}. ${status}` }
}
