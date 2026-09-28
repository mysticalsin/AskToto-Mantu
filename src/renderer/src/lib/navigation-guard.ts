export type NavigationGuardChoice = 'save' | 'discard' | 'cancel'

export type NavigationGuardRequest = {
  id: number
  title: string
  message: string
  saveLabel?: string
  discardLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

type PendingRequest = {
  request: NavigationGuardRequest
  resolve: (choice: NavigationGuardChoice) => void
}

type Listener = () => void

export class NavigationGuardService {
  private nextId = 1
  private pending: PendingRequest | null = null
  private queue: PendingRequest[] = []
  private listeners = new Set<Listener>()
  private reveal: () => void

  constructor(reveal: () => void = () => {}) {
    this.reveal = reveal
  }

  current(): NavigationGuardRequest | null {
    return this.pending?.request ?? null
  }

  setReveal(reveal: () => void): void {
    this.reveal = reveal
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  request(input: Omit<NavigationGuardRequest, 'id'>): Promise<NavigationGuardChoice> {
    return new Promise((resolve) => {
      const pending = { request: { ...input, id: this.nextId++ }, resolve }
      if (this.pending) {
        this.queue.push(pending)
        return
      }
      this.show(pending)
    })
  }

  choose(choice: NavigationGuardChoice, id = this.pending?.request.id): void {
    if (!this.pending || id !== this.pending.request.id) return
    const active = this.pending
    this.pending = null
    active.resolve(choice)
    this.showNext()
  }

  private show(pending: PendingRequest): void {
    this.reveal()
    this.pending = pending
    this.emit()
  }

  private showNext(): void {
    const next = this.queue.shift()
    if (!next) {
      this.emit()
      return
    }
    this.show(next)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export async function confirmNavigation(
  service: NavigationGuardService,
  input: Omit<NavigationGuardRequest, 'id'>
): Promise<NavigationGuardChoice> {
  return service.request(input)
}
