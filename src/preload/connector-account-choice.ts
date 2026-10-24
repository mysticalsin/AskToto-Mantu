import type { IpcRenderer } from 'electron'
import {
  ACCOUNT_CHOICE_IPC,
  AccountChoiceCancelResponseSchema,
  AccountChoiceCancellationSchema,
  AccountChoiceDecisionResponseSchema,
  AccountChoiceDecisionSchema,
  AccountChoiceStateSchema,
  type AccountChoiceCancellation,
  type AccountChoiceDecision,
  type AccountChoiceDecisionResponse,
  type AccountChoiceState
} from '../shared/connector-account-choice'

type Unsub = () => void
const NONE: AccountChoiceState = { choiceId: null }
const INVALID = { ok: false, reason: 'invalid_input' } as const

/**
 * `window.toto.accountChoice` (G62): the ambiguity choice card. Main owns the card and the pending operation; the
 * renderer only sees the safe account views and echoes the card's ids back with the account the person picked.
 * Every reply and push is validated here and a malformed one is dropped, never repaired.
 */
export function createAccountChoicePreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  accountChoice: {
    current(): Promise<AccountChoiceState>
    decide(input: AccountChoiceDecision): Promise<AccountChoiceDecisionResponse>
    cancel(input: AccountChoiceCancellation): Promise<{ ok: boolean }>
    onChanged(listener: (state: AccountChoiceState) => void): Unsub
  }
} {
  return {
    accountChoice: {
      async current() {
        try {
          const parsed = AccountChoiceStateSchema.safeParse(await ipc.invoke(ACCOUNT_CHOICE_IPC.current))
          return parsed.success ? parsed.data : NONE
        } catch {
          return NONE
        }
      },
      async decide(input) {
        const payload = AccountChoiceDecisionSchema.safeParse(input)
        if (!payload.success) return INVALID
        try {
          const parsed = AccountChoiceDecisionResponseSchema.safeParse(
            await ipc.invoke(ACCOUNT_CHOICE_IPC.decide, payload.data)
          )
          return parsed.success ? parsed.data : INVALID
        } catch {
          return INVALID
        }
      },
      async cancel(input) {
        const payload = AccountChoiceCancellationSchema.safeParse(input)
        if (!payload.success) return { ok: false }
        try {
          const parsed = AccountChoiceCancelResponseSchema.safeParse(
            await ipc.invoke(ACCOUNT_CHOICE_IPC.cancel, payload.data)
          )
          return parsed.success ? parsed.data : { ok: false }
        } catch {
          return { ok: false }
        }
      },
      onChanged(listener) {
        const handler = (_event: unknown, payload: unknown): void => {
          const parsed = AccountChoiceStateSchema.safeParse(payload)
          if (!parsed.success) return
          try {
            listener(parsed.data)
          } catch {
            /* a throwing subscriber must not break the bridge */
          }
        }
        ipc.on(ACCOUNT_CHOICE_IPC.state, handler)
        return () => ipc.removeListener(ACCOUNT_CHOICE_IPC.state, handler)
      }
    }
  }
}
