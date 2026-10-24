import { describe, expect, it } from 'vitest'
import { DATA_STORES } from '@shared/data-store-inventory'
import type { ErasureReceipt, PreviewResult } from '@shared/data-rights'
import { erasureConfirmation, exceptionText, receiptSummary, refusalText } from './data-rights-copy'

const preview = (meetings?: number): Extract<PreviewResult, { ok: true }> => ({
  ok: true,
  proposalId: 'a'.repeat(32),
  previewHash: 'b'.repeat(64),
  expiresAt: 1,
  items: DATA_STORES.map((entry) => ({
    store: entry.id,
    label: entry.label,
    policy: entry.erase,
    ...(entry.id === 'meetings' && meetings !== undefined ? { count: meetings } : {})
  }))
})

describe('data rights copy (G82)', () => {
  it('the erase confirm card is destructive, counts meetings and warns about copies it cannot remove', () => {
    const card = erasureConfirmation(preview(3))
    expect(card.destructive).toBe(true)
    expect(card.message).toContain('3 saved meetings')
    expect(card.message).toContain('cloud or on other devices')
    expect(erasureConfirmation(preview(1)).message).toContain('1 saved meeting,')
    expect(erasureConfirmation(preview()).message).toContain('every saved meeting')
  })

  it('every exception code an inventory row can carry has plain text', () => {
    for (const entry of DATA_STORES.filter((e) => e.reason)) {
      expect(exceptionText(entry.reason as string), entry.id).not.toBe('Not removed.')
    }
  })

  it('a receipt summary de-duplicates notes and says how many failed', () => {
    const receipt: ErasureReceipt = {
      receiptId: 'c'.repeat(32),
      startedAt: 1,
      finishedAt: 2,
      stores: [
        { store: 'meetings', outcome: 'erased', count: 2 },
        { store: 'assistants', outcome: 'failed' }
      ],
      exceptions: [
        { store: 'assistants', code: 'erase-failed' },
        { store: 'brain', code: 'erase-failed' }
      ],
      failed: 1
    }
    const summary = receiptSummary(receipt)
    expect(summary.headline).toBe('Erased 1 place; 1 could not be erased.')
    expect(summary.notes).toEqual(['Métis could not erase this part.'])
  })

  it('refusals are plain and carry no detail', () => {
    expect(refusalText('meeting-recording')).toContain('Stop the meeting')
    expect(refusalText('anything-else')).toBe("Couldn't do that. Try again.")
  })
})
