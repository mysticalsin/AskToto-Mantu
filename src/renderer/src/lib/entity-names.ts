import { useCallback, useEffect, useMemo, useState } from 'react'
import { createLatestGate } from './latest-request'

/**
 * The canonical people/account names that bias live ASR casing (see lib/entity-casing.ts). `refresh()` reads
 * them again from main; only the newest answer is applied, and an answer that lands after unmount is dropped.
 * The caller refreshes when a meeting saves and when one starts, so a rename in the brain reaches the next
 * session instead of waiting for the next save.
 */
export function useBrainEntityNames(): { names: string[]; refresh: () => void } {
  const [names, setNames] = useState<string[]>([])
  const gate = useMemo(createLatestGate, [])
  const refresh = useCallback((): void => {
    const token = gate.begin()
    void window.toto
      .brainEntityNames()
      .then((r) => {
        if (gate.isLatest(token)) setNames(r.names)
      })
      .catch(() => {})
  }, [gate])
  useEffect(() => () => gate.cancel(), [gate])
  return { names, refresh }
}
