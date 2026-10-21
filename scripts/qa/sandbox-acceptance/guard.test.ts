import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GuardError,
  QA_BUNDLE_ID,
  assertCommandAllowed,
  assertGuards,
  assertWritableInSandbox,
  checkAppPath,
  checkBundleId,
  checkChildEnv,
  checkCommand,
  checkMeetingsFolder,
  checkParentEnv,
  checkSandboxRoot,
  deriveSandboxRoot,
  evaluateGuards,
  isInside,
  realpathDeep
} from './guard.mjs'
import { buildChildEnv, sandboxLayout } from './lib.mjs'

let base: string
let sandboxRoot: string
let outside: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wp14-guard-')))
  sandboxRoot = join(base, '_relay', 'goal-loop', 'sandbox-home')
  outside = join(base, 'elsewhere')
  mkdirSync(join(sandboxRoot, 'Applications', 'Metis QA.app'), { recursive: true })
  mkdirSync(join(outside, 'Metis QA.app'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const layout = () => sandboxLayout({ sandboxRoot, runId: 'r1' })
const parentEnv = () => ({
  PATH: '/usr/bin',
  HOME: join(sandboxRoot, 'run-1'),
  TMPDIR: join(sandboxRoot, 'run-1', 'tmp'),
  ASKTOTO_USERDATA: join(sandboxRoot, 'run-1', 'userdata'),
  METIS_LOOP_ISOLATED: '1'
})
const childEnv = () =>
  buildChildEnv({ parentEnv: parentEnv(), layout: layout(), captureFile: layout().captureWav, platform: 'darwin' })

describe('sandbox root', () => {
  it('accepts only a path ending in _relay/goal-loop/sandbox-home', () => {
    expect(checkSandboxRoot(sandboxRoot).ok).toBe(true)
    expect(checkSandboxRoot(outside).ok).toBe(false)
    expect(checkSandboxRoot(join(base, '_relay', 'goal-loop')).ok).toBe(false)
    expect(checkSandboxRoot('relative/sandbox-home').ok).toBe(false)
    expect(checkSandboxRoot(undefined).ok).toBe(false)
    expect(checkSandboxRoot(join(sandboxRoot, 'missing')).ok).toBe(false)
  })

  it('derives the root from a HOME under run-*', () => {
    expect(deriveSandboxRoot(join(sandboxRoot, 'run-2026-1'))).toBe(sandboxRoot)
    expect(deriveSandboxRoot('/Users/someone')).toBeNull()
    expect(deriveSandboxRoot(undefined)).toBeNull()
    // a sandbox-home that is not under goal-loop is not the sandbox
    expect(deriveSandboxRoot('/x/other/sandbox-home/run-1')).toBeNull()
  })
})

describe('path containment', () => {
  it('compares segments, not string prefixes', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b-other/c')).toBe(false)
    expect(isInside('/a/b', '/a/b/../c')).toBe(false)
  })

  it('resolves symlinks of the deepest existing prefix, so a link out of the sandbox is outside', () => {
    symlinkSync(outside, join(sandboxRoot, 'escape'), 'junction')
    expect(realpathDeep(join(sandboxRoot, 'escape', 'not-yet', 'file'))).toBe(join(outside, 'not-yet', 'file'))
    expect(checkMeetingsFolder(join(sandboxRoot, 'escape', 'meetings'), sandboxRoot).ok).toBe(false)
    expect(
      checkMeetingsFolder(join(sandboxRoot, 'acceptance', 'r1', 'userdata', 'Métis Meetings'), sandboxRoot).ok
    ).toBe(true)
  })
})

describe('app path', () => {
  it('accepts a bundle inside the sandbox', () => {
    expect(checkAppPath(join(sandboxRoot, 'Applications', 'Metis QA.app'), sandboxRoot).ok).toBe(true)
  })

  it('refuses /Applications, outside paths, non-bundles and symlinks out', () => {
    expect(checkAppPath('/Applications/Metis.app', sandboxRoot)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('/Applications')
    })
    expect(checkAppPath('/Applications/Metis QA.app', sandboxRoot).ok).toBe(false)
    expect(checkAppPath(join(outside, 'Metis QA.app'), sandboxRoot)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('outside the sandbox')
    })
    expect(checkAppPath(join(sandboxRoot, 'Applications'), sandboxRoot).ok).toBe(false)
    expect(checkAppPath(join(sandboxRoot, 'Applications', 'Missing.app'), sandboxRoot).ok).toBe(false)
    symlinkSync(join(outside, 'Metis QA.app'), join(sandboxRoot, 'Applications', 'Link.app'), 'junction')
    expect(checkAppPath(join(sandboxRoot, 'Applications', 'Link.app'), sandboxRoot).ok).toBe(false)
    expect(checkAppPath('relative/Metis QA.app', sandboxRoot).ok).toBe(false)
  })

  it('refuses a symlink that resolves into /Applications', () => {
    const fake = (path: string) => (path.endsWith('Link.app') ? '/Applications/Metis.app' : path)
    expect(checkAppPath(join(sandboxRoot, 'Applications', 'Link.app'), sandboxRoot, { realpath: fake })).toMatchObject({
      ok: false,
      detail: expect.stringContaining('symlink into the installed')
    })
  })
})

describe('bundle identity', () => {
  it('requires exactly com.mantu.asktoto.qa and names the real identity when refusing it', () => {
    expect(checkBundleId(QA_BUNDLE_ID).ok).toBe(true)
    expect(checkBundleId('com.mantu.asktoto')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('real identity')
    })
    expect(checkBundleId('com.mantu.asktoto.qa.helper').ok).toBe(false)
    expect(checkBundleId(null).ok).toBe(false)
    expect(checkBundleId(undefined).ok).toBe(false)
  })
})

describe('child environment', () => {
  it('passes for the environment the harness builds', () => {
    const checks = checkChildEnv(childEnv(), sandboxRoot)
    expect(checks.filter((check) => !check.ok)).toEqual([])
  })

  it('never inherits credentials, OneDrive or the real HOME from the harness environment', () => {
    const env = buildChildEnv({
      parentEnv: {
        ...parentEnv(),
        OPENAI_API_KEY: 'x',
        GITHUB_TOKEN: 'y',
        OneDrive: '/Users/real/OneDrive',
        ASKTOTO_LOCAL_KEYSTORE: ''
      },
      layout: layout(),
      platform: 'darwin'
    })
    expect(Object.keys(env)).not.toContain('OPENAI_API_KEY')
    expect(Object.keys(env)).not.toContain('GITHUB_TOKEN')
    expect(Object.keys(env)).not.toContain('OneDrive')
    expect(env.HOME).toBe(layout().home)
    expect(env.TMPDIR).toBe(layout().tmp)
    expect(env.ASKTOTO_USERDATA).toBe(layout().userData)
    expect(env.ASKTOTO_LOCAL_KEYSTORE).toBe('1')
    expect(env.METIS_QA_CAPTURE_FILE).toBeUndefined()
  })

  it.each([
    ['HOME', '/Users/real'],
    ['TMPDIR', '/var/folders/zz/T'],
    ['ASKTOTO_USERDATA', '/Users/real/Library/Application Support/asktoto']
  ])('refuses %s outside the sandbox', (name, value) => {
    const checks = checkChildEnv({ ...childEnv(), [name]: value }, sandboxRoot)
    expect(checks.find((check) => check.id === `env-${name}`)?.ok).toBe(false)
  })

  it('refuses a missing variable, a credential-shaped variable, OneDrive and a missing local keystore flag', () => {
    const env: Record<string, string | undefined> = { ...childEnv() }
    delete env.HOME
    expect(checkChildEnv(env, sandboxRoot).find((check) => check.id === 'env-HOME')?.ok).toBe(false)
    expect(
      checkChildEnv({ ...childEnv(), ANTHROPIC_API_KEY: 'k' }, sandboxRoot).find(
        (check) => check.id === 'env-credentials'
      )?.ok
    ).toBe(false)
    expect(
      checkChildEnv({ ...childEnv(), CLOUDFLARE_ACCOUNT_ID: 'a' }, sandboxRoot).find(
        (check) => check.id === 'env-credentials'
      )?.ok
    ).toBe(false)
    expect(
      checkChildEnv({ ...childEnv(), OneDriveCommercial: '/x' }, sandboxRoot).find(
        (check) => check.id === 'env-onedrive'
      )?.ok
    ).toBe(false)
    expect(
      checkChildEnv({ ...childEnv(), ASKTOTO_LOCAL_KEYSTORE: '' }, sandboxRoot).find(
        (check) => check.id === 'env-keystore'
      )?.ok
    ).toBe(false)
  })

  it('refuses an optional path variable that points outside', () => {
    expect(
      checkChildEnv({ ...childEnv(), XDG_CONFIG_HOME: '/Users/real/.config' }, sandboxRoot).some(
        (check) => check.id === 'env-XDG_CONFIG_HOME' && !check.ok
      )
    ).toBe(true)
  })
})

describe('harness environment', () => {
  it('requires isolate.sh and a sandboxed HOME, TMPDIR and ASKTOTO_USERDATA', () => {
    expect(checkParentEnv(parentEnv(), sandboxRoot).every((check) => check.ok)).toBe(true)
    expect(
      checkParentEnv({ ...parentEnv(), METIS_LOOP_ISOLATED: undefined }, sandboxRoot).find(
        (check) => check.id === 'isolate-wrapper'
      )?.ok
    ).toBe(false)
    expect(
      checkParentEnv({ ...parentEnv(), HOME: '/Users/real' }, sandboxRoot).find((check) => check.id === 'parent-HOME')
        ?.ok
    ).toBe(false)
  })
})

describe('commands', () => {
  it.each([
    'open',
    '/usr/bin/open',
    'launchctl',
    '/bin/launchctl',
    'osascript',
    '/usr/bin/osascript'
  ])('refuses %s', (file) => {
    expect(checkCommand(file, ['-a', 'Metis']).ok).toBe(false)
    expect(() => assertCommandAllowed(file)).toThrow(GuardError)
  })

  it('refuses them when named inside a shell wrapper', () => {
    expect(checkCommand('/bin/sh', ['-c', 'open -a "Metis QA"']).ok).toBe(false)
    expect(checkCommand('/bin/bash', ['-c', 'launchctl setenv ASKTOTO_USERDATA /tmp/x']).ok).toBe(false)
    expect(checkCommand('/usr/bin/env', ['osascript', '-e', 'x']).ok).toBe(false)
    expect(checkCommand('/bin/zsh', ['-c', 'echo hi; /usr/bin/open .']).ok).toBe(false)
  })

  it('allows the helpers the tooling uses', () => {
    for (const file of [
      '/usr/bin/ditto',
      '/usr/bin/codesign',
      '/usr/bin/plutil',
      '/bin/ps',
      '/usr/bin/say',
      '/usr/bin/afconvert',
      '/Users/x/Metis QA.app/Contents/MacOS/Metis QA'
    ]) {
      expect(checkCommand(file, ['-x']).ok).toBe(true)
    }
    // words that merely contain a forbidden name are not the command
    expect(checkCommand('/bin/sh', ['-c', 'echo reopen openssl']).ok).toBe(true)
  })
})

describe('aggregate guard', () => {
  const config = () => ({
    sandboxRoot,
    appPath: join(sandboxRoot, 'Applications', 'Metis QA.app'),
    bundleId: QA_BUNDLE_ID,
    childEnv: childEnv(),
    parentEnv: parentEnv(),
    meetingsFolder: layout().meetingsFolder
  })

  it('passes a fully sandboxed QA launch', () => {
    expect(evaluateGuards(config()).ok).toBe(true)
    expect(assertGuards(config()).length).toBeGreaterThan(5)
  })

  it('names every failed check in the error', () => {
    const bad = { ...config(), appPath: '/Applications/Metis.app', bundleId: 'com.mantu.asktoto' }
    expect(() => assertGuards(bad)).toThrow(/app-path.*bundle-id/s)
    try {
      assertGuards(bad)
    } catch (error) {
      expect((error as GuardError).checks.some((check) => !check.ok)).toBe(true)
    }
  })

  it('stops at an invalid sandbox root without evaluating anything else', () => {
    const result = evaluateGuards({ ...config(), sandboxRoot: outside })
    expect(result.ok).toBe(false)
    expect(result.checks).toHaveLength(1)
  })

  it('can skip the isolate.sh requirement for install, which runs the same checks without a launch', () => {
    const { parentEnv: _ignored, ...rest } = config()
    expect(evaluateGuards({ ...rest, requireIsolateWrapper: false }).ok).toBe(true)
  })
})

describe('writes', () => {
  it('refuses to write or delete outside the sandbox', () => {
    expect(() => assertWritableInSandbox(join(sandboxRoot, 'Applications', 'x'), sandboxRoot)).not.toThrow()
    expect(() => assertWritableInSandbox(join(outside, 'x'), sandboxRoot)).toThrow(GuardError)
    expect(() => assertWritableInSandbox('/Applications/Metis.app', sandboxRoot)).toThrow(GuardError)
  })
})
