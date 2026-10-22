import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { actionEnvelope, isObservedVerified } from './action-guard'
import { CommandControl } from './command-control'
import { executeDesktopAction, type DesktopAdapterDeps, type NoteFileSystem } from './desktop-adapters'
import type { DesktopExecResult } from './infra/process/desktop-exec'

const OK: DesktopExecResult = { ok: true, stdout: '', stderr: '', timedOut: false }
const NO: DesktopExecResult = { ok: false, stdout: '', stderr: '', timedOut: false }
const NOTE_ID = 'x-coredata://6A0C1D2E-0000-4000-8000-000000000000/ICNote/p42'
const SENTINEL = 'synthetic-ack-sentinel-stdout-stderr'

function deps(overrides: Partial<DesktopAdapterDeps> = {}) {
  const exec = vi.fn(async (..._args: Parameters<DesktopAdapterDeps['exec']>): Promise<DesktopExecResult> => OK)
  const spawnGui = vi.fn(async (..._args: Parameters<DesktopAdapterDeps['spawnGui']>) => ({ ok: true }))
  const all: DesktopAdapterDeps = { exec, spawnGui, ...overrides }
  return { exec, spawnGui, all }
}

const envelopeFor = (request: DesktopActionRequest) => actionEnvelope('a'.repeat(32), request)

function frontmost(options: { ready?: boolean; matched?: boolean } = {}) {
  const calls: string[] = []
  const observe = vi.fn((bundleId: string, windowMs: number) => {
    calls.push(`observe:${bundleId}:${windowMs}`)
    return {
      ready: async () => {
        calls.push('ready')
        return options.ready ?? true
      },
      matched: async () => {
        calls.push('matched')
        return options.matched ?? true
      },
      cancel: () => {
        calls.push('cancel')
      }
    }
  })
  return { calls, verifier: { observe } }
}

describe('request boundary', () => {
  it('rejects an invalid request before any process, on every platform', async () => {
    const { exec, spawnGui, all } = deps()
    for (const platform of ['darwin', 'win32'] as const) {
      const long = { id: 'desktop.create_note', args: { title: 't'.repeat(121) } } as DesktopActionRequest
      const result = await executeDesktopAction(long, { platform, deps: all })
      expect(result).toMatchObject({ ok: false, outcome: 'unsupported', detail: 'invalid_arguments' })
    }
    const unknown = await executeDesktopAction({ id: 'shell.exec', args: {} } as never, {
      platform: 'darwin',
      deps: all
    })
    expect(unknown.outcome).toBe('unsupported')
    expect(exec).not.toHaveBeenCalled()
    expect(spawnGui).not.toHaveBeenCalled()
  })

  it.each(['linux' as const, 'other' as const])('stays unsupported on %s without a process', async (platform) => {
    const { exec, spawnGui, all } = deps()
    const result = await executeDesktopAction({ id: 'desktop.open_notes', args: {} }, { platform, deps: all })
    expect(result).toMatchObject({ ok: false, outcome: 'unsupported' })
    expect(exec).not.toHaveBeenCalled()
    expect(spawnGui).not.toHaveBeenCalled()
  })
})

describe('macOS: open an app and prove it came to the front', () => {
  const notes: DesktopActionRequest = { id: 'desktop.open_notes', args: {} }

  it('opens by bundle id with an argv array', async () => {
    const { exec, all } = deps()
    const result = await executeDesktopAction(notes, { platform: 'darwin', deps: all })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('/usr/bin/open', ['-b', 'com.apple.Notes'])
    expect(result).toMatchObject({ ok: true, outcome: 'unknown' })
  })

  it('is verified, with a receipt bound to this dispatch, only when the app is seen in front', async () => {
    const { exec, all } = deps()
    const seen = frontmost()
    const envelope = envelopeFor(notes)
    const result = await executeDesktopAction(notes, {
      platform: 'darwin',
      envelope,
      deps: { ...all, frontmost: seen.verifier }
    })
    expect(result.outcome).toBe('verified')
    expect(result.receipt).toMatchObject({ idempotencyKey: envelope.idempotencyKey, argsHash: envelope.argsHash })
    expect(isObservedVerified(notes, result, envelope)).toBe(true)
    expect(seen.verifier.observe).toHaveBeenCalledWith('com.apple.Notes', 3_000)
    // The stream is ready before the launch, so the activation cannot be missed, and it is always cancelled.
    expect(seen.calls).toEqual(['observe:com.apple.Notes:3000', 'ready', 'matched', 'cancel'])
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('stays unknown without an envelope, when the app never came to the front, or when the stream was not ready', async () => {
    for (const [options, envelope] of [
      [{ matched: true }, undefined],
      [{ matched: false }, envelopeFor(notes)],
      [{ ready: false, matched: true }, envelopeFor(notes)]
    ] as const) {
      const { all } = deps()
      const seen = frontmost(options)
      const result = await executeDesktopAction(notes, {
        platform: 'darwin',
        envelope,
        deps: { ...all, frontmost: seen.verifier }
      })
      expect(result, JSON.stringify(options)).toMatchObject({ ok: true, outcome: 'unknown' })
      expect(result.receipt).toBeUndefined()
      expect(seen.calls.at(-1)).toBe('cancel')
    }
  })

  it('an uncertain launch acknowledgment is unknown, never failed, and is never retried', async () => {
    const { exec, all } = deps()
    exec.mockResolvedValueOnce({ ...NO, stdout: SENTINEL, stderr: SENTINEL })
    const seen = frontmost({ matched: true })
    const result = await executeDesktopAction(notes, {
      platform: 'darwin',
      envelope: envelopeFor(notes),
      deps: { ...all, frontmost: seen.verifier }
    })
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' })
    expect(result.detail).not.toContain(SENTINEL)
    expect(result.preferredMissing).toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(seen.calls).not.toContain('matched')
    expect(seen.calls.at(-1)).toBe('cancel')
  })

  it('Arc: a missing Arc is a visible failure and no other browser is used', async () => {
    const { exec, all } = deps({ macAppInstalled: async () => false })
    const result = await executeDesktopAction({ id: 'desktop.open_arc', args: {} }, { platform: 'darwin', deps: all })
    expect(result).toMatchObject({ ok: false, outcome: 'failed', preferredMissing: true })
    expect(exec).not.toHaveBeenCalled()
  })

  it('Arc: opens by its bundle id and is verified by the frontmost app', async () => {
    const request: DesktopActionRequest = { id: 'desktop.open_arc', args: {} }
    const { exec, all } = deps({ macAppInstalled: async () => true })
    const seen = frontmost()
    const result = await executeDesktopAction(request, {
      platform: 'darwin',
      envelope: envelopeFor(request),
      deps: { ...all, frontmost: seen.verifier }
    })
    expect(exec).toHaveBeenCalledWith('/usr/bin/open', ['-b', 'company.thebrowser.Browser'])
    expect(result.outcome).toBe('verified')
  })
})

describe('macOS: web pages go to the default browser unless Arc was named', () => {
  it('Google search: one https URL as one argv element, in the default browser', async () => {
    const { exec, all } = deps()
    const result = await executeDesktopAction(
      { id: 'desktop.google_search', args: { q: 'Norbert Wiener & "co"' } },
      { platform: 'darwin', deps: all }
    )
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('/usr/bin/open', [
      `https://www.google.com/search?q=${encodeURIComponent('Norbert Wiener & "co"')}`
    ])
    // A URL handed to the system proves nothing: honest unknown.
    expect(result).toMatchObject({ ok: true, outcome: 'unknown' })
    expect(result.receipt).toBeUndefined()
  })

  it('Google search in Arc: Arc by bundle id, and a missing Arc fails visibly instead of swapping', async () => {
    const request: DesktopActionRequest = { id: 'desktop.google_search', args: { q: 'cats', browser: 'arc' } }
    const present = deps({ macAppInstalled: async () => true })
    await executeDesktopAction(request, { platform: 'darwin', deps: present.all })
    expect(present.exec).toHaveBeenCalledWith('/usr/bin/open', [
      '-b',
      'company.thebrowser.Browser',
      'https://www.google.com/search?q=cats'
    ])
    const absent = deps({ macAppInstalled: async () => false })
    const result = await executeDesktopAction(request, { platform: 'darwin', deps: absent.all })
    expect(result).toMatchObject({ ok: false, outcome: 'failed', preferredMissing: true })
    expect(absent.exec).not.toHaveBeenCalled()
  })

  it('X: the fixed address only; naming Arc selects Arc', async () => {
    const plain = deps()
    await executeDesktopAction({ id: 'desktop.open_x', args: {} }, { platform: 'darwin', deps: plain.all })
    expect(plain.exec).toHaveBeenCalledWith('/usr/bin/open', ['https://x.com'])
    const arc = deps({ macAppInstalled: async () => true })
    await executeDesktopAction(
      { id: 'desktop.open_x', args: { browser: 'arc' } },
      { platform: 'darwin', deps: arc.all }
    )
    expect(arc.exec).toHaveBeenCalledWith('/usr/bin/open', ['-b', 'company.thebrowser.Browser', 'https://x.com'])
  })

  it('an uncertain browser acknowledgment is unknown and is never redispatched or swapped', async () => {
    const { exec, all } = deps()
    exec.mockResolvedValueOnce({ ...NO, stdout: SENTINEL })
    exec.mockResolvedValueOnce(OK)
    const result = await executeDesktopAction(
      { id: 'desktop.google_search', args: { q: 'x' } },
      { platform: 'darwin', deps: all }
    )
    expect(exec).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' })
    expect(result.detail).not.toContain(SENTINEL)
  })
})

describe('macOS: create a note (AppleScript text never becomes script)', () => {
  const create = (title: string, body?: string): DesktopActionRequest => ({
    id: 'desktop.create_note',
    args: body === undefined ? { title } : { title, body }
  })

  it("passes the script as static -e lines and the person's text only as trailing argv", async () => {
    const { exec, all } = deps()
    exec.mockResolvedValueOnce({ ...OK, stdout: `${NOTE_ID}\n` })
    const request = create('Groceries', 'milk\neggs')
    const envelope = envelopeFor(request)
    const result = await executeDesktopAction(request, { platform: 'darwin', envelope, deps: all })

    expect(exec).toHaveBeenCalledTimes(1)
    const [file, args, options] = exec.mock.calls[0] as [string, string[], { timeoutMs: number }]
    expect(file).toBe('/usr/bin/osascript')
    const lastScript = args.indexOf('metis-voice-argv')
    expect(args.slice(0, lastScript).filter((_a, i) => i % 2 === 0)).toEqual(Array(lastScript / 2).fill('-e'))
    expect(args.slice(lastScript)).toEqual([
      'metis-voice-argv',
      'Groceries',
      '<div><h1>Groceries</h1></div><div>milk</div><div>eggs</div>'
    ])
    expect(args.slice(0, lastScript).join('\n')).toContain('on run argv')
    expect(args.slice(0, lastScript).join('\n')).not.toContain('Groceries')
    expect(options.timeoutMs).toBeGreaterThan(15_000)
    expect(result.outcome).toBe('verified')
    expect(isObservedVerified(request, result, envelope)).toBe(true)
  })

  it.each([
    'x" & do shell script "touch /tmp/pwned" & "',
    'end tell\ndo shell script "id"',
    'a" \u0026 (do shell script "id") \u0026 "',
    '-e do shell script "id"',
    '--help',
    '${HOME} $(id) `id` ; | & > < \\',
    "it's \\\" 'quoted'",
    '😀 日本語 ñ',
    'tell application "Terminal" to do script "id"',
    '{name:"x", body:"y"}'
  ])('injection corpus %j: the title is one argv element, the script is unchanged', async (title) => {
    const base = deps()
    base.exec.mockResolvedValue({ ...OK, stdout: NOTE_ID })
    await executeDesktopAction(create('plain'), { platform: 'darwin', deps: base.all })
    const baseline = (base.exec.mock.calls[0][1] as string[]).slice(
      0,
      (base.exec.mock.calls[0][1] as string[]).indexOf('metis-voice-argv')
    )

    const { exec, all } = deps()
    exec.mockResolvedValue({ ...OK, stdout: NOTE_ID })
    const text = title.includes('\n') ? title.replace(/\n/g, ' ') : title
    const result = await executeDesktopAction(create(text, 'body ' + text), { platform: 'darwin', deps: all })
    expect(result.outcome === 'unknown' || result.outcome === 'verified').toBe(true)
    const args = exec.mock.calls[0][1] as string[]
    const scriptPart = args.slice(0, args.indexOf('metis-voice-argv'))
    expect(scriptPart).toEqual(baseline)
    // A fixed non-dash word comes first, so no spoken text can be read by osascript as an option.
    expect(args[scriptPart.length]).toBe('metis-voice-argv')
    expect(args[scriptPart.length + 1]).toBe(text)
    expect(args).toHaveLength(scriptPart.length + 3)
    expect(scriptPart.join('\n')).not.toMatch(/do shell script/)
    expect(exec.mock.calls[0][0]).toBe('/usr/bin/osascript')
    // The body carries the text escaped: it cannot become markup either.
    expect(args[scriptPart.length + 2]).not.toMatch(/<(?!\/?(?:div|h1|br)>)/)
  })

  it('a refusal to automate Notes is a clean failure before anything runs', async () => {
    const { exec, all } = deps({ automationStatus: async () => 'denied' })
    const result = await executeDesktopAction(create('t'), { platform: 'darwin', deps: all })
    expect(result).toMatchObject({ ok: false, outcome: 'failed', detail: 'automation_denied' })
    expect(exec).not.toHaveBeenCalled()
  })

  it("the system's explicit not-authorized error proves nothing happened; any other failure is unknown", async () => {
    const denied = deps()
    denied.exec.mockResolvedValueOnce({
      ...NO,
      stderr: 'execution error: Not authorized to send Apple events to Notes. (-1743)'
    })
    expect(await executeDesktopAction(create('t'), { platform: 'darwin', deps: denied.all })).toMatchObject({
      ok: false,
      outcome: 'failed',
      detail: 'automation_denied'
    })

    const timedOut = deps()
    timedOut.exec.mockResolvedValueOnce({ ...NO, timedOut: true, stderr: '(-1743)' })
    expect(await executeDesktopAction(create('t'), { platform: 'darwin', deps: timedOut.all })).toMatchObject({
      ok: false,
      outcome: 'unknown'
    })

    const other = deps()
    other.exec.mockResolvedValueOnce({ ...NO, stdout: SENTINEL, stderr: SENTINEL })
    const result = await executeDesktopAction(create('t'), { platform: 'darwin', deps: other.all })
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' })
    expect(result.detail).not.toContain(SENTINEL)
    expect(other.exec).toHaveBeenCalledTimes(1)
  })

  it('without a returned note id nothing is verified', async () => {
    const { exec, all } = deps()
    exec.mockResolvedValueOnce({ ...OK, stdout: 'garbage' })
    const request = create('t')
    const result = await executeDesktopAction(request, {
      platform: 'darwin',
      envelope: envelopeFor(request),
      deps: all
    })
    expect(result).toMatchObject({ ok: true, outcome: 'unknown' })
    expect(result.receipt).toBeUndefined()
  })
})

describe('macOS: Photo Booth', () => {
  const request: DesktopActionRequest = { id: 'desktop.photo_booth_capture', args: {} }

  it('needs Accessibility first and opens nothing without it', async () => {
    const { exec, all } = deps({ accessibilityTrusted: () => false })
    expect(await executeDesktopAction(request, { platform: 'darwin', deps: all })).toMatchObject({
      outcome: 'failed',
      detail: 'accessibility_required'
    })
    const missing = deps()
    expect(await executeDesktopAction(request, { platform: 'darwin', deps: missing.all })).toMatchObject({
      outcome: 'failed',
      detail: 'accessibility_required'
    })
    expect(exec).not.toHaveBeenCalled()
    expect(missing.exec).not.toHaveBeenCalled()
  })

  it('needs consent to drive System Events', async () => {
    const { exec, all } = deps({ accessibilityTrusted: () => true, automationStatus: async () => 'denied' })
    expect(await executeDesktopAction(request, { platform: 'darwin', deps: all })).toMatchObject({
      outcome: 'failed',
      detail: 'automation_denied'
    })
    expect(exec).not.toHaveBeenCalled()
  })

  it('opens Photo Booth, then runs the fixed shutter script with no spoken text, and reports unknown', async () => {
    const { exec, all } = deps({ accessibilityTrusted: () => true })
    const result = await executeDesktopAction(request, { platform: 'darwin', deps: all })
    expect(exec.mock.calls[0]).toEqual(['/usr/bin/open', ['-b', 'com.apple.PhotoBooth']])
    expect(exec.mock.calls[1][0]).toBe('/usr/bin/osascript')
    const args = exec.mock.calls[1][1] as string[]
    expect(args.filter((_a, i) => i % 2 === 0)).toEqual(Array(args.length / 2).fill('-e'))
    expect(result).toMatchObject({ ok: true, outcome: 'unknown' })
    expect(result.receipt).toBeUndefined()
  })

  it('does not issue the shutter script after an uncertain launch acknowledgment', async () => {
    const { exec, all } = deps({ accessibilityTrusted: () => true })
    exec.mockResolvedValueOnce({ ...NO, stdout: SENTINEL })
    const result = await executeDesktopAction(request, { platform: 'darwin', deps: all })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' })
    expect(result.detail).not.toContain(SENTINEL)
  })
})

describe('Windows', () => {
  const fsFake = (overrides: Partial<NoteFileSystem> = {}) => {
    const files = new Map<string, string>()
    const fs: NoteFileSystem = {
      mkdir: vi.fn(async () => undefined),
      writeNewFile: vi.fn(async (file, contents) => {
        if (files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
        files.set(file, contents)
      }),
      sizeOf: vi.fn(async (file) => Buffer.byteLength(files.get(file) ?? '', 'utf8')),
      ...overrides
    }
    return { files, fs }
  }
  const DOCS = 'C:\\Users\\ana\\Documents'
  const NOTES = `${DOCS}\\Métis Notes`

  it('opens Sticky Notes through the pinned explorer.exe and never falls back to Notepad blindly', async () => {
    const { exec, spawnGui, all } = deps()
    const result = await executeDesktopAction({ id: 'desktop.open_notes', args: {} }, { platform: 'win32', deps: all })
    expect(exec).toHaveBeenCalledWith('C:\\Windows\\explorer.exe', [
      'shell:AppsFolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App'
    ])
    expect(result).toMatchObject({ ok: true, outcome: 'unknown' })

    const uncertain = deps()
    uncertain.exec.mockResolvedValueOnce({ ...NO, stdout: SENTINEL })
    const second = await executeDesktopAction(
      { id: 'desktop.open_notes', args: {} },
      { platform: 'win32', deps: uncertain.all }
    )
    expect(second).toMatchObject({ ok: false, outcome: 'unknown' })
    expect(second.detail).not.toContain(SENTINEL)
    expect(uncertain.spawnGui).not.toHaveBeenCalled()
    expect(spawnGui).not.toHaveBeenCalled()
  })

  it('web pages open through explorer.exe with the allowlisted URL; Arc is unsupported, never swapped', async () => {
    const { exec, all } = deps()
    await executeDesktopAction({ id: 'desktop.google_search', args: { q: 'a b' } }, { platform: 'win32', deps: all })
    expect(exec).toHaveBeenCalledWith('C:\\Windows\\explorer.exe', ['https://www.google.com/search?q=a%20b'])
    await executeDesktopAction({ id: 'desktop.open_x', args: {} }, { platform: 'win32', deps: all })
    expect(exec).toHaveBeenLastCalledWith('C:\\Windows\\explorer.exe', ['https://x.com'])
    const calls = exec.mock.calls.length
    for (const request of [
      { id: 'desktop.google_search', args: { q: 'x', browser: 'arc' } },
      { id: 'desktop.open_x', args: { browser: 'arc' } },
      { id: 'desktop.open_arc', args: {} }
    ] as DesktopActionRequest[]) {
      expect(await executeDesktopAction(request, { platform: 'win32', deps: all })).toMatchObject({
        ok: false,
        outcome: 'unsupported',
        preferredMissing: true
      })
    }
    expect(exec).toHaveBeenCalledTimes(calls)
  })

  it('the camera opens through explorer.exe', async () => {
    const { exec, all } = deps()
    const result = await executeDesktopAction(
      { id: 'desktop.photo_booth_capture', args: {} },
      { platform: 'win32', deps: all }
    )
    expect(exec).toHaveBeenCalledWith('C:\\Windows\\explorer.exe', ['microsoft.windows.camera:'])
    expect(result.ok).toBe(true)
  })

  it('a note becomes a file inside <documents>\\Métis Notes and is verified by reading its size back', async () => {
    const request: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Groceries', body: 'milk' } }
    const envelope = envelopeFor(request)
    const { files, fs } = fsFake()
    const { spawnGui, exec, all } = deps({ documentsDir: () => DOCS, notesFs: fs })
    const result = await executeDesktopAction(request, { platform: 'win32', envelope, deps: all })

    expect(fs.mkdir).toHaveBeenCalledWith(NOTES)
    expect([...files.keys()]).toEqual([`${NOTES}\\Groceries.txt`])
    expect(files.get(`${NOTES}\\Groceries.txt`)).toBe('\ufeffGroceries\r\n\r\nmilk\r\n')
    expect(spawnGui).toHaveBeenCalledWith('C:\\Windows\\notepad.exe', [`${NOTES}\\Groceries.txt`])
    expect(exec).not.toHaveBeenCalled()
    expect(result.outcome).toBe('verified')
    expect(isObservedVerified(request, result, envelope)).toBe(true)
  })

  it('never overwrites: a taken name moves to the next free one', async () => {
    const { files, fs } = fsFake()
    files.set(`${NOTES}\\Plan.txt`, 'existing')
    const { all } = deps({ documentsDir: () => DOCS, notesFs: fs })
    const request: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Plan' } }
    const result = await executeDesktopAction(request, { platform: 'win32', envelope: envelopeFor(request), deps: all })
    expect(files.get(`${NOTES}\\Plan.txt`)).toBe('existing')
    expect(files.has(`${NOTES}\\Plan (2).txt`)).toBe(true)
    expect(result.outcome).toBe('verified')
  })

  it.each([
    '..\\..\\Windows\\evil',
    '../../x',
    'C:\\Windows\\evil',
    'con',
    'a:b'
  ])('title %j cannot write outside the notes folder', async (title) => {
    const { files, fs } = fsFake()
    const { all } = deps({ documentsDir: () => DOCS, notesFs: fs })
    await executeDesktopAction({ id: 'desktop.create_note', args: { title } }, { platform: 'win32', deps: all })
    expect(files.size).toBe(1)
    const [path] = [...files.keys()]
    expect(path.startsWith(`${NOTES}\\`)).toBe(true)
    expect(path.slice(NOTES.length + 1)).not.toMatch(/[\\/:]/)
  })

  it('fails cleanly when there is nowhere to write; a write error that may leave a partial file is unknown', async () => {
    const none = deps()
    expect(
      await executeDesktopAction(
        { id: 'desktop.create_note', args: { title: 't' } },
        { platform: 'win32', deps: none.all }
      )
    ).toMatchObject({
      outcome: 'failed',
      detail: 'documents_unavailable'
    })
    const { fs } = fsFake({ writeNewFile: vi.fn(async () => Promise.reject(new Error(SENTINEL))) })
    const broken = deps({ documentsDir: () => DOCS, notesFs: fs })
    const result = await executeDesktopAction(
      { id: 'desktop.create_note', args: { title: 't' } },
      { platform: 'win32', deps: broken.all }
    )
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' })
    expect(result.detail).not.toContain(SENTINEL)
    expect(fs.writeNewFile).toHaveBeenCalledTimes(1)
    expect(broken.spawnGui).not.toHaveBeenCalled()
  })

  it('a size that does not match is unknown; a Notepad that will not open does not undo a verified note', async () => {
    const mismatch = fsFake({ sizeOf: vi.fn(async () => 1) })
    const a = deps({ documentsDir: () => DOCS, notesFs: mismatch.fs })
    const request: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 't' } }
    expect(
      await executeDesktopAction(request, { platform: 'win32', envelope: envelopeFor(request), deps: a.all })
    ).toMatchObject({
      ok: false,
      outcome: 'unknown'
    })
    const ok = fsFake()
    const b = deps({ documentsDir: () => DOCS, notesFs: ok.fs })
    b.spawnGui.mockResolvedValueOnce({ ok: false })
    expect(
      (await executeDesktopAction(request, { platform: 'win32', envelope: envelopeFor(request), deps: b.all })).outcome
    ).toBe('verified')
  })
})

describe('the real command path keeps adapter uncertainty', () => {
  it('CommandControl reports an uncertain adapter outcome as unverified and never dispatches twice', async () => {
    const { exec, all } = deps()
    exec.mockResolvedValueOnce({ ...NO, stdout: SENTINEL })
    exec.mockResolvedValueOnce(OK)
    const audit = vi.fn()
    const controller = new CommandControl({
      execute: (request, context) =>
        executeDesktopAction(request, { platform: 'darwin', envelope: context, deps: all }),
      policyAllows: () => true,
      audit
    })
    const proposal = controller.propose(
      { webContentsId: 7, revision: 2 },
      { id: 'desktop.google_search', args: { q: 'x' } }
    )
    expect(await controller.confirm({ ...proposal, webContentsId: 7 })).toEqual({
      ok: false,
      reason: 'outcome_unverified'
    })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(audit.mock.calls)).not.toContain(SENTINEL)
  })

  it('a verified open with a bound receipt is confirmed as verified', async () => {
    const { all } = deps()
    const seen = frontmost()
    const controller = new CommandControl({
      execute: (request, context) =>
        executeDesktopAction(request, {
          platform: 'darwin',
          envelope: context,
          deps: { ...all, frontmost: seen.verifier }
        }),
      policyAllows: () => true
    })
    const proposal = controller.propose({ webContentsId: 7, revision: 2 }, { id: 'desktop.open_notes', args: {} })
    expect(await controller.confirm({ ...proposal, webContentsId: 7 })).toEqual({ ok: true, outcome: 'verified' })
  })
})
