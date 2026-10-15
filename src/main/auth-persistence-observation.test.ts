import { describe, expect, it, vi } from 'vitest'
import {
  captureExplicitMainPersistenceSessionBoundary,
  capturePublishedMainPersistenceSessionBoundary,
  isPersistenceSettingsReceiptCurrent,
  retireAuthStatusPersistenceObservation
} from './auth-persistence-observation'

const receiptState = vi.hoisted(() => ({ current: null as object | null, calls: 0 }))
vi.mock('./settings-authority-history', () => ({
  isSettingsAuthorityCurrent: (receipt: object) => {
    receiptState.calls += 1
    return receiptState.current === receipt
  }
}))

describe('C1 persistence observation adapter', () => {
  it('keeps cached capture as a memory-only controller delegation', () => {
    const cached = Object.freeze({ isCurrent: () => true })
    const controller = {
      capturePublishedMainPersistenceSessionBoundary: vi.fn(() => cached),
      retireMainPersistenceIfStatusDisagrees: vi.fn(),
      captureMainPersistenceSessionBoundary: vi.fn()
    }

    expect(capturePublishedMainPersistenceSessionBoundary(controller as never)).toBe(cached)
    expect(controller.capturePublishedMainPersistenceSessionBoundary).toHaveBeenCalledOnce()
    expect(controller.retireMainPersistenceIfStatusDisagrees).not.toHaveBeenCalled()
    expect(controller.captureMainPersistenceSessionBoundary).not.toHaveBeenCalled()
  })

  it('keeps the legacy explicit boundary separate from auth-status retirement', () => {
    const boundary = Object.freeze({ isCurrent: () => true })
    const controller = {
      capturePublishedMainPersistenceSessionBoundary: vi.fn(() => null),
      retireMainPersistenceIfStatusDisagrees: vi.fn(),
      captureMainPersistenceSessionBoundary: vi.fn(() => boundary)
    }
    const status = { configured: true, signedIn: false, enforced: true }
    const config = { clientId: 'client', tenantId: 'tenant', allowedDomain: 'example.test' }

    expect(captureExplicitMainPersistenceSessionBoundary(controller as never, status, config, false)).toBe(boundary)
    expect(controller.captureMainPersistenceSessionBoundary).toHaveBeenCalledWith({
      config,
      enforced: true,
      sticky: false
    })
    retireAuthStatusPersistenceObservation(controller as never, null, false, false)
    expect(controller.retireMainPersistenceIfStatusDisagrees).toHaveBeenCalledWith(null, false, false)
    expect(controller.capturePublishedMainPersistenceSessionBoundary).not.toHaveBeenCalled()
  })

  it('checks only the supplied in-memory receipt membership predicate', () => {
    const currentReceipt = Object.freeze({})
    receiptState.current = currentReceipt
    receiptState.calls = 0
    expect(isPersistenceSettingsReceiptCurrent(currentReceipt)).toBe(true)
    expect(isPersistenceSettingsReceiptCurrent(Object.freeze({}))).toBe(false)
    expect(receiptState.calls).toBe(2)
  })
})
