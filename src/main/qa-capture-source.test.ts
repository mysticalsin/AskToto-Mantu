import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installQaCaptureSource,
  QA_CAPTURE_ENV,
  qaCaptureSwitches,
  type QaCaptureAudit,
  type QaCaptureHost
} from './qa-capture-source'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway root holding an isolated QA profile with a WAV inside and a sibling directory outside it. */
function fixture(): { profile: string; wav: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'asktoto-qa-capture-'))
  dirs.push(root)
  const profile = join(root, 'profile')
  const outside = join(root, 'outside')
  mkdirSync(profile)
  mkdirSync(outside)
  const wav = join(profile, 'meeting.wav')
  writeFileSync(wav, 'RIFF')
  writeFileSync(join(outside, 'escaped.wav'), 'RIFF')
  return { profile, wav, outside }
}

function fakeHost(isPackaged = true) {
  let ready!: () => void
  const readyPromise = new Promise<void>((resolve) => (ready = resolve))
  const appendSwitch = vi.fn<(name: string, value?: string) => void>()
  const host: QaCaptureHost = { isPackaged, commandLine: { appendSwitch }, whenReady: () => readyPromise }
  return { host, appendSwitch, ready }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Install against the real filesystem with the given env, as a QA-identity build would. */
function install(env: Record<string, string | undefined>, opts: { qaIdentity?: boolean; packaged?: boolean } = {}) {
  const fake = fakeHost(opts.packaged ?? true)
  const audit = vi.fn<QaCaptureAudit>()
  const decision = installQaCaptureSource(fake.host, audit, { qaIdentity: opts.qaIdentity ?? true, env })
  return { ...fake, audit, decision }
}

describe('installQaCaptureSource — active path', () => {
  it('appends both fake-capture switches before ready and audits { active: true } only after ready', async () => {
    const { profile, wav } = fixture()
    const { decision, appendSwitch, audit, ready } = install({ ASKTOTO_USERDATA: profile, [QA_CAPTURE_ENV]: wav })

    expect(decision.reason).toBeNull()
    expect(appendSwitch.mock.calls).toEqual([
      ['use-fake-device-for-media-stream'],
      ['use-file-for-fake-audio-capture', realpathSync(wav)]
    ])
    await flush()
    expect(audit).not.toHaveBeenCalled()

    ready()
    await flush()
    expect(audit.mock.calls).toEqual([['qa.capture.file_source', { active: true }]])
    // Content-free: neither the path nor the file name reaches the audit trail.
    expect(JSON.stringify(audit.mock.calls)).not.toContain('meeting')
  })

  it('accepts a path with a ".." segment that still resolves inside the profile', () => {
    const { profile } = fixture()
    const winding = `${profile}${sep}..${sep}profile${sep}meeting.wav`
    expect(install({ ASKTOTO_USERDATA: profile, [QA_CAPTURE_ENV]: winding }).decision.reason).toBeNull()
  })
})

describe('installQaCaptureSource — refusals append nothing and audit nothing', () => {
  it.each([
    ['shipping identity', 'shipping-identity', { qaIdentity: false }, (f: ReturnType<typeof fixture>) => ({ ASKTOTO_USERDATA: f.profile, [QA_CAPTURE_ENV]: f.wav })],
    ['an unpackaged app', 'unpackaged', { packaged: false }, (f: ReturnType<typeof fixture>) => ({ ASKTOTO_USERDATA: f.profile, [QA_CAPTURE_ENV]: f.wav })],
    ['no ASKTOTO_USERDATA', 'no-profile', {}, (f: ReturnType<typeof fixture>) => ({ [QA_CAPTURE_ENV]: f.wav })],
    ['a blank ASKTOTO_USERDATA', 'no-profile', {}, (f: ReturnType<typeof fixture>) => ({ ASKTOTO_USERDATA: '  ', [QA_CAPTURE_ENV]: f.wav })],
    ['no capture file', 'no-capture-file', {}, (f: ReturnType<typeof fixture>) => ({ ASKTOTO_USERDATA: f.profile })],
    ['a relative path', 'relative-path', {}, (f: ReturnType<typeof fixture>) => ({ ASKTOTO_USERDATA: f.profile, [QA_CAPTURE_ENV]: 'meeting.wav' })],
    [
      "'..' traversal out of the profile",
      'outside-profile',
      {},
      (f: ReturnType<typeof fixture>) => ({ ASKTOTO_USERDATA: f.profile, [QA_CAPTURE_ENV]: `${f.profile}${sep}..${sep}outside${sep}escaped.wav` })
    ],
    [
      'a wrong extension',
      'not-wav',
      {},
      (f: ReturnType<typeof fixture>) => {
        const mp3 = join(f.profile, 'meeting.mp3')
        writeFileSync(mp3, 'ID3')
        return { ASKTOTO_USERDATA: f.profile, [QA_CAPTURE_ENV]: mp3 }
      }
    ],
    ['a missing file', 'missing-file', {}, (f: ReturnType<typeof fixture>) => ({ ASKTOTO_USERDATA: f.profile, [QA_CAPTURE_ENV]: join(f.profile, 'absent.wav') })],
    [
      'a directory named like a WAV',
      'missing-file',
      {},
      (f: ReturnType<typeof fixture>) => {
        const dir = join(f.profile, 'folder.wav')
        mkdirSync(dir)
        return { ASKTOTO_USERDATA: f.profile, [QA_CAPTURE_ENV]: dir }
      }
    ]
  ] as const)('refuses %s (%s)', async (_label, reason, opts, envFor) => {
    const { decision, appendSwitch, audit, ready } = install(envFor(fixture()), opts)
    expect(decision).toEqual({ switches: null, reason })
    ready()
    await flush()
    expect(appendSwitch).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('refuses a symlink inside the profile that escapes it (outside-profile)', async () => {
    const f = fixture()
    // A directory junction needs no elevated rights on Windows and is an ordinary symlink elsewhere.
    symlinkSync(f.outside, join(f.profile, 'link'), 'junction')
    const { decision, appendSwitch, audit, ready } = install({
      ASKTOTO_USERDATA: f.profile,
      [QA_CAPTURE_ENV]: join(f.profile, 'link', 'escaped.wav')
    })
    expect(decision).toEqual({ switches: null, reason: 'outside-profile' })
    ready()
    await flush()
    expect(appendSwitch).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('qaCaptureSwitches — pure decision', () => {
  const profile = join(sep, 'qa', 'profile')
  const base = {
    qaIdentity: true,
    packaged: true,
    exists: () => true,
    realpath: (path: string) => path
  }

  it('returns the two switches with the resolved path when every condition holds', () => {
    const file = join(profile, 'in.wav')
    expect(qaCaptureSwitches({ ...base, env: { ASKTOTO_USERDATA: profile, [QA_CAPTURE_ENV]: file } })).toEqual({
      switches: [['use-fake-device-for-media-stream'], ['use-file-for-fake-audio-capture', file]],
      reason: null
    })
  })

  it('refuses a symlinked .wav whose target leaves the profile, and one whose target is not a WAV', () => {
    const link = join(profile, 'link.wav')
    const escaping = { ...base, realpath: (p: string) => (p === link ? join(sep, 'elsewhere', 'x.wav') : p) }
    expect(qaCaptureSwitches({ ...escaping, env: { ASKTOTO_USERDATA: profile, [QA_CAPTURE_ENV]: link } }).reason).toBe('outside-profile')
    const retyped = { ...base, realpath: (p: string) => (p === link ? join(profile, 'notes.txt') : p) }
    expect(qaCaptureSwitches({ ...retyped, env: { ASKTOTO_USERDATA: profile, [QA_CAPTURE_ENV]: link } }).reason).toBe('not-wav')
  })

  it('refuses the profile directory itself and a sibling whose name only starts with the profile name', () => {
    const env = (file: string) => ({ ASKTOTO_USERDATA: profile, [QA_CAPTURE_ENV]: file })
    const asWav = { ...base, realpath: (p: string) => (p.endsWith('.wav') ? p.slice(0, -'.wav'.length) : p) }
    expect(qaCaptureSwitches({ ...asWav, env: env(`${profile}.wav`) }).reason).toBe('outside-profile')
    expect(qaCaptureSwitches({ ...base, env: env(`${profile}-other${sep}in.wav`) }).reason).toBe('outside-profile')
  })
})

describe('permission surface — the hook fakes no grant', () => {
  it('touches nothing on the host but isPackaged, commandLine and whenReady', async () => {
    const { profile, wav } = fixture()
    const { host, ready } = fakeHost()
    const touched = new Set<string>()
    const guarded = new Proxy(host, {
      get(target, key, receiver) {
        touched.add(String(key))
        return Reflect.get(target, key, receiver)
      }
    })
    installQaCaptureSource(guarded, vi.fn(), { qaIdentity: true, env: { ASKTOTO_USERDATA: profile, [QA_CAPTURE_ENV]: wav } })
    ready()
    await flush()
    expect([...touched].sort()).toEqual(['commandLine', 'isPackaged', 'whenReady'])
  })

  it('imports no Electron, systemPreferences, TCC or permission API', () => {
    const source = readFileSync(join(__dirname, 'qa-capture-source.ts'), 'utf8')
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1])
    expect(specifiers.sort()).toEqual(['./logger', './qa-identity', 'node:fs', 'node:path'])
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const api of [
      'electron',
      'systemPreferences',
      'askForMediaAccess',
      'getMediaAccessStatus',
      'setPermissionRequestHandler',
      'setPermissionCheckHandler',
      'setDisplayMediaRequestHandler',
      'getPlatformPermissions',
      'tccutil'
    ]) {
      expect(code, `qa-capture-source.ts references ${api}`).not.toContain(api)
    }
  })
})
