import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { windowsPowerShell } from './lib/signing-policy.mjs'

// This is the INSTALLED electron-updater consumer (windowsExecutableCodeSignatureVerifier.js), not a
// second implementation of its DN/CN matching rules — the same module NsisUpdater.verifySignature calls
// at real update time (NsisUpdater.js:16, 84-100). Each scenario runs in a disposable child process so a
// dependency regression cannot hang the Vitest worker, matching scripts/updater-yaml-compat.test.ts.
//
// The preload replaces child_process.execFile BEFORE the verifier module requires "child_process":
// require("child_process") and require("node:child_process") return the SAME singleton module object,
// and the verifier reads `child_process_1.execFile` fresh on every call rather than destructuring it at
// import time (windowsExecutableCodeSignatureVerifier.js:5,47) — so the patched property is what runs.
// Every scenario below reports its own Path equal to the checked file, so none of them cross into the
// verifier's separate LiteralPath-mismatch branch (":58-65", which falls back to a REAL execFileSync
// probe of powershell.exe and is exercised by nothing in this file).
const ROOT = resolve(__dirname, '..')
const nodeRequire = createRequire(import.meta.url)

const PRELOAD = String.raw`
const cp = require('node:child_process')
const scenario = JSON.parse(process.env.METIS_SYNTHETIC_SIGNATURE)
cp.execFile = function (_file, _args, _options, callback) {
  const payload = { Status: scenario.status, SignerCertificate: { Subject: scenario.subject }, Path: scenario.path }
  callback(null, JSON.stringify(payload), '')
}
`

const CONSUMER = String.raw`
const verifierPath = require.resolve('electron-updater/out/windowsExecutableCodeSignatureVerifier.js')
const { verifySignature } = require(verifierPath)
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
const logger = { info() {}, warn() {}, error() {} }
verifySignature(input.publisherNames, input.tempUpdateFile, logger).then((result) => {
  process.stdout.write(JSON.stringify({ result }))
}).catch((error) => {
  process.stdout.write(JSON.stringify({ error: String((error && error.message) || error) }))
})
`

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function runScenario(
  scenario: { status: number; subject: string },
  publisherNames: string[]
): { result: string | null } {
  const workspace = mkdtempSync(join(tmpdir(), 'metis-update-publisher-acceptance-'))
  temporaryDirectories.push(workspace)
  const tempUpdateFile = join(workspace, 'Metis-Setup-9.9.9-fixture.exe')
  writeFileSync(tempUpdateFile, 'fixture')
  const preloadPath = join(workspace, 'preload.cjs')
  writeFileSync(preloadPath, PRELOAD)
  const child = spawnSync(process.execPath, ['--require', preloadPath, '-e', CONSUMER], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
    maxBuffer: 128 * 1024,
    input: JSON.stringify({ publisherNames, tempUpdateFile }),
    env: {
      ...process.env,
      METIS_SYNTHETIC_SIGNATURE: JSON.stringify({ status: scenario.status, subject: scenario.subject, path: tempUpdateFile })
    }
  })
  expect(child.error, 'verifier consumer must exit within its subprocess bound').toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.status).toBe(0)
  expect(child.stderr).toBe('')
  return JSON.parse(child.stdout)
}

// design §6 row 3, all listed cases.
const CASES: Array<{
  name: string
  status: number
  subject: string
  publisherNames: string[]
  accepted: boolean
}> = [
  {
    name: 'Status 1 (UnknownError) rejects even a publisherName that matches the signer CN — an untrusted-root install cannot be rescued by any pin',
    status: 1,
    subject: 'CN=Mantu',
    publisherNames: ['Mantu'],
    accepted: false
  },
  {
    name: 'Status 0 + CN=Mantu is accepted by a transitional pin that still lists the old CN',
    status: 0,
    subject: 'CN=Mantu',
    publisherNames: ['Mantu', 'MANTU GROUP SA'],
    accepted: true
  },
  {
    name: 'Status 0 + a new DN is accepted by the same transitional pin, matched via its CN entry',
    status: 0,
    subject: 'CN=MANTU GROUP SA, O=MANTU GROUP SA, L=Geneva, S=Geneva, C=CH',
    publisherNames: ['Mantu', 'MANTU GROUP SA'],
    accepted: true
  },
  {
    name: 'Status 0 + a new DN is rejected by a pin that still lists only the old CN (why P2 needs a bridge release T)',
    status: 0,
    subject: 'CN=MANTU GROUP SA, O=MANTU GROUP SA, L=Geneva, S=Geneva, C=CH',
    publisherNames: ['Mantu'],
    accepted: false
  },
  {
    name: 'a DN-subset pin entry is accepted by a signer with additional DN fields',
    status: 0,
    subject: 'CN=MANTU GROUP SA, O=MANTU GROUP SA, L=Geneva, S=Geneva, C=CH',
    publisherNames: ['CN=MANTU GROUP SA, O=MANTU GROUP SA'],
    accepted: true
  },
  {
    name: 'a DN pin entry with a mismatched O= is rejected even though CN matches',
    status: 0,
    subject: 'CN=MANTU GROUP SA, O=MANTU GROUP SA, L=Geneva, S=Geneva, C=CH',
    publisherNames: ['CN=MANTU GROUP SA, O=WRONG ORG'],
    accepted: false
  }
]

describe('electron-updater signature acceptance against the installed verifier (design §3.1, §6 row 3)', () => {
  it.each(CASES)('$name', ({ status, subject, publisherNames, accepted }) => {
    const output = runScenario({ status, subject }, publisherNames)
    if (accepted) {
      expect(output).toEqual({ result: null })
    } else {
      expect(typeof output.result).toBe('string')
      expect(output.result).toBeTruthy()
    }
  })

  it.runIf(process.platform === 'win32')(
    'the real verifier accepts a Windows system binary\'s true signer and rejects an unrelated pin',
    async () => {
      const verifierPath = nodeRequire.resolve('electron-updater/out/windowsExecutableCodeSignatureVerifier.js')
      const { verifySignature } = nodeRequire(verifierPath) as {
        verifySignature: (names: string[], path: string, logger: unknown) => Promise<string | null>
      }
      const logger = { info() {}, warn() {}, error() {} }
      const exe = windowsPowerShell()
      await expect(verifySignature(['Microsoft Windows'], exe, logger)).resolves.toBeNull()
      await expect(verifySignature(['Mantu'], exe, logger)).resolves.not.toBeNull()
    }
  )

  // Dependency pin: if a future electron-updater upgrade changes what happens when app-update.yml has
  // no publisherName at all, this must fail and get reviewed — NOT change behavior silently. Today,
  // "no pin" means "no verification at all" (NsisUpdater.js:87-90), which is exactly the unsafe state
  // design §3.2/§2.7 exists to make impossible to publish.
  it('pins that NsisUpdater.verifySignature still returns null (skips verification) when the on-disk pin is absent', () => {
    const source = readFileSync(nodeRequire.resolve('electron-updater/out/NsisUpdater.js'), 'utf8')
    expect(source).toMatch(/publisherName\s*==\s*null\)\s*\{\s*return null;/)
  })
})
