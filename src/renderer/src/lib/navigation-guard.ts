export type NavigationGuardChoice = 'save' | 'discard' | 'cancel'

export type NavigationGuardRequest = {
  id: number
  title: string
  message: string
  /** 'confirm' is a two-button alert (Cancel + one verb action, resolved as 'save'); the default is the
   *  three-way save/discard/cancel sheet. */
  kind?: 'save-discard' | 'confirm'
  saveLabel?: string
  discardLabel?: string
  cancelLabel?: string
  /** Three-way: styles Discard as destructive. Confirm: styles the action as destructive and focuses Cancel,
   *  so Return never confirms a destructive consequence the person did not deliberately choose. */
  destructive?: boolean
}

/** Input for a two-button confirmation: a one- or two-word verb title for the action, Cancel for the other. */
export type ConfirmActionInput = {
  title: string
  message: string
  confirmLabel: string
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

/** Ask a two-button confirmation through the shared sheet; true only when the person chose the action. */
export async function confirmAction(service: NavigationGuardService, input: ConfirmActionInput): Promise<boolean> {
  const choice = await service.request({
    kind: 'confirm',
    title: input.title,
    message: input.message,
    saveLabel: input.confirmLabel,
    cancelLabel: 'Cancel',
    destructive: input.destructive
  })
  return choice === 'save'
}
