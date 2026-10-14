import type {
  CloudSpeechEvent,
  CloudSpeechFailure,
  CloudSpeechCaptureCeilingEvent,
  CloudSpeechEpochTransitionEvent
} from '@shared/cloud-speech'

export function createCloudSpeechEventQueue(options: {
  validate(raw: unknown): CloudSpeechEvent | null
  validateState(event: CloudSpeechEvent): boolean
  inactive(): boolean
  maxPending: number
  invalidate(code: CloudSpeechFailure['code']): void
  processTransition(event: CloudSpeechEpochTransitionEvent): Promise<void>
  processCeiling(event: CloudSpeechCaptureCeilingEvent): void
  apply(
    event: Exclude<CloudSpeechEvent, CloudSpeechEpochTransitionEvent | CloudSpeechCaptureCeilingEvent>
  ): void | Promise<void>
  markApplied(event: Exclude<CloudSpeechEvent, CloudSpeechEpochTransitionEvent | CloudSpeechCaptureCeilingEvent>): void
  notify(): void
}) {
  let tail = Promise.resolve()
  let pending = 0

  const handle = (raw: unknown): void => {
    if (options.inactive()) return
    if (pending >= options.maxPending) {
      options.invalidate('QUEUE_LIMIT')
      return
    }
    const event = options.validate(raw)
    if (!event) {
      options.invalidate('STALE')
      return
    }
    pending += 1
    tail = tail
      .then(async () => {
        if (options.inactive()) return
        if (!options.validateState(event)) {
          options.invalidate('STALE')
          return
        }
        if (event.type === 'epoch-transition') {
          await options.processTransition(event)
          return
        }
        if (event.type === 'capture-ceiling') {
          options.processCeiling(event)
          return
        }
        await options.apply(event)
        options.markApplied(event)
      })
      .catch(() => options.invalidate('TRANSPORT'))
      .finally(() => {
        pending -= 1
        options.notify()
      })
  }

  return { handle, tail: () => tail }
}
