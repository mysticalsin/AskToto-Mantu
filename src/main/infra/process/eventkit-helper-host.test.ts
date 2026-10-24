import { describe, expect, it, vi } from 'vitest'
import { createEventKitHost, type EventKitRun } from './eventkit-helper-host'

const INPUT = {
  subject: 'Board sync',
  body: 'agenda',
  startIso: '2026-10-25T10:00:00Z',
  endIso: '2026-10-25T11:00:00Z'
}

function host(run: EventKitRun, platform: NodeJS.Platform = 'darwin', helperPath: string | null = '/helper') {
  return createEventKitHost({ platform, helperPath: () => helperPath, run })
}
const reply = (stdout: string, extra: Partial<Awaited<ReturnType<EventKitRun>>> = {}): EventKitRun =>
  vi.fn(async () => ({ spawned: true, timedOut: false, exitCode: 0, stdout, ...extra }))

describe('eventkit helper host', () => {
  it('event fields go on stdin, never in argv', async () => {
    const run = reply('{"ok":true,"id":"EK1"}')
    await host(run).create(INPUT)
    const [command, args, stdin] = vi.mocked(run).mock.calls[0]
    expect(command).toBe('/helper')
    expect(args).toEqual(['calendar-event-create'])
    expect(JSON.stringify(args)).not.toContain('Board sync')
    expect(JSON.parse(stdin ?? '{}')).toEqual(INPUT)
  })

  it('maps created, permission and failed replies', async () => {
    expect(await host(reply('{"ok":true,"id":"EK1"}')).create(INPUT)).toEqual({ kind: 'created', id: 'EK1' })
    expect(await host(reply('{"ok":false,"error":"permission"}')).create(INPUT)).toEqual({ kind: 'permission' })
    expect(await host(reply('{"ok":false,"error":"save_failed"}')).create(INPUT)).toEqual({ kind: 'failed' })
  })

  it('timeout, crash or unreadable reply on create is uncertain (the save may have happened)', async () => {
    expect(await host(reply('', { timedOut: true, exitCode: null })).create(INPUT)).toEqual({ kind: 'uncertain' })
    expect(await host(reply('', { exitCode: 1 })).create(INPUT)).toEqual({ kind: 'uncertain' })
    expect(await host(reply('not json')).create(INPUT)).toEqual({ kind: 'uncertain' })
  })

  it('a helper that never started is unavailable, not uncertain', async () => {
    expect(await host(reply('', { spawned: false, exitCode: null })).create(INPUT)).toEqual({ kind: 'unavailable' })
  })

  it('non-darwin or a missing helper is unavailable and nothing is spawned', async () => {
    const run = reply('{}')
    expect(await host(run, 'win32').create(INPUT)).toEqual({ kind: 'unavailable' })
    expect(await host(run, 'darwin', null).status()).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('status and ask parse the permission and reject unknown values', async () => {
    expect(await host(reply('{"status":"writeOnly"}')).status()).toBe('writeOnly')
    expect(await host(reply('{"status":"granted"}')).status()).toBeNull()
    const run = reply('{"status":"fullAccess"}')
    expect(await host(run).ask()).toBe('fullAccess')
    expect(vi.mocked(run).mock.calls[0][1]).toEqual(['calendar-access-ask'])
  })

  it('read returns the event facts, or missing', async () => {
    const found = await host(
      reply(
        '{"ok":true,"subject":"Board sync","startIso":"2026-10-25T10:00:00Z","endIso":"2026-10-25T11:00:00Z","cancelled":false}'
      )
    ).read('EK1')
    expect(found).toEqual({
      kind: 'found',
      subject: 'Board sync',
      startIso: INPUT.startIso,
      endIso: INPUT.endIso,
      cancelled: false
    })
    expect(await host(reply('{"ok":false,"error":"not_found"}')).read('EK1')).toEqual({ kind: 'missing' })
    expect(await host(reply('', { timedOut: true, exitCode: null })).read('EK1')).toEqual({ kind: 'unknown' })
  })

  it('never logs helper output', async () => {
    const spy = vi.spyOn(console, 'log')
    await host(reply('{"ok":true,"id":"SECRET-ID"}')).create(INPUT)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
