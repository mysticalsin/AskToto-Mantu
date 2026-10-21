import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAudio } from './audio.mjs'
import { parseCodesign, readBundleId } from './bundle.mjs'
import { runTool } from './exec.mjs'
import { GuardError, QA_BUNDLE_ID } from './guard.mjs'
import { resolveInstallConfig, singleAppIn } from './install.mjs'
import { CliError, parseWavInfo } from './lib.mjs'
import { dryRunPlan, resolveConfig } from './run-acceptance.mjs'
import { assertSyntheticCaptureActive } from './scenario.mjs'

let base: string
let sandboxRoot: string
beforeEach(() => {
  // Short on purpose: the socket-path budget check rejects a deep sandbox root, and os.tmpdir() can be deep under
  // isolate.sh (and on Windows, where the user temp directory alone is about 40 characters). Use the drive root there.
  base = realpathSync(mkdtempSync(join(process.platform === 'win32' ? parse(tmpdir()).root : '/tmp', 'w14-')))
  sandboxRoot = join(base, '_relay', 'goal-loop', 'sandbox-home')
  mkdirSync(join(sandboxRoot, 'Applications', 'Metis QA.app'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const isolatedEnv = () => ({
  PATH: '/usr/bin',
  HOME: join(sandboxRoot, 'run-1'),
  TMPDIR: join(sandboxRoot, 'run-1', 'tmp'),
  ASKTOTO_USERDATA: join(sandboxRoot, 'run-1', 'userdata'),
  METIS_LOOP_ISOLATED: '1'
})

describe('run-acceptance configuration', () => {
  it('derives the sandbox root from HOME and defaults the app to the sandbox install', () => {
    const config = resolveConfig(['--run-id', 'r1'], isolatedEnv())
    expect(config.layout.sandboxRoot).toBe(sandboxRoot)
    expect(config.appPath).toBe(join(sandboxRoot, 'Applications', 'Metis QA.app'))
    expect(config.values).toMatchObject({ audio: 'speech', 'meeting-seconds': 90, 'dry-run': false })
  })

  it('rejects bad arguments', () => {
    const env = isolatedEnv()
    expect(() => resolveConfig(['--audio', 'mic'], env)).toThrow(CliError)
    expect(() => resolveConfig(['--audio', 'file'], env)).toThrow(/needs --wav/)
    expect(() => resolveConfig(['--wav', 'x.wav'], env)).toThrow(/only valid with --audio file/)
    expect(() => resolveConfig(['--meeting-seconds', '5'], env)).toThrow(/at least 20/)
    expect(() => resolveConfig(['--run-id', '../escape'], env)).toThrow(/--run-id/)
    expect(() => resolveConfig(['--bogus'], env)).toThrow(/unknown flag/)
    expect(() => resolveConfig([], { HOME: '/Users/real' })).toThrow(/cannot derive the sandbox root/)
  })

  it('--dry-run validates every guard and lists the plan without touching disk', () => {
    const config = resolveConfig(['--run-id', 'r1', '--dry-run'], isolatedEnv())
    const result = dryRunPlan(config, isolatedEnv(), { bundleId: QA_BUNDLE_ID, platform: 'darwin' })
    expect(result.ok).toBe(true)
    expect(result.checks.every((check) => check.ok)).toBe(true)
    expect(result.plan.steps).toEqual([
      'launch-and-renderer-ready',
      'meeting-live',
      'transcript-observed',
      'stop-and-save',
      'review-opens-meeting',
      'clean-quit',
      'relaunch',
      'meeting-preserved-after-relaunch',
      'final-quit'
    ])
    expect(result.plan.childEnvKeys).toEqual(
      expect.arrayContaining(['ASKTOTO_USERDATA', 'HOME', 'METIS_QA_CAPTURE_FILE', 'TMPDIR'])
    )
    expect(readdirSync(sandboxRoot)).toEqual(['Applications']) // nothing was created
  })

  it('dry-run reports the real identity, a missing wrapper and an /Applications app as failures', () => {
    const real = dryRunPlan(resolveConfig(['--run-id', 'r1'], isolatedEnv()), isolatedEnv(), {
      bundleId: 'com.mantu.asktoto',
      platform: 'darwin'
    })
    expect(real.ok).toBe(false)
    expect(real.checks.find((check) => check.id === 'bundle-id')?.ok).toBe(false)
    const { METIS_LOOP_ISOLATED: _drop, ...unwrapped } = isolatedEnv()
    expect(
      dryRunPlan(resolveConfig(['--run-id', 'r1'], unwrapped), unwrapped, {
        bundleId: QA_BUNDLE_ID,
        platform: 'darwin'
      }).checks.find((check) => check.id === 'isolate-wrapper')?.ok
    ).toBe(false)
    const installed = dryRunPlan(resolveConfig(['--app', '/Applications/Metis.app'], isolatedEnv()), isolatedEnv(), {
      bundleId: QA_BUNDLE_ID,
      platform: 'darwin'
    })
    expect(installed.ok).toBe(false)
    expect(installed.checks.find((check) => check.id === 'app-path')?.detail).toContain('/Applications')
  })
})

describe('install configuration', () => {
  it('needs a zip and a derivable sandbox, and installs into <sandbox>/Applications', () => {
    expect(() => resolveInstallConfig([], isolatedEnv())).toThrow(/--zip/)
    expect(() => resolveInstallConfig(['--zip', 'a.zip'], { HOME: '/Users/real' })).toThrow(/cannot derive/)
    const config = resolveInstallConfig(['--zip', 'release/Metis-QA-1.0-mac.zip', '--replace'], isolatedEnv())
    expect(config).toMatchObject({
      sandboxRoot,
      appsDir: join(sandboxRoot, 'Applications'),
      replace: true,
      dryRun: false
    })
  })

  it('requires exactly one .app in the extracted zip', () => {
    expect(singleAppIn('/x', () => ['Metis QA.app', '__MACOSX'])).toBe('Metis QA.app')
    expect(() => singleAppIn('/x', () => [])).toThrow(/found 0/)
    expect(() => singleAppIn('/x', () => ['A.app', 'B.app'])).toThrow(/found 2/)
  })
})

describe('bundle facts', () => {
  it('parses codesign output and recognises ad-hoc signatures', () => {
    const text = `Executable=/s/Metis QA.app/Contents/MacOS/Metis QA
Identifier=com.mantu.asktoto.qa
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+7 location=embedded
Signature=adhoc
TeamIdentifier=not set
`
    expect(parseCodesign(text)).toMatchObject({
      identifier: 'com.mantu.asktoto.qa',
      signature: 'adhoc',
      adhoc: true,
      teamIdentifier: 'not set',
      flags: 'adhoc'
    })
    expect(
      parseCodesign(
        'Identifier=x\nSignature size=9000\nTeamIdentifier=ABCDE12345\nCodeDirectory flags=0x10000(runtime)'
      ).adhoc
    ).toBe(false)
  })

  it('reads a bundle id through the injected runner and returns null on failure', () => {
    const ok = vi.fn(() => ({ status: 0, stdout: 'com.mantu.asktoto.qa\n', stderr: '', signal: null, error: null }))
    expect(readBundleId('/s/Metis QA.app', ok)).toBe('com.mantu.asktoto.qa')
    expect(ok).toHaveBeenCalledWith('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      join('/s', 'Metis QA.app', 'Contents', 'Info.plist')
    ])
    expect(
      readBundleId('/s/x.app', () => ({ status: 1, stdout: '', stderr: 'no', signal: null, error: null }))
    ).toBeNull()
  })
})

describe('command runner', () => {
  it('refuses open, launchctl and osascript before spawning anything', () => {
    const spawn = vi.fn()
    for (const file of ['/usr/bin/open', '/bin/launchctl', '/usr/bin/osascript']) {
      expect(() => runTool(file, ['x'], { spawn: spawn as never })).toThrow(GuardError)
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it('passes an allowed helper through with a bounded timeout', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: 'ok', stderr: '', signal: null }))
    expect(runTool('/usr/bin/plutil', ['-p', 'x'], { spawn: spawn as never, timeoutMs: 5 })).toMatchObject({
      status: 0,
      stdout: 'ok'
    })
    expect(spawn).toHaveBeenCalledWith('/usr/bin/plutil', ['-p', 'x'], expect.objectContaining({ timeout: 5 }))
  })
})

describe('synthetic audio', () => {
  const layoutFor = () => {
    const userData = join(sandboxRoot, 'acceptance', 'r1', 'userdata')
    return {
      captureDir: join(userData, 'qa-capture'),
      captureWav: join(userData, 'qa-capture', 'synthetic.wav'),
      tmp: join(sandboxRoot, 't', 'abcd')
    }
  }

  it('writes a 16-bit PCM tone WAV inside the profile, and says it is not speech', () => {
    const layout = layoutFor()
    const audio = prepareAudio({ kind: 'tone', layout })
    expect(audio).toMatchObject({ kind: 'tone', speech: false, channels: 1, sampleRate: 16000 })
    expect(parseWavInfo(readFileSync(layout.captureWav))).not.toBeNull()
    expect(audio.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('synthesises speech with say + afconvert and fails loudly rather than falling back to a tone', () => {
    const layout = layoutFor()
    const calls: string[] = []
    const run = ((file: string, args: string[]) => {
      calls.push(file)
      if (file === '/usr/bin/say') return { status: 1, stdout: '', stderr: 'no voice', signal: null, error: null }
      return { status: 0, stdout: '', stderr: '', signal: null, error: null }
    }) as never
    expect(() => prepareAudio({ kind: 'speech', layout, run })).toThrow(/speech synthesis failed/)
    expect(calls).toEqual(['/usr/bin/say'])
  })

  it('rejects a conversion that did not produce 16-bit PCM', () => {
    const layout = layoutFor()
    const run = (() => ({ status: 0, stdout: '', stderr: '', signal: null, error: null })) as never
    expect(() => prepareAudio({ kind: 'speech', layout, run })).toThrow()
  })

  it('refuses --audio file without a path', () => {
    expect(() => prepareAudio({ kind: 'file', layout: layoutFor() })).toThrow(/--wav/)
  })
})

describe('real-microphone safety', () => {
  it('refuses to start a meeting unless the app reported its file-fed capture source', () => {
    expect(() => assertSyntheticCaptureActive({ audit: () => [{ event: 'app.renderer.ready' }] })).toThrow(
      /real microphone/
    )
    expect(() => assertSyntheticCaptureActive({ audit: () => [{ event: 'qa.capture.file_source' }] })).not.toThrow()
  })
})

describe('forbidden launch routes stay out of the tooling', () => {
  const dir = __dirname
  const sources = readdirSync(dir).filter((name) => name.endsWith('.mjs') && name !== 'guard.mjs')

  it.each(sources)('%s never spawns open, launchctl or osascript', (name) => {
    const text = readFileSync(join(dir, name), 'utf8')
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toMatch(
      /(spawn|spawnSync|exec|execFile|execFileSync|execSync|runTool)\(\s*['"`][^'"`]*\b(open|launchctl|osascript)['"`]/
    )
    expect(code).not.toMatch(/['"`]\/usr\/bin\/(open|osascript)['"`]|['"`]\/bin\/launchctl['"`]/)
    expect(code).not.toContain('setenv')
    expect(code).not.toContain('/Applications/Metis')
  })

  it('launches by direct spawn of the bundle executable', () => {
    const text = readFileSync(join(dir, 'session.mjs'), 'utf8')
    expect(text).toContain('spawn(executable,')
    expect(text).toContain('executableForApp(appPath)')
  })

  it('turns off only the macOS audio-service sandbox so the file-fed fake microphone is not silent', () => {
    const text = readFileSync(join(dir, 'session.mjs'), 'utf8')
    expect(text).toContain("HARNESS_CHROMIUM_SWITCHES = Object.freeze(['--disable-features=AudioServiceSandbox'])")
    expect(text).toContain('...HARNESS_CHROMIUM_SWITCHES')
    expect(text).not.toContain('no-sandbox')
  })
})
