import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { HIGH_TIER_ASR_MODEL, asrModelBytes, asrModelFileUrl } from './asr-model-manifest'

type AsrProvisioningSources = { main: string; bootstrap: string; adapter: string; download: string }

/** Source-only proof of the live registration chain; refusal behavior uses the real adapters below. */
function connectedAsrProvisioning(text: AsrProvisioningSources): boolean {
  // This parser label is synthetic; keep real source-read paths literal below.
  const fixtureExtension = '.' + 'ts'
  const parse = (value: string) => ts.createSourceFile('asr' + fixtureExtension, value, ts.ScriptTarget.Latest, true)
  const main = parse(text.main)
  const bootstrap = parse(text.bootstrap)
  const adapter = parse(text.adapter)
  const download = parse(text.download)
  const compact = (node: ts.Node) => node.getText().replace(/\s/g, '')
  const imported = (source: ts.SourceFile, name: string, path: string) => source.statements.some((node) =>
    ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === path &&
    !node.importClause?.isTypeOnly && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
    node.importClause.namedBindings.elements.some((item) => item.name.text === name && !item.propertyName && !item.isTypeOnly))
  const body = (source: ts.SourceFile, name: string) => source.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name
  )?.body
  const call = (block: ts.Block, name: string, firstArgument?: string) => block.statements.find(
    (node): node is ts.ExpressionStatement => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
      compact(node.expression.expression) === name &&
      (firstArgument === undefined || compact(node.expression.arguments[0]) === firstArgument)
  )?.expression as ts.CallExpression | undefined
  const property = (node: ts.Node | undefined, name: string): ts.Expression | undefined => {
    if (!node || !ts.isObjectLiteralExpression(node)) return undefined
    const item = node.properties.find((item) => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && item.name.getText() === name)
    return item && ts.isPropertyAssignment(item) ? item.initializer : item && ts.isShorthandPropertyAssignment(item) ? item.name : undefined
  }
  const matches = (node: ts.Node | undefined, expected: string) => !!node && compact(node) === expected
  const registration = body(main, 'registerIpc')
  const provisioning = body(bootstrap, 'registerOptionalModelProvisioningIpc')
  const boundary = body(adapter, 'registerHighTierAsrModelFetch')
  const admission = body(download, 'ensureHighTierAsrModelExplicit')
  if (!registration || !provisioning || !boundary || !admission ||
    !imported(main, 'registerOptionalModelProvisioningIpc', './speech-pack-bootstrap') ||
    !imported(bootstrap, 'registerHighTierAsrModelFetch', './ipc/asr-model-download') ||
    !imported(adapter, 'ensureHighTierAsrModelExplicit', '../asr-model-download')) return false
  const mainOptions = call(registration, 'registerOptionalModelProvisioningIpc')?.arguments[0]
  if (!['ipcMain', 'assertMainWindow', 'requireAuth'].every((name) => matches(property(mainOptions, name), name)) ||
    !matches(property(mainOptions, 'auditAsrTransfer'), "()=>auditLog('asr.model.fetch_requested',{bytes:asrModelBytes()})")) return false
  const asrOptions = call(provisioning, 'registerHighTierAsrModelFetch')?.arguments[0]
  if (!matches(property(asrOptions, 'ipcMain'), 'options.ipcMain') ||
    !matches(property(asrOptions, 'assertMainWindow'), 'options.assertMainWindow') ||
    !matches(property(asrOptions, 'authenticated'), 'options.requireAuth') ||
    !matches(property(asrOptions, 'runtimeAvailable'), 'packageRuntimeAvailable') ||
    !matches(property(asrOptions, 'onTransfer'), 'options.auditAsrTransfer')) return false
  const policy = property(asrOptions, 'authorityReadable')
  if (!policy || !ts.isArrowFunction(policy) || !ts.isBlock(policy.body) ||
    !matches(policy.body.statements[0], 'constauthority=awaitreadSettingsAtAuthorityBoundary()') ||
    !matches(policy.body.statements[1], "return(authority.readable&&resolveTrustedSpeechPackPolicy(authority.settings,authority.localSpeechPack)!=='blocked')")) return false
  const handler = call(boundary, 'options.ipcMain.handle', 'IPC.asrModelFetch')?.arguments[1]
  if (!handler || !ts.isArrowFunction(handler) || !ts.isBlock(handler.body) ||
    !matches(handler.body.statements[0], 'options.assertMainWindow(event)')) return false
  const admitted = handler.body.statements[1]
  if (!admitted || !ts.isVariableStatement(admitted)) return false
  const initialized = admitted.declarationList.declarations[0]?.initializer
  if (!initialized || !ts.isAwaitExpression(initialized) || !ts.isCallExpression(initialized.expression) ||
    compact(initialized.expression.expression) !== 'ensureHighTierAsrModelExplicit') return false
  const guardOptions = initialized.expression.arguments[0]
  if (!matches(property(guardOptions, 'authenticated'), 'options.authenticated()') ||
    !['runtimeAvailable', 'authorityReadable', 'onTransfer'].every((name) => matches(property(guardOptions, name), `options.${name}`)) ||
    !matches(handler.body.statements[2], 'return{ok}')) return false
  if (!matches(admission.statements[0], 'if(!options.authenticated||!(awaitoptions.runtimeAvailable())||!(awaitoptions.authorityReadable()))returnfalse') ||
    !matches(admission.statements[1], 'options.onTransfer()') ||
    !matches(admission.statements[2], 'returnensureHighTierAsrModel()')) return false
  const removal = call(registration, 'ipcMain.handle', 'IPC.asrModelRemove')?.arguments[1]
  if (!removal || !ts.isArrowFunction(removal) || !ts.isBlock(removal.body)) return false
  const removalStatements = removal.body.statements
  return ['assertMainWindow(e)', 'if(!requireAuth())return{ok:false}', 'removeHighTierAsrModel()', "auditLog('asr.model.removed',{})", 'return{ok:true}']
    .every((expected, index) => matches(removalStatements[index], expected))
}

/**
 * MQA-247 — the high-accuracy transcription model's pin.
 *
 * These are the assertions that would have caught the two defects behind this feature: a manifest pointing
 * at a mutable ref (so two builds embed different bytes under one version), and a manifest whose model id
 * has drifted from the one the host actually looks for (so the fetch succeeds and the loader still picks
 * the floor). Both are silent failures, which is why they are pinned rather than trusted.
 */
describe('MQA-247 — the high-tier ASR manifest', () => {
  const host = readFileSync(join(__dirname, 'whisper-asr-host.ts'), 'utf8')

  it('pins an immutable commit, never a branch', () => {
    // scripts/fetch-models.mjs builds its URLs as /resolve/main/ — a MUTABLE ref. That is exactly the
    // reproducibility hole packaged-model-claims.contract.test.ts closes for the LLM weights, and the ASR
    // side had no equivalent rule until this one.
    expect(HIGH_TIER_ASR_MODEL.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(HIGH_TIER_ASR_MODEL.revision).not.toBe('main')
    for (const file of HIGH_TIER_ASR_MODEL.files) {
      const url = asrModelFileUrl(HIGH_TIER_ASR_MODEL, file)
      expect(url).toContain(`/resolve/${HIGH_TIER_ASR_MODEL.revision}/`)
      expect(url).not.toMatch(/\/resolve\/(main|master)\//)
    }
  })

  it('every file carries a real byte length and a full SHA-256', () => {
    expect(HIGH_TIER_ASR_MODEL.files.length).toBeGreaterThanOrEqual(7)
    const seen = new Set<string>()
    for (const file of HIGH_TIER_ASR_MODEL.files) {
      expect(file.bytes, `${file.path} has no size`).toBeGreaterThan(0)
      expect(file.sha256, `${file.path} has a malformed digest`).toMatch(/^[0-9a-f]{64}$/)
      expect(seen.has(file.path), `${file.path} listed twice`).toBe(false)
      seen.add(file.path)
    }
  })

  it('the model id matches the tier the host actually looks for', () => {
    // Two copies of a string in two files is how a fetch lands 1.61 GB in a directory nothing reads. The
    // id is also the on-disk directory name transformers.js resolves, so a drift here is silent.
    expect(host).toContain(`id: '${HIGH_TIER_ASR_MODEL.id}'`)
    const firstTier = host.slice(host.indexOf('const MODEL_TIERS'), host.indexOf('const MODEL_REVISION'))
    expect(firstTier.indexOf(HIGH_TIER_ASR_MODEL.id), 'the manifest model is not the FIRST tier').toBeGreaterThan(-1)
  })

  it('reports a total that matches the sum, and is the size the copy quotes', () => {
    const total = HIGH_TIER_ASR_MODEL.files.reduce((n, f) => n + f.bytes, 0)
    expect(asrModelBytes()).toBe(total)
    // ~1.61 GB. If this ever changes, the user-facing size in Settings has to change with it — that copy
    // is what someone on a metered connection agrees to before the transfer starts.
    expect(total).toBeGreaterThan(1.5e9)
    expect(total).toBeLessThan(1.8e9)
  })

  it('the packaged app deliberately does NOT ship it — the exclusion and the fetch must agree', () => {
    // If someone ever un-excludes it, this fetch becomes dead weight AND the installer breaches GitHub's
    // 2 GiB per-asset limit. The two decisions are one decision.
    const builder = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')
    expect(builder).toContain(`!${HIGH_TIER_ASR_MODEL.id}/**`)
  })
})

/**
 * MQA-247 — the fetch has to be reachable, explicit, and honest about its size.
 *
 * The download machinery existing is not the same as a user being able to use it. And a 1.61 GB transfer
 * that starts without the number being shown first is not consent — it is a surprise on someone's metered
 * connection. Source checks follow the main registration; adapter tests exercise the real refusal seams.
 */
describe('MQA-247 — the fetch is reachable and explicit', () => {
  const REPO = join(__dirname, '..', '..')
  const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')
  const readSettings = (): string =>
    read('src/renderer/src/features/settings/AiSection.tsx')
  const sources = (): AsrProvisioningSources => ({
    main: read('src/main/index.ts'),
    bootstrap: read('src/main/speech-pack-bootstrap.ts'),
    adapter: read('src/main/ipc/asr-model-download.ts'),
    download: read('src/main/asr-model-download.ts')
  })

  it('is exposed end to end: channel, handler, preload, UI', () => {
    expect(read('src/shared/ipc.ts')).toMatch(/asrModelFetch: 'asrModel:fetch'/)
    expect(connectedAsrProvisioning(sources())).toBe(true)
    expect(read('src/preload/index.ts')).toMatch(/asrModelFetch: \(\)/)
    expect(read('src/preload/index.ts')).toMatch(/asrModelFetch:[\s\S]*?=>\s*ipcRenderer\.invoke\(IPC\.asrModelFetch\)/)
    expect(read('src/renderer/src/features/settings/AudioTab.tsx')).toMatch(
      /<AsrModelRow engine=\{settings\.asrEngine\} \/>/
    )
    const ui = readSettings()
    const click = ui.slice(ui.indexOf('onClick={async () => {', ui.indexOf('export function AsrModelRow')))
    expect(click).toMatch(/if \(state\.ready\) await window\.toto\.asrModelRemove\(\)\s*else await window\.toto\.asrModelFetch\(\)/)
  })

  it('never starts on its own — no timer, no first-import trigger', () => {
    // The floor model works. Beginning 1.61 GB on someone's behalf is not a reasonable default, and the
    // module's failure mode must stay "as before", never "worse than before".
    const main = read('src/main/index.ts')
    expect(main).not.toMatch(/setTimeout\([^)]*ensureHighTierAsrModel/)
    expect(main).not.toMatch(/setInterval\([^)]*ensureHighTierAsrModel/)
    expect(read('src/main/whisper-import.ts')).not.toMatch(/ensureHighTierAsrModel/)
  })

  it('shows the size BEFORE the button that spends it', () => {
    const ui = readSettings()
    expect(ui).toMatch(/Download \$\{gb\} GB/)
    expect(ui).toMatch(/\$\{gb\} GB download/)
  })

  it('the fetch and removal are authenticated and audited like every other state change', () => {
    expect(connectedAsrProvisioning(sources())).toBe(true)
  })

  it('rejects disconnected registration, missing admission guards or removed removal controls', () => {
    const original = sources()
    const mutations: Array<[keyof AsrProvisioningSources, string, string]> = [
      ['main', 'registerOptionalModelProvisioningIpc({', 'registerUnusedModelProvisioningIpc({'],
      ['main', "} from './speech-pack-bootstrap'", "} from './unused-bootstrap'"],
      ['bootstrap', 'registerHighTierAsrModelFetch({', 'registerUnusedAsrModelFetch({'],
      ['bootstrap', 'authenticated: options.requireAuth', 'authenticated: () => true'],
      ['adapter', "from '../asr-model-download'", "from '../unused-asr-model-download'"],
      ['adapter', 'options.assertMainWindow(event)', 'void event'],
      ['adapter', 'runtimeAvailable: options.runtimeAvailable', 'runtimeAvailable: async () => true'],
      ['adapter', 'authorityReadable: options.authorityReadable', 'authorityReadable: () => true'],
      ['adapter', 'onTransfer: options.onTransfer', 'onTransfer: () => undefined'],
      ['download', '!(await options.runtimeAvailable())', 'false'],
      ['download', '!(await options.authorityReadable())', 'false'],
      ['main', "auditLog('asr.model.fetch_requested', { bytes: asrModelBytes() })", "auditLog('unused', {})"],
      ['main', 'ipcMain.handle(IPC.asrModelRemove, (e) => {\n    assertMainWindow(e)\n    if (!requireAuth()) return { ok: false }', 'ipcMain.handle(IPC.asrModelRemove, (e) => {\n    assertMainWindow(e)'],
      ['main', "auditLog('asr.model.removed', {})", 'void 0']
    ]
    for (const [file, before, after] of mutations) {
      expect(original[file], before).toContain(before)
      const changed = original[file].replace(before, after)
      expect(changed, before).not.toBe(original[file])
      expect(connectedAsrProvisioning({ ...original, [file]: changed }), before).toBe(false)
    }
  })
})
