import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { SenderEventLike } from '../ipc/sender-auth'

export const MAIN_URL = 'app://metis/index.html'
export const MAIN_WEB_CONTENTS_ID = 7

export type SenderKind = 'main' | 'wrong-window' | 'subframe' | 'destroyed-sender' | 'destroyed-frame' | 'no-frame'

export function senderEvent(kind: SenderKind): SenderEventLike {
  const sender = {
    id: kind === 'wrong-window' ? 9 : MAIN_WEB_CONTENTS_ID,
    isDestroyed: () => kind === 'destroyed-sender'
  }
  if (kind === 'no-frame') return { sender, senderFrame: null }
  return {
    sender,
    senderFrame: {
      parent: kind === 'subframe' ? {} : null,
      url: MAIN_URL,
      processId: 12,
      routingId: 3,
      isDestroyed: () => kind === 'destroyed-frame'
    }
  }
}

/** Mirrors the index.ts main-window gate and records which check denied. */
export function fakeAssertMainWindow(): { assert: (event: SenderEventLike) => void; denials: string[] } {
  const denials: string[] = []
  const assert = (event: SenderEventLike): void => {
    if (event.sender.id !== MAIN_WEB_CONTENTS_ID) {
      denials.push('sender')
      throw new Error('IPC denied: sender is not the main window')
    }
    const frame = event.senderFrame
    if (!frame || frame.parent !== null || frame.url !== MAIN_URL) {
      denials.push('frame')
      throw new Error('IPC denied: not main frame')
    }
  }
  return { assert, denials }
}

export function validRef(overrides: Partial<OwnerSessionRef> = {}): OwnerSessionRef {
  return Object.freeze({
    v: 1,
    ownerKey: 'a'.repeat(64),
    authGeneration: 5,
    sessionId: '00000000-0000-4000-8000-000000000001',
    frameOwner: '12:3',
    contextRevision: 11,
    issuedAt: 1_700_000_000_000,
    ...overrides
  }) as OwnerSessionRef
}
