import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Real shell routing tests on disposable hosted Linux, not Darwin or Seatbelt isolation proof.
assert.equal(process.platform, 'linux', 'this fixture requires Linux')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'this fixture requires GitHub Actions')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'this fixture requires a hosted runner')

const wrapper = join(dirname(fileURLToPath(import.meta.url)), 'run-under-owner-sandbox.sh')
const hold = 'owner-runner sandbox: owner route disabled: architectural isolation hold\n'
const options = { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 }

function invoke(args, env, cwd) {
  return spawnSync('/bin/bash', ['--noprofile', '--norc', '-x', wrapper, ...args], {
    ...options,
    cwd,
    env: { PATH: '/usr/bin:/bin', BASH_XTRACEFD: '3', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe']
  })
}

for (const profile of [undefined, 'owner-account.sb', 'owner-runner.sb', 'invalid.sb']) {
  for (const cleanup of [false, true]) {
    for (const validRoots of [false, true]) {
      test(`owner HOLD: profile=${profile ?? 'default'} cleanup=${cleanup} validRoots=${validRoots}`, () => {
        const root = mkdtempSync(join(tmpdir(), 'owner-route-hold-'))
        try {
          const home = join(root, 'home')
          const temp = join(root, 'temp')
          mkdirSync(home)
          mkdirSync(temp)
          const marker = join(root, 'child-ran')
          const child = ['/bin/bash', '--noprofile', '--norc', '-c', 'printf child > "$1"', 'marker', marker]
          const baseline = spawnSync(child[0], child.slice(1), {
            ...options,
            env: { PATH: '/usr/bin:/bin' },
            cwd: root
          })
          assert.equal(baseline.error, undefined)
          assert.equal(baseline.status, 0)
          assert.equal(readFileSync(marker, 'utf8'), 'child')
          rmSync(marker)

          const sentinel = join(temp, 'cleanup-sentinel')
          writeFileSync(sentinel, 'preserve synthetic state')
          const before = readdirSync(root, { recursive: true }).sort()
          const result = invoke(
            cleanup ? ['--cleanup-owned-temp'] : child,
            {
              ...(profile === undefined ? {} : { OWNER_SANDBOX_PROFILE: profile }),
              OWNER_SANDBOX_ROUTE: 'owner',
              OWNER_SANDBOX_ENTERED: '1',
              OWNER_SANDBOX_ENTERED_PROFILE: 'owner-runner.sb',
              OWNER_SANDBOX_ALLOW_OWNER: '1',
              GITHUB_ACTIONS: 'true',
              RUNNER_ENVIRONMENT: 'self-hosted',
              GITHUB_JOB: 'st1-mac-fifo',
              GITHUB_RUN_ID: '123',
              GITHUB_RUN_ATTEMPT: '1',
              ...(validRoots ? { HOME: home, RUNNER_TEMP: temp, GITHUB_WORKSPACE: root } : {})
            },
            root
          )
          assert.equal(result.error, undefined)
          assert.equal(result.signal, null)
          assert.equal(result.status, 2)
          assert.equal(result.stdout, '')
          assert.equal(result.stderr, hold)
          const trace = String(result.output[3])
          assert.match(trace, /owner = owner/)
          assert.doesNotMatch(trace, /\+\+|HERE=|canonical|uname|dscl|mkdir|mktemp|sandbox-exec|\+ exec /)
          assert.equal(existsSync(marker), false)
          assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before)
          assert.equal(readFileSync(sentinel, 'utf8'), 'preserve synthetic state')
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
    }
  }
}

test('the non-owner route reaches legacy exec with no sandbox-exec on its owned PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-route-control-'))
  try {
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    mkdirSync(home)
    mkdirSync(bin)
    symlinkSync('/usr/bin/dirname', join(bin, 'dirname'))
    assert.deepEqual(readdirSync(bin), ['dirname'])
    const before = readdirSync(root, { recursive: true }).sort()
    const result = invoke(
      ['/bin/true'],
      { PATH: bin, HOME: home, OWNER_SANDBOX_PROFILE: 'owner-runner.sb', OWNER_SANDBOX_ROUTE: 'hosted-fixture' },
      root
    )
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 127)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /sandbox-exec: (?:command )?not found\n$/)
    const trace = String(result.output[3])
    assert.match(trace, /\+ HERE=/)
    assert.match(trace, /\+ exec sandbox-exec -f .*\/owner-account\.sb -D HOME=.* \/bin\/true\n$/)
    assert.doesNotMatch(result.stderr, /architectural isolation hold/)
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
