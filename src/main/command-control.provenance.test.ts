import { describe, expect, it, vi } from 'vitest'
import { CommandControl } from './command-control'
import { previewForDesktopAction, previewFromOutside } from '@shared/command-preview'

const execute = vi.fn(async () => ({ id: 'desktop.create_note' as const, ok: true, outcome: 'unknown' as const }))
const make = (): CommandControl => new CommandControl({ platform: 'darwin', execute, policyAllows: () => true })
const note = { id: 'desktop.create_note' as const, args: { title: 'Synthetic note', body: 'Body text' } }

describe('outside-origin previews (G37)', () => {
  it('states that another app asks, and keeps the title quoted as the argument', () => {
    const base = previewForDesktopAction(note, 'darwin')!
    const outside = previewFromOutside(base)
    expect(outside.preview.title).toBe('Another app asks Métis to create a note')
    expect(outside.preview.argument).toBe('Synthetic note')
    expect(outside.preview.detail).toBe('Body text')
    expect(outside.actionId).toBe('desktop.create_note')
  })

  it('a proposal with external provenance publishes that card; an ordinary one does not', () => {
    const external = make()
    external.propose({ webContentsId: 1, revision: 1 }, note, { provenance: 'external' })
    const state = external.getState()
    expect(state.proposalId).not.toBeNull()
    if (state.proposalId) expect(state.preview.title).toBe('Another app asks Métis to create a note')
    const own = make()
    own.propose({ webContentsId: 1, revision: 1 }, note)
    const ownState = own.getState()
    if (ownState.proposalId) expect(ownState.preview.title).not.toContain('Another app')
  })

  it('reports a pending proposal so an outside request can refuse to replace it', () => {
    const c = make()
    expect(c.hasPendingProposal()).toBe(false)
    c.propose({ webContentsId: 1, revision: 1 }, note)
    expect(c.hasPendingProposal()).toBe(true)
  })

  it('an external proposal never replaces an existing card or a confirmed action (final install fence)', () => {
    const c = make()
    const owner = c.propose({ webContentsId: 1, revision: 1 }, note)
    const before = c.getState()
    expect(() => c.propose({ webContentsId: 1, revision: 2 }, note, { provenance: 'external' })).toThrow('busy')
    expect(c.getState()).toEqual(before)
    expect(c.getState().proposalId).toBe(owner.proposalId)
  })

  it('an owner proposal still replaces the previous card', () => {
    const c = make()
    const first = c.propose({ webContentsId: 1, revision: 1 }, note)
    const second = c.propose({ webContentsId: 1, revision: 2 }, note)
    expect(second.proposalId).not.toBe(first.proposalId)
  })
})
