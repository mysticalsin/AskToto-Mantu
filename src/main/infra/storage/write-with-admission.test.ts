import { describe, expect, it, vi } from 'vitest'
import { createWriteAdmissionGuard, writeWithAdmission } from './write-with-admission'

describe('saved-write admission capture', () => {
  it('does not invoke admission until the actual synchronous guard boundary', () => {
    const check = vi.fn()
    const admission = createWriteAdmissionGuard(check)
    expect(check).not.toHaveBeenCalled()
    expect(admission.refusal).toBeUndefined()
    expect(admission.guard?.()).toBeUndefined()
    expect(check).toHaveBeenCalledTimes(1)
    expect(admission.refusal).toBeUndefined()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['object', { reason: 'synthetic owner changed' }],
    ['error', new Error('Synthetic owner changed')]
  ] as const)('captures a thrown %s synchronously without changing its identity', (_name, error) => {
    const admission = createWriteAdmissionGuard(() => {
      throw error
    })
    let thrown = false
    let caught: unknown
    try {
      admission.guard?.()
    } catch (value) {
      thrown = true
      caught = value
    }
    expect(thrown).toBe(true)
    expect(caught).toBe(error)
    expect(admission.refusal?.kind).toBe('admission-refused')
    expect(admission.refusal?.error).toBe(error)
  })

  it('keeps writes without an admission callback successful and ordinary failures coarse', async () => {
    const admission = createWriteAdmissionGuard(undefined)
    expect(admission.guard).toBeUndefined()
    expect(admission.refusal).toBeUndefined()
    await expect(
      writeWithAdmission(undefined, async (guard) => {
        expect(guard).toBeUndefined()
      })
    ).resolves.toEqual({ kind: 'written' })
    await expect(
      writeWithAdmission(
        () => {},
        async (guard) => {
          guard?.()
          throw new Error('Synthetic filesystem failure')
        }
      )
    ).resolves.toEqual({ kind: 'write-failed' })
  })

  it.each([
    undefined,
    null,
    0,
    new Error('Synthetic refusal')
  ])('preserves an admission refusal when the writer subsequently throws a different error: %s', async (error) => {
    const result = await writeWithAdmission(
      () => {
        throw error
      },
      async (guard) => {
        try {
          guard?.()
        } catch {
          /* The writer may translate an error before rejecting. */
        }
        throw new Error('Synthetic later write error')
      }
    )
    expect(result.kind).toBe('admission-refused')
    if (result.kind !== 'admission-refused') throw new Error('Expected the admission refusal')
    expect(result.error).toBe(error)
  })

  it('retains the written result when a writer catches a refusal and still resolves', async () => {
    await expect(
      writeWithAdmission(
        () => {
          throw undefined
        },
        async (guard) => {
          try {
            guard?.()
          } catch {
            /* Preserve the existing resolved-write contract. */
          }
        }
      )
    ).resolves.toEqual({ kind: 'written' })
  })
})
