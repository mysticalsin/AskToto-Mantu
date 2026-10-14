export interface SpeechPackOperation<T> {
  id: T
  transaction: symbol
}

/** Serializes component operations and retains their opaque admission token through settlement. */
export class SpeechPackOperationQueue<T> {
  private readonly pending: Array<SpeechPackOperation<T>> = []
  private active: SpeechPackOperation<T> | null = null
  private waiters: Array<() => void> = []

  constructor(private readonly execute: (operation: SpeechPackOperation<T>) => Promise<void>) {}

  get current(): SpeechPackOperation<T> | null {
    return this.active
  }

  isRunning(id: T): boolean {
    return this.active?.id === id
  }

  enqueue(operation: SpeechPackOperation<T>, first = false): void {
    if (first) this.pending.unshift(operation)
    else this.pending.push(operation)
    this.pump()
  }

  remove(id: T): SpeechPackOperation<T> | undefined {
    const index = this.pending.findIndex((operation) => operation.id === id)
    if (index < 0) return undefined
    const [removed] = this.pending.splice(index, 1)
    this.resolveIdle()
    return removed
  }

  whenIdle(): Promise<void> {
    if (!this.active && this.pending.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private pump(): void {
    if (this.active) return
    const next = this.pending.shift()
    if (!next) return this.resolveIdle()
    this.active = next
    void this.execute(next).finally(() => {
      this.active = null
      this.pump()
    })
  }

  private resolveIdle(): void {
    if (this.active || this.pending.length > 0) return
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
}
