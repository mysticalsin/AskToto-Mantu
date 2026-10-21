/**
 * confirm-context.ts — how a Settings control asks for confirmation without prop-drilling the navigation guard.
 *
 * Each overlay window renders exactly one ConfirmSheet host (App.tsx). That host registers its guard here while it
 * is mounted, and `useConfirm()` routes every confirmation to it, so Settings sections, the Bar's Repair chip and
 * any later surface share one sheet, one queue and one keyboard contract. A test (or a future surface) can wrap a
 * subtree in `ConfirmContext.Provider` to supply its own confirm function.
 *
 * With no host mounted (a standalone render), a confirmation resolves as confirmed, which is exactly the behaviour
 * these controls had before they asked: nothing is silently blocked.
 */
import { createContext, useContext } from 'react'
import { confirmAction, type ConfirmActionInput, type NavigationGuardService } from '../lib/navigation-guard'

export type ConfirmFn = (input: ConfirmActionInput) => Promise<boolean>

let host: NavigationGuardService | null = null

/** Called by the mounted ConfirmSheet host; returns the unregister function for its cleanup. */
export function registerConfirmHost(guard: NavigationGuardService): () => void {
  host = guard
  return () => {
    if (host === guard) host = null
  }
}

/** Confirm through the registered sheet host. */
export const confirmThroughHost: ConfirmFn = (input) => (host ? confirmAction(host, input) : Promise.resolve(true))

export const ConfirmContext = createContext<ConfirmFn>(confirmThroughHost)

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext)
}
