import { safeCurrent } from './incremental-meeting-journal-format'

type MutationSlot = { active: boolean; wakeOne?: () => void }
export type MutationLockResult<T> = { status: 'ok'; value: T } | { status: 'busy' | 'stale-owner' }

const slots = new Map<string, MutationSlot>()

/** One active mutation and one waiter per physical meeting; idle entries are immediately removed. */
export async function withIncrementalMeetingMutation<T>(
  key: string,
  isCurrent: () => boolean,
  operation: () => Promise<T>
): Promise<MutationLockResult<T>> {
  if (!safeCurrent(isCurrent)) return { status: 'stale-owner' }
  let slot = slots.get(key)
  if (!slot) {
    slot = { active: false }
    slots.set(key, slot)
  }
  if (slot.active) {
    if (slot.wakeOne) return { status: 'busy' }
    let wake!: () => void
    const waiting = new Promise<void>((resolve) => {
      wake = resolve
    })
    slot.wakeOne = wake
    await waiting
    if (!safeCurrent(isCurrent)) {
      release(slot, key)
      return { status: 'stale-owner' }
    }
  } else {
    slot.active = true
  }
  try {
    if (!safeCurrent(isCurrent)) return { status: 'stale-owner' }
    return { status: 'ok', value: await operation() }
  } finally {
    release(slot, key)
  }
}

function release(slot: MutationSlot, key: string): void {
  if (slot.wakeOne) {
    const wake = slot.wakeOne
    slot.wakeOne = undefined
    wake()
    return
  }
  slot.active = false
  if (slots.get(key) === slot) slots.delete(key)
}
