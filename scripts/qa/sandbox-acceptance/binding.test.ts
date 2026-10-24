import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appAsarSha256,
  bindArtifact,
  bindingProblems,
  bindingsAgree,
  bindRun,
  preflightSource,
  readLocalSource,
  resolveSource
} from './binding.mjs'

const H = (char: string, length = 64) => char.repeat(length)
const COMMIT = H('a', 40)
const ZIP = H('b')
const APP = H('c')
const EXE = H('d')

const receipt = (zip = ZIP) => ({
  schema: 'sandbox-install/1',
  zip: { name: 'Metis-QA-1.zip', sha256: zip },
  app: { name: 'Metis QA.app', bundleId: 'com.mantu.asktoto.qa', version: '2.12.0', mainExecutableSha256: EXE }
})

const asset = (name: string, sha256 = H('1')) => ({ name, size: 10, sha256 })
/** A schema-2 provenance that passes the real provenanceProblems: one build per variant, the QA zip carrying `qaSha`. */
const provenance = (qaSha = ZIP) => ({
  schema: 2,
  repository: 'org/repo',
  commit: COMMIT,
  version: '2.12.0',
  run: { id: 99, attempt: 1, url: 'https://example.invalid/runs/99' },
  builds: [
    { variant: 'mac', platform: 'mac', assets: [asset('Metis-2.12.0.dmg'), asset('Metis-2.12.0.zip')] },
    { variant: 'mac-qa-identity', platform: 'mac', assets: [asset('Metis-QA-2.12.0.zip', qaSha)] },
    { variant: 'win', platform: 'win', assets: [asset('Metis-Setup-2.12.0.exe')] },
    { variant: 'win-portable', platform: 'win', assets: [asset('Metis-Portable-2.12.0.exe')] }
  ]
})

const clean = { commit: COMMIT, clean: true }

describe('hosted binding (provenance)', () => {
  it('binds a valid provenance whose assets include the installer sha256', () => {
    const result = bindArtifact({ installReceipt: receipt(), appHash: APP, provenance: provenance(), runId: 'r1' })
    expect(result.problems).toEqual([])
    expect(result.binding).toMatchObject({
      commit: COMMIT,
      run: { kind: 'hosted', id: 99, attempt: 1, url: 'https://example.invalid/runs/99' },
      installerSha256: ZIP,
      appHash: APP,
      bindingSource: 'provenance'
    })
    expect(bindingProblems(result.binding)).toEqual([])
  })

  it('requires the installer sha256 to be one of the provenance assets', () => {
    const wrong = resolveSource({ provenance: provenance(H('9')), installerSha256: ZIP, runId: 'r1' })
    expect(wrong.source).toBeNull()
    expect(wrong.problems.join('\n')).toMatch(/provenance refused|not a builds\[\]\.assets\[\]\.sha256/)
  })

  it('rejects provenance with problems and never returns a binding', () => {
    const result = bindArtifact({
      installReceipt: receipt(),
      appHash: APP,
      provenance: { schema: 1 },
      runId: 'r1'
    })
    expect(result.binding).toBeNull()
    expect(result.problems.join('\n')).toMatch(/provenance refused/)
  })
})

describe('local binding', () => {
  it('binds a clean checkout and says it is asserted, not proven', () => {
    const result = bindArtifact({ installReceipt: receipt(), appHash: APP, local: clean, runId: 'r1' })
    expect(result.problems).toEqual([])
    expect(result.binding).toEqual({
      commit: COMMIT,
      run: { kind: 'local', runId: 'r1' },
      installerSha256: ZIP,
      appHash: APP,
      mainExecutableSha256: EXE,
      bundleVersion: '2.12.0',
      bindingSource: 'local-asserted'
    })
    expect(bindingProblems(result.binding)).toEqual([])
  })

  it('refuses a dirty tree (git runner injected)', () => {
    const run = (_file: string, args: string[]) =>
      args.includes('rev-parse')
        ? { status: 0, stdout: `${COMMIT}\n`, stderr: '', signal: null, error: null }
        : { status: 0, stdout: ' M scripts/qa/x.mjs\n', stderr: '', signal: null, error: null }
    const local = readLocalSource('/repo', run as never)
    expect(local).toEqual({ commit: COMMIT, clean: false })
    const result = bindArtifact({ installReceipt: receipt(), appHash: APP, local, runId: 'r1' })
    expect(result.binding).toBeNull()
    expect(result.problems.join('\n')).toMatch(/uncommitted changes/)
  })

  it('reads a clean tree as clean, and a failed git as no commit', () => {
    const ok = (_f: string, args: string[]) => ({
      status: 0,
      stdout: args.includes('rev-parse') ? `${COMMIT}\n` : '',
      stderr: '',
      signal: null,
      error: null
    })
    expect(readLocalSource('/repo', ok as never)).toEqual({ commit: COMMIT, clean: true })
    const bad = () => ({ status: 128, stdout: '', stderr: 'fatal', signal: null, error: null })
    expect(readLocalSource('/repo', bad as never).commit).toBeNull()
  })

  it('refuses a missing receipt, a missing app.asar and no source at all', () => {
    const result = bindArtifact({ installReceipt: null, appHash: null, local: null, runId: 'r1' })
    expect(result.binding).toBeNull()
    const text = result.problems.join('\n')
    expect(text).toMatch(/no readable install receipt/)
    expect(text).toMatch(/no readable|app\.asar/)
    expect(text).toMatch(/no source commit/)
  })
})

describe('bindingsAgree and bindingProblems', () => {
  const binding = (over = {}) => ({
    commit: COMMIT,
    run: { kind: 'local', runId: 'r1' },
    installerSha256: ZIP,
    appHash: APP,
    mainExecutableSha256: EXE,
    bindingSource: 'local-asserted',
    ...over
  })

  it('rejects mixed commits or installer shas', () => {
    expect(bindingsAgree([binding(), binding()]).agree).toBe(true)
    expect(bindingsAgree([binding(), binding({ commit: H('e', 40) })])).toEqual({
      agree: false,
      disagreement: 'commit differs between reports'
    })
    expect(bindingsAgree([binding(), binding({ installerSha256: H('f') })]).agree).toBe(false)
    expect(bindingsAgree([binding(), binding({ appHash: H('1') })]).agree).toBe(false)
  })

  it('rejects a malformed binding and a source that does not match the run kind', () => {
    expect(bindingProblems(undefined)).toEqual(['the report has no binding block'])
    expect(bindingProblems(binding({ commit: 'abc' })).join('\n')).toMatch(/40-hex/)
    expect(bindingProblems(binding({ run: { kind: 'hosted', id: 3, attempt: 1 } })).join('\n')).toMatch(
      /must be bound by provenance/
    )
  })
})

describe('app hash and the run wrapper', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'g88-bind-')))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appHash is the app.asar sha256', () => {
    const app = join(dir, 'Metis QA.app')
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Resources', 'app.asar'), 'asar-bytes')
    const seen: string[] = []
    expect(appAsarSha256(app, (path: string) => (seen.push(path), APP))).toBe(APP)
    expect(seen[0]).toBe(join(app, 'Contents', 'Resources', 'app.asar'))
    expect(appAsarSha256(app)).toMatch(/^[0-9a-f]{64}$/)
    expect(appAsarSha256(join(dir, 'missing.app'))).toBeNull()
  })

  it('bindRun refuses a receipt left over from a different zip', () => {
    const app = join(dir, 'Metis QA.app')
    writeFileSync(join(dir, 'install-receipt.json'), JSON.stringify(receipt()))
    const run = (_f: string, args: string[]) => ({
      status: 0,
      stdout: args.includes('rev-parse') ? `${COMMIT}\n` : '',
      stderr: '',
      signal: null,
      error: null
    })
    const common = { appPath: app, receiptDir: dir, runId: 'r1', deps: { run: run as never, hash: () => APP } }
    expect(bindRun({ ...common, expectedInstallerSha256: ZIP }).binding).not.toBeNull()
    const other = bindRun({ ...common, expectedInstallerSha256: H('7') })
    expect(other.binding).toBeNull()
    expect(other.problems.join('\n')).toMatch(/different zip/)
  })

  it('preflightSource checks the source before any launch', () => {
    const run = () => ({ status: 0, stdout: ' M x\n', stderr: '', signal: null, error: null })
    const result = preflightSource({ runId: 'r1', deps: { run: run as never } })
    expect(result.problems.length).toBeGreaterThan(0)
    expect(preflightSource({ runId: 'r1', provenancePath: join(dir, 'nope.json') }).problems).toEqual([
      '--provenance is not readable JSON'
    ])
  })
})
