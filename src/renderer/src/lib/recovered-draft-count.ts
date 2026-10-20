import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react'

/**
 * The renderer half of the recovered-draft count (main half: src/main/recovered-draft-count.ts).
 *
 * The visible count belongs to one owner: the signed-in state plus the active profile. When either changes,
 * the count is cleared and the revision floor is reset, so a snapshot published for the previous owner can
 * never reappear. Within one owner, a snapshot is applied only when its revision is at least the last one
 * applied, so a slow snapshot query cannot overwrite a newer push.
 */

export interface RecoveredDraftSnapshot {
  count: number
  revision: number
}

export function recoveredDraftOwnerKey(signedIn: boolean | undefined, profileName: string | undefined): string {
  return `${signedIn === true ? 'signed-in' : 'signed-out'}:${profileName ?? ''}`
}

export class RecoveredDraftCountGate {
  #owner: string | null = null
  #revision = -1

  /** Binds the current owner. Returns true when it replaced a different owner, so the caller clears its count. */
  bindOwner(owner: string): boolean {
    const changed = this.#owner !== null && this.#owner !== owner
    if (changed) this.#revision = -1
    this.#owner = owner
    return changed
  }

  /** True when the snapshot is well formed and not older than the last applied revision; it is then applied. */
  accept({ count, revision }: RecoveredDraftSnapshot): boolean {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(revision) || revision < this.#revision) {
      return false
    }
    this.#revision = revision
    return true
  }
}

/** Subscribes to pushed counts and queries the authenticated snapshot once per owner binding. */
export function useRecoveredDraftCount(
  signedIn: boolean | undefined,
  profileName: string | undefined
): [number, Dispatch<SetStateAction<number>>] {
  const [count, setCount] = useState(0)
  const gateRef = useRef<RecoveredDraftCountGate | null>(null)
  if (gateRef.current === null) gateRef.current = new RecoveredDraftCountGate()

  useEffect(() => {
    let active = true
    const gate = gateRef.current as RecoveredDraftCountGate
    if (gate.bindOwner(recoveredDraftOwnerKey(signedIn, profileName))) setCount(0)
    const acceptCount = (snapshot: RecoveredDraftSnapshot): void => {
      if (active && gate.accept(snapshot)) setCount(snapshot.count)
    }
    const unsubscribe = window.toto.onTranscriptsRecovered(acceptCount)
    void window.toto
      .recoveredDraftCount()
      .then(acceptCount)
      .catch(() => {})
    return () => {
      active = false
      unsubscribe()
    }
  }, [signedIn, profileName])

  return [count, setCount]
}
