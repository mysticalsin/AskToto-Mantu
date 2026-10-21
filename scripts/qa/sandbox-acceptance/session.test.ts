import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GuardError, QA_BUNDLE_ID } from './guard.mjs'
import { sandboxLayout } from './lib.mjs'
import { launchApp } from './session.mjs'

// A fake bundle: a shell script that plays the part of the app's boot (audit records, an env dump) so the launch path
// (guards, direct spawn, ready wait, kill) is exercised without any real app or Electron.
let base: string
let sandboxRoot: string
let appPath: string
const layoutFor = () => sandboxLayout({ sandboxRoot, runId: 'r1' })
const deps = (bundleId: string | null = QA_BUNDLE_ID) => ({ platform: 'darwin', readBundleId: () => bundleId })

function writeApp(script: string): void {
  const exe = join(appPath, 'Contents', 'MacOS', 'Metis QA')
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(exe, `#!/bin/bash\n${script}\n`)
  chmodSync(exe, 0o755)
}

const BOOT = `
mkdir -p "$ASKTOTO_USERDATA/logs"
env | grep -E '^(HOME|TMPDIR|ASKTOTO_USERDATA|ASKTOTO_LOCAL_KEYSTORE|METIS_QA_CAPTURE_FILE|OPENAI_API_KEY|GITHUB_TOKEN|OneDrive)=' | sort > "$ASKTOTO_USERDATA/env.txt"
echo "$@" > "$ASKTOTO_USERDATA/args.txt"
echo '{"event":"app.started","ts":"2026-10-21T10:00:00.000Z"}' >> "$ASKTOTO_USERDATA/logs/audit.log"
echo '{"event":"qa.capture.file_source","ts":"2026-10-21T10:00:00.100Z"}' >> "$ASKTOTO_USERDATA/logs/audit.log"
echo '{"event":"app.renderer.ready","ts":"2026-10-21T10:00:00.200Z"}' >> "$ASKTOTO_USERDATA/logs/audit.log"
`

beforeEach(() => {
  // Short root: the socket-path budget rejects a deep sandbox.
  base = realpathSync(mkdtempSync(join('/tmp', 'w14s-')))
  sandboxRoot = join(base, '_relay', 'goal-loop', 'sandbox-home')
  appPath = join(sandboxRoot, 'Applications', 'Metis QA.app')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const parentEnv = () => ({
  PATH: process.env.PATH,
  HOME: join(sandboxRoot, 'run-1'),
  TMPDIR: join(sandboxRoot, 'run-1', 'tmp'),
  ASKTOTO_USERDATA: join(sandboxRoot, 'run-1', 'userdata'),
  METIS_LOOP_ISOLATED: '1',
  OPENAI_API_KEY: 'should-not-reach-the-app',
  GITHUB_TOKEN: 'should-not-reach-the-app'
})

// The fake bundle is an extension-less bash script launched by direct spawn, the macOS bundle launch under
// isolate.sh; Windows cannot execute it, so the launch path is only exercised on posix hosts.
describe.skipIf(process.platform === 'win32')('launchApp', () => {
  it('direct-spawns the bundle executable with only the sandbox environment and waits for the app’s own ready record', async () => {
    writeApp(`${BOOT}\nsleep 30`)
    const layout = layoutFor()
    const session = await launchApp({
      layout,
      appPath,
      parentEnv: parentEnv(),
      captureFile: layout.captureWav,
      readyTimeoutMs: 15_000,
      connect: false,
      deps: deps()
    })
    try {
      expect(session.pid).toBeGreaterThan(0)
      expect(session.audit().map((record: { event: string }) => record.event)).toEqual([
        'app.started',
        'qa.capture.file_source',
        'app.renderer.ready'
      ])
      const env = readFileSync(join(layout.userData, 'env.txt'), 'utf8')
      expect(env).toContain(`HOME=${layout.home}`)
      expect(env).toContain(`TMPDIR=${layout.tmp}`)
      expect(env).toContain(`ASKTOTO_USERDATA=${layout.userData}`)
      expect(env).toContain(`METIS_QA_CAPTURE_FILE=${layout.captureWav}`)
      expect(env).toContain('ASKTOTO_LOCAL_KEYSTORE=1')
      expect(env).not.toContain('OPENAI_API_KEY')
      expect(env).not.toContain('GITHUB_TOKEN')
      expect(env).not.toContain('OneDrive')
      expect(readFileSync(join(layout.userData, 'args.txt'), 'utf8').trim()).toMatch(/^--remote-debugging-port=\d+$/)
      expect(JSON.parse(readFileSync(join(layout.userData, 'settings.json'), 'utf8'))).toMatchObject({
        onboardingDone: true,
        overlayLayout: 'bar'
      })
    } finally {
      await session.kill()
    }
    expect(session.child.exitCode !== null || session.child.signalCode !== null).toBe(true)
  })

  it('refuses before spawning when the bundle is not the QA identity', async () => {
    writeApp(`touch "${base}/ran"\n${BOOT}`)
    await expect(
      launchApp({
        layout: layoutFor(),
        appPath,
        parentEnv: parentEnv(),
        connect: false,
        deps: deps('com.mantu.asktoto')
      })
    ).rejects.toThrow(GuardError)
    expect(existsSync(join(base, 'ran'))).toBe(false)
  })

  it('refuses an app outside the sandbox and a harness that was not started through isolate.sh', async () => {
    writeApp(BOOT)
    const outside = join(base, 'elsewhere', 'Metis QA.app')
    mkdirSync(join(outside, 'Contents', 'MacOS'), { recursive: true })
    await expect(
      launchApp({ layout: layoutFor(), appPath: outside, parentEnv: parentEnv(), connect: false, deps: deps() })
    ).rejects.toThrow(/app-path/)
    await expect(
      launchApp({
        layout: layoutFor(),
        appPath,
        parentEnv: { ...parentEnv(), METIS_LOOP_ISOLATED: undefined },
        connect: false,
        deps: deps()
      })
    ).rejects.toThrow(/isolate-wrapper/)
  })

  it('fails when the app exits before its renderer is ready', async () => {
    writeApp('exit 3')
    await expect(
      launchApp({
        layout: layoutFor(),
        appPath,
        parentEnv: parentEnv(),
        readyTimeoutMs: 15_000,
        connect: false,
        deps: deps()
      })
    ).rejects.toThrow(/exited before its renderer became ready/)
  })

  it('fails on an app.crash record instead of waiting for the timeout', async () => {
    writeApp(
      `mkdir -p "$ASKTOTO_USERDATA/logs"\necho '{"event":"app.crash"}' >> "$ASKTOTO_USERDATA/logs/audit.log"\nsleep 30`
    )
    await expect(
      launchApp({
        layout: layoutFor(),
        appPath,
        parentEnv: parentEnv(),
        readyTimeoutMs: 15_000,
        connect: false,
        deps: deps()
      })
    ).rejects.toThrow(/app\.crash/)
  })

  it('times out with a message naming the missing record', async () => {
    writeApp('sleep 30')
    await expect(
      launchApp({
        layout: layoutFor(),
        appPath,
        parentEnv: parentEnv(),
        readyTimeoutMs: 1_000,
        connect: false,
        deps: deps()
      })
    ).rejects.toThrow(/no app\.renderer\.ready audit record within 1s/)
  })
})
