import { describe, expect, it, vi } from 'vitest'
import type { PrepareSavedReplacement } from './atomic-saved-write'
import { writeWithAdmission } from './write-with-admission'

describe('writeWithAdmission', () => {
  it('classifies a captured rename-guard refusal as admission, preserving the exact thrown value', async () => {
    const refusal = Object.freeze({ kind: 'authority-epoch-changed' })
    let runRenameGuard!: () => void
    const write = vi.fn(
      async (_beforeReplace: (() => void) | undefined, prepare: PrepareSavedReplacement | undefined) => {
        const prepared = await prepare?.()
        runRenameGuard = prepared as () => void
        runRenameGuard()
      }
    )

    const result = await writeWithAdmission(undefined, write, async () => () => {
      throw refusal
    })

    expect(write).toHaveBeenCalledOnce()
    expect(result).toEqual({ kind: 'admission-refused', error: refusal })
  })

  it('preserves falsy synchronous captured refusals without treating them as I/O failure', async () => {
    for (const refusal of [undefined, null]) {
      const result = await writeWithAdmission(
        undefined,
        async (_beforeReplace, prepare) => {
          const guard = await prepare?.()
          guard?.()
        },
        async () => () => {
          throw refusal
        }
      )
      expect(result).toEqual({ kind: 'admission-refused', error: refusal })
    }
  })
})
