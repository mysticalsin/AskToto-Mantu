import { describe, expect, it } from 'vitest'
import { BUILTIN_MODE_LABELS, CONVERSATION_MODES } from '@shared/ipc'
import {
  AssistantEntitySchema,
  assistantIdFor,
  idempotencyKeyFor,
  mapMeetingsToAssistants,
  normalizeDraft,
  previewHashFor,
  systemAssistants,
  viewOf
} from './assistant-model'

const SCOPE = { ownerKey: 'a'.repeat(64), tenantKey: '1'.repeat(64) }

describe('assistant model (G48)', () => {
  it('normalizes a draft the same way every time: NFC, trimmed, collapsed name, no control characters', () => {
    const a = normalizeDraft({ name: '  Café   Coach ', base: 'sales', instructions: ' Be brief.\u0007\n ' })
    expect(a).toEqual({ name: 'Café Coach', base: 'sales', instructions: 'Be brief.' })
    expect(normalizeDraft(a)).toEqual(a)
  })

  it('derives the idempotency key and id from owner, tenant and the normalized draft only', () => {
    const draft = normalizeDraft({ name: 'Coach', base: 'sales', instructions: '' })
    const key = idempotencyKeyFor(SCOPE, draft)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(idempotencyKeyFor(SCOPE, { ...draft })).toBe(key)
    expect(idempotencyKeyFor({ ...SCOPE, ownerKey: 'b'.repeat(64) }, draft)).not.toBe(key)
    expect(idempotencyKeyFor({ ...SCOPE, tenantKey: '2'.repeat(64) }, draft)).not.toBe(key)
    expect(idempotencyKeyFor(SCOPE, { ...draft, instructions: 'x' })).not.toBe(key)
    expect(assistantIdFor(key)).toBe(`a_${key.slice(0, 32)}`)
  })

  it('hashes a preview over the ordered normalized items', () => {
    const one = normalizeDraft({ name: 'One', base: 'general', instructions: '' })
    const two = normalizeDraft({ name: 'Two', base: 'general', instructions: '' })
    expect(previewHashFor([one, two])).toMatch(/^[0-9a-f]{64}$/)
    expect(previewHashFor([one, two])).toBe(previewHashFor([one, two]))
    expect(previewHashFor([one, two])).not.toBe(previewHashFor([two, one]))
  })

  it('validates a stored entity strictly and never puts a key in the renderer view', () => {
    const draft = normalizeDraft({ name: 'Coach', base: 'sales', instructions: 'Hi' })
    const key = idempotencyKeyFor(SCOPE, draft)
    const entity = {
      assistantId: assistantIdFor(key),
      ...SCOPE,
      ...draft,
      createdAt: 5,
      updatedAt: 5,
      revision: 1,
      archived: false,
      idempotencyKey: key
    }
    expect(AssistantEntitySchema.safeParse(entity).success).toBe(true)
    expect(AssistantEntitySchema.safeParse({ ...entity, extra: 1 }).success).toBe(false)
    expect(AssistantEntitySchema.safeParse({ ...entity, ownerKey: 'nope' }).success).toBe(false)
    const view = viewOf(entity)
    expect(Object.keys(view).sort()).toEqual(
      ['archived', 'assistantId', 'base', 'createdAt', 'instructions', 'name', 'revision', 'system', 'updatedAt'].sort()
    )
    expect(JSON.stringify(view)).not.toContain(SCOPE.ownerKey)
    expect(JSON.stringify(view)).not.toContain(key)
  })

  it('exposes every built-in mode, then the custom modes, as read-only system assistants', () => {
    const system = systemAssistants([{ id: 'custom-1', label: 'My Mode' }])
    expect(system.slice(0, CONVERSATION_MODES.length).map((s) => s.base)).toEqual([...CONVERSATION_MODES])
    for (const mode of CONVERSATION_MODES) {
      const found = system.find((s) => s.assistantId === `sys-${mode}`)
      expect(found).toMatchObject({ name: BUILTIN_MODE_LABELS[mode], system: true, archived: false, revision: 1 })
    }
    expect(system.at(-1)).toMatchObject({ assistantId: 'sys-custom-1', name: 'My Mode', system: true })
  })

  it('maps meetings to system assistants one to one and never changes a meeting id', () => {
    const meetings = [
      { file: '2026-10-01-a.md', mode: 'sales' },
      { file: '2026-10-02-b.md', mode: 'custom-1' },
      { file: '2026-10-03-c.md', mode: 'deleted-mode' },
      { file: '2026-10-04-d.md', mode: '' }
    ]
    const mapping = mapMeetingsToAssistants(meetings, [{ id: 'custom-1', label: 'My Mode' }])
    expect(mapping.map((m) => m.meetingId)).toEqual(meetings.map((m) => m.file))
    expect(mapping.map((m) => [m.assistantId, m.exact])).toEqual([
      ['sys-sales', true],
      ['sys-custom-1', true],
      ['sys-general', false],
      ['sys-general', false]
    ])
  })
})
