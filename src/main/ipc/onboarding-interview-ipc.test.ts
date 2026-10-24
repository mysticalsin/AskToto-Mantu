import { describe, expect, it, vi } from 'vitest'
import { ONBOARDING_INTERVIEW_IPC, draftsFromAnswers } from '@shared/onboarding-interview'
import { registerOnboardingInterviewIpc } from './onboarding-interview-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'
import { harness, open, seal } from '../features/assistants/__fixtures__/assistant-harness'
import { createInterviewService, createInterviewStore } from '../features/onboarding'

function setup(options: { signedIn?: boolean; refuse?: boolean } = {}) {
  const h = harness()
  const service = createInterviewService({
    store: createInterviewStore({ io: h.io, seal, open, scope: () => h.current.scope }),
    scope: () => h.current.scope,
    assistants: h.newService(),
    now: () => h.clock.now
  })
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const surfaces: Array<{ surface: string; requireOwner: boolean; allowedFrames: string }> = []
  const authorizeSender = ((_event: unknown, o: { surface: string; requireOwner: boolean; allowedFrames: string }) => {
    surfaces.push(o)
    if (options.refuse) throw new SenderRefusal('wrong-window', o.surface)
    return null
  }) as unknown as AuthorizeSender
  const save = vi.spyOn(service, 'save')
  registerOnboardingInterviewIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => options.signedIn ?? true,
    service
  })
  return { save, surfaces, handlers, call: (channel: string, raw?: unknown) => handlers.get(channel)!({}, raw) }
}

describe('onboarding interview IPC (G56)', () => {
  it('registers every channel behind the main-window top-frame owner gate', async () => {
    const t = setup()
    expect([...t.handlers.keys()].sort()).toEqual(Object.values(ONBOARDING_INTERVIEW_IPC).sort())
    for (const channel of Object.values(ONBOARDING_INTERVIEW_IPC)) await t.call(channel)
    expect(t.surfaces).toHaveLength(Object.values(ONBOARDING_INTERVIEW_IPC).length)
    for (const s of t.surfaces) expect(s).toMatchObject({ requireOwner: true, allowedFrames: 'main-window-top' })
  })

  it('refuses a sender that is not the main window top frame', async () => {
    const t = setup({ refuse: true })
    await expect(t.call(ONBOARDING_INTERVIEW_IPC.load)).rejects.toBeInstanceOf(SenderRefusal)
    await expect(t.call(ONBOARDING_INTERVIEW_IPC.confirm, {})).rejects.toBeInstanceOf(SenderRefusal)
  })

  it('answers signed-out when nobody is signed in', async () => {
    const t = setup({ signedIn: false })
    for (const channel of Object.values(ONBOARDING_INTERVIEW_IPC)) {
      expect(await t.call(channel)).toEqual({ ok: false, reason: 'signed-out' })
    }
  })

  it('an unknown key is invalid and never reaches the service', async () => {
    const t = setup()
    const body = { status: 'in-progress', step: 1, answers: {}, drafts: [] }
    expect(await t.call(ONBOARDING_INTERVIEW_IPC.save, { ...body, ownerKey: 'a'.repeat(64) })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await t.call(ONBOARDING_INTERVIEW_IPC.load, { any: 1 })).toEqual({ ok: false, reason: 'invalid' })
    expect(t.save).not.toHaveBeenCalled()
    expect(await t.call(ONBOARDING_INTERVIEW_IPC.save, body)).toMatchObject({ ok: true })
    expect(await t.call(ONBOARDING_INTERVIEW_IPC.propose, { drafts: draftsFromAnswers({}) })).toMatchObject({
      ok: true
    })
  })
})
