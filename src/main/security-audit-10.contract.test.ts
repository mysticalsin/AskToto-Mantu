import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { sourceIndexOf } from '../../scripts/lib/source-layout'
import { createListeningStateHandler } from './listening-state-ipc'
import { calendarToday } from './calendar'
import { getGraphToken } from './auth'
import { auditLog } from './logger'
import { ipcModuleSource } from '../../scripts/lib/ipc-module-source'
import { readModuleSource } from '../test-helpers/module-source'

vi.mock('./auth', () => ({ getGraphToken: vi.fn(async () => 'synthetic-calendar-security-token') }))
vi.mock('./logger', () => ({ auditLog: vi.fn() }))

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const importSnapshotSrc = readFileSync(join(__dirname, 'import-jobs-snapshot-ipc.ts'), 'utf8')
const importAudioIpcSrc = ipcModuleSource('import-audio-ipc')
const historyIpcSrc = ipcModuleSource('history-ipc')
const recallIpcSrc = ipcModuleSource('recall-ipc')

function onlySourceNode<T>(nodes: T[], label: string): T {
  if (nodes.length !== 1) throw new Error(`Expected one ${label}, found ${nodes.length}`)
  return nodes[0]
}

/** Bind the extracted contracts to actual imports, registrations and returned public fields. The mapper binding
 *  and the registration call live in index.ts; the list handler itself lives in the import-audio IPC module. */
function requireImportSnapshotConnection(indexText: string, audioIpcText: string, helperText: string): void {
  // These parser labels are synthetic; keep real source-read paths literal above.
  const fixtureExtension = '.' + 'ts'
  const index = ts.createSourceFile('index' + fixtureExtension, indexText, ts.ScriptTarget.Latest, true)
  const audioIpc = ts.createSourceFile(
    'import-audio-ipc' + fixtureExtension,
    audioIpcText,
    ts.ScriptTarget.Latest,
    true
  )
  const helper = ts.createSourceFile(
    'import-jobs-snapshot-ipc' + fixtureExtension,
    helperText,
    ts.ScriptTarget.Latest,
    true
  )
  const compact = (node: ts.Node): string => node.getText().replace(/\s+/g, '')
  const snapshotImport = onlySourceNode(
    index.statements.filter(
      (node): node is ts.ImportDeclaration =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === './import-jobs-snapshot-ipc'
    ),
    'snapshot module import'
  ).importClause
  expect(snapshotImport?.isTypeOnly).toBe(false)
  if (!snapshotImport?.namedBindings || !ts.isNamespaceImport(snapshotImport.namedBindings))
    throw new Error('Expected runtime snapshot namespace import')
  expect(snapshotImport.namedBindings.name.text).toBe('importJobsSnapshotIpc')

  const audioSnapshotImport = onlySourceNode(
    audioIpc.statements.filter(
      (node): node is ts.ImportDeclaration =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '../import-jobs-snapshot-ipc'
    ),
    'import-audio snapshot module import'
  ).importClause
  expect(audioSnapshotImport?.isTypeOnly).toBe(false)
  if (!audioSnapshotImport?.namedBindings || !ts.isNamespaceImport(audioSnapshotImport.namedBindings))
    throw new Error('Expected runtime snapshot namespace import in the import-audio IPC module')
  expect(audioSnapshotImport.namedBindings.name.text).toBe('importJobsSnapshotIpc')

  // The entry point must hand the real job manager accessor and the public mapper to the registration.
  const registerIpc = onlySourceNode(
    index.statements.filter(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'registerIpc'
    ),
    'top-level registerIpc declaration'
  )
  if (!registerIpc.body) throw new Error('Expected actual registerIpc body')
  const audioRegistration = onlySourceNode(
    registerIpc.body.statements
      .filter(ts.isExpressionStatement)
      .map((node) => node.expression)
      .filter(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) && compact(node.expression) === 'registerImportAudioIpc'
      ),
    'direct registerImportAudioIpc call'
  )
  const audioDeps = audioRegistration.arguments[0]
  if (!audioDeps || !ts.isObjectLiteralExpression(audioDeps)) throw new Error('Expected registerImportAudioIpc deps')
  for (const name of ['getImportJobs', 'importJobView']) {
    expect(
      audioDeps.properties.some((node) => ts.isShorthandPropertyAssignment(node) && node.name.text === name),
      `registerImportAudioIpc receives ${name}`
    ).toBe(true)
  }

  const registerAudioIpc = onlySourceNode(
    audioIpc.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'registerImportAudioIpc'
    ),
    'top-level registerImportAudioIpc declaration'
  )
  if (!registerAudioIpc.body) throw new Error('Expected actual registerImportAudioIpc body')
  const registration = onlySourceNode(
    registerAudioIpc.body.statements
      .filter(ts.isExpressionStatement)
      .map((node) => node.expression)
      .filter(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          compact(node.expression) === 'ipcMain.handle' &&
          node.arguments[0] &&
          compact(node.arguments[0]) === 'IPC.importJobsList'
      ),
    'direct importJobsList registration'
  )
  expect(registration.arguments).toHaveLength(2)
  const handler = registration.arguments[1]
  if (!ts.isArrowFunction(handler) || !ts.isBlock(handler.body)) throw new Error('Expected registered handler')
  expect(handler.parameters.map(compact)).toEqual(['e'])
  expect(handler.body.statements.map(compact)).toEqual([
    'assertMainWindow(e)',
    'returnimportJobsSnapshotIpc.listImportJobsSnapshot(e,deps.getWindow,()=>getImportJobs().snapshot(),importJobView)'
  ])
  const mapper = onlySourceNode(
    index.statements
      .filter(ts.isVariableStatement)
      .flatMap((node) =>
        [...node.declarationList.declarations].filter((item) => compact(item.name) === 'importJobView')
      ),
    'public mapper binding'
  )
  expect(mapper.initializer && compact(mapper.initializer)).toBe(
    'importJobsSnapshotIpc.createImportJobView(()=>importJobs?.list()??[])'
  )

  const exportedFunction = (name: string): ts.FunctionDeclaration =>
    onlySourceNode(
      helper.statements.filter(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) &&
          node.name?.text === name &&
          !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ),
      `exported ${name}`
    )
  const authImport = onlySourceNode(
    helper.statements.filter(
      (node): node is ts.ImportDeclaration =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === './auth'
    ),
    'auth import'
  ).importClause
  expect(authImport?.isTypeOnly).toBe(false)
  if (!authImport?.namedBindings || !ts.isNamedImports(authImport.namedBindings))
    throw new Error('Expected auth bindings')
  expect(
    authImport.namedBindings.elements.some(
      (item) =>
        !item.isTypeOnly &&
        item.name.text === 'requireAuth' &&
        (item.propertyName?.text ?? item.name.text) === 'requireAuth'
    )
  ).toBe(true)
  const list = exportedFunction('listImportJobsSnapshot')
  expect(list.parameters.map((parameter) => compact(parameter.name))).toEqual([
    'event',
    'currentWindow',
    'readSnapshot',
    'toView'
  ])
  expect(list.body?.statements.map(compact)).toEqual([
    'returnreadImportJobsSnapshot(requireAuth,()=>captureImportJobsSnapshotScope(event,currentWindow),readSnapshot,toView)'
  ])
  exportedFunction('captureImportJobsSnapshotScope')
  const read = exportedFunction('readImportJobsSnapshot')
  expect(read.parameters.map((parameter) => compact(parameter.name))).toEqual([
    'isAuthorized',
    'captureScope',
    'readSnapshot',
    'toView'
  ])
  expect(read.body?.statements.map(compact)).toEqual([
    'if(!isAuthorized())returnemptyImportJobsSnapshot()',
    'constscopeIsCurrent=captureScope()',
    'if(!scopeIsCurrent)returnemptyImportJobsSnapshot()',
    'constsnapshot=awaitreadSnapshot()',
    'if(!scopeIsCurrent())returnemptyImportJobsSnapshot()',
    'return{...snapshot,jobs:snapshot.jobs.map(toView)}'
  ])
  const factory = exportedFunction('createImportJobView')
  const result = factory.body?.statements[0]
  if (
    !result ||
    !ts.isReturnStatement(result) ||
    !result.expression ||
    !ts.isArrowFunction(result.expression) ||
    !ts.isBlock(result.expression.body)
  )
    throw new Error('Expected returned public mapper')
  const publicReturn = result.expression.body.statements.at(-1)
  if (
    !publicReturn ||
    !ts.isReturnStatement(publicReturn) ||
    !publicReturn.expression ||
    !ts.isObjectLiteralExpression(publicReturn.expression)
  )
    throw new Error('Expected public view object')
  expect(publicReturn.expression.properties.every((property) => !ts.isSpreadAssignment(property))).toBe(true)
  expect(publicReturn.expression.properties.map((property) => property.name && compact(property.name))).toEqual([
    'jobId',
    'title',
    'state',
    'cursor',
    'totalChunks',
    'pct',
    'error',
    'recapError',
    'file',
    'createdAt',
    'updatedAt',
    'queuePosition'
  ])
}

function sliceBetween(from: string, to: string, source = indexSrc): string {
  const start = sourceIndexOf(source, from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = sourceIndexOf(source, to, start + 1)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return source.slice(start, end)
}

/** Slice `source` from `from` to its end — for the last handler of a register function module. */
function sliceToEnd(from: string, source: string): string {
  const start = sourceIndexOf(source, from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  return source.slice(start)
}

describe('AUDIT-10 — Settings surface stays on the isolated main window', () => {
  it('windowMode settings still goes through assertMainWindow and never a second BrowserWindow', () => {
    const body = sliceBetween('ipcMain.handle(IPC.windowMode', 'ipcMain.handle(IPC.windowMinimize')
    expect(body).toMatch(/assertMainWindow\(e\)/)
    expect(body).toMatch(/applySettingsSurface/)
    expect(indexSrc).not.toMatch(/new BrowserWindow\(\{[\s\S]{0,200}settings/)
  })
})

describe('AUDIT-10 — askStart never forwards Error.message to the overlay', () => {
  it('the outer catch sends a constant sentence except for skill-lock integrity', () => {
    const start = indexSrc.lastIndexOf('ipcMain.handle(IPC.askStart')
    const end = indexSrc.indexOf('ipcMain.handle(IPC.askCancel')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = indexSrc.slice(start, end)
    // The outer catch and the deferred (async brain-proof) dispatch share one failure sender, so the
    // constant-sentence rule is asserted on that sender and the catch must delegate to it unchanged.
    expect(body.slice(body.lastIndexOf('} catch (err)'))).toMatch(/^\} catch \(err\) \{\s*failAskStart\(err\)\s*\}/)
    const catchBlock = sliceBetween('const failAskStart = (err: unknown): void => {', '    try {', body)
    expect(catchBlock).toMatch(/isModeSkillIntegrityError\(err\)/)
    expect(catchBlock).toMatch(/'Could not start the answer\.'/)
    expect(catchBlock).not.toMatch(/e\.message/)
    expect(catchBlock).toMatch(/\? err instanceof Error\s*\? err\.message/)
  })
})

describe('AUDIT-10 — SSO-gated listening and ask side effects', () => {
  it('listeningState requires a signed-in session before Dust prewarm or speaker reset', async () => {
    const sideEffects = {
      acceptTransition: vi.fn(() => true),
      consumeMeetingStartActivation: vi.fn(() => true),
      setListeningActive: vi.fn(),
      setTrayRecording: vi.fn(),
      setRecordingPowerSaveBlock: vi.fn(),
      onMeetingStart: vi.fn(),
      releaseParakeet: vi.fn(async () => undefined),
      releaseSpeakerEmbedding: vi.fn(async () => undefined)
    }
    const assertMainWindow = vi.fn()
    const requireAuth = vi.fn(() => false)
    const handler = createListeningStateHandler({ assertMainWindow, requireAuth, ...sideEffects })

    await handler({}, true)
    await handler({}, false)

    expect(assertMainWindow).toHaveBeenCalledTimes(2)
    expect(requireAuth).toHaveBeenCalledTimes(2)
    for (const effect of Object.values(sideEffects)) expect(effect).not.toHaveBeenCalled()
  })

  it('askResetContext and askCancel require a signed-in session', () => {
    const reset = sliceBetween('ipcMain.handle(IPC.askResetContext', 'ipcMain.handle(IPC.armAudio')
    expect(reset).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(reset.indexOf('if (!requireAuth()) return')).toBeLessThan(reset.indexOf('resetDustConversation()'))

    const cancel = sliceBetween('ipcMain.handle(IPC.askCancel', 'ipcMain.handle(IPC.askResetContext')
    expect(cancel).toMatch(/if \(!requireAuth\(\)\) return/)
    // G12: the abort itself moved into askTiming.cancel(streams, id); auth still precedes it.
    expect(cancel.indexOf('if (!requireAuth()) return')).toBeLessThan(cancel.indexOf('askTiming.cancel(streams, id)'))
  })

  it('session clear aborts in-flight ask streams', () => {
    // askCancel stays auth-gated (above): cancel starts nothing, but it is the deliberate AUDIT-10 control.
    // The session boundary itself must tear down every running answer, otherwise a provider request keeps
    // streaming (and billing) after sign-out with no way left to cancel it.
    const revoke = sliceBetween('function revokePrivilegedSurface', 'setSessionClearedHandler(')
    expect(revoke).toMatch(/abortAllAskStreams\(streams\)/)
    // The window-replacement and shutdown teardown share the same helper, not two hand-rolled copies.
    expect(indexSrc.split('abortAllAskStreams(streams)').length - 1).toBe(3)
    expect(indexSrc).not.toMatch(/streams\.forEach\(/)
  })
})

describe('AUDIT-10 — outbound IPC caps sit in front of the network', () => {
  it('licenseActivate consumes the license-activate bucket before activateLicense', () => {
    const body = sliceBetween('ipcMain.handle(IPC.licenseActivate', 'ipcMain.handle(IPC.licenseStatus')
    expect(body).toMatch(/denyIfLimited\('license-activate'\)/)
    expect(body.indexOf("denyIfLimited('license-activate')")).toBeLessThan(body.indexOf('activateLicense'))
    expect(body).not.toMatch(/if \(!requireAuth\(\)\)/)
  })

  it('MCP test/save/push and calendarToday consume their buckets after requireAuth', () => {
    const test = sliceBetween('ipcMain.handle(IPC.mcpTestConnection', 'ipcMain.handle(IPC.mcpSaveConnection')
    expect(test).toMatch(/denyIfLimited\('mcp-outbound'\)/)
    expect(test.indexOf('requireAuth()')).toBeLessThan(test.indexOf("denyIfLimited('mcp-outbound')"))

    const save = sliceBetween('ipcMain.handle(IPC.mcpSaveConnection', 'ipcMain.handle(IPC.mcpDisconnect')
    expect(save).toMatch(/denyIfLimited\('mcp-outbound'\)/)

    const push = sliceBetween('ipcMain.handle(IPC.mcpPush', 'ipcMain.handle(IPC.mcpClickupConnect')
    expect(push).toMatch(/denyIfLimited\('mcp-outbound'\)/)
    expect(push).toMatch(/const conn = s\.mcpConnections\.find/)
    expect(push.indexOf('skipped_confidential')).toBeLessThan(push.indexOf('recordOperatorCrmSend'))
    expect(push.indexOf('skipped_confidential')).toBeLessThan(push.indexOf('pushQueue.enqueue'))

    const cal = sliceBetween('ipcMain.handle(IPC.calendarToday', 'registerRecallIpc(')
    expect(cal).toMatch(/denyIfLimited\('graph-calendar'\)/)
    expect(cal.indexOf('requireAuth()')).toBeLessThan(cal.indexOf("denyIfLimited('graph-calendar')"))
  })

  it('the capture path does not call denyIfLimited', () => {
    const save = sliceBetween('ipcMain.handle(IPC.saveTranscript', 'registerBrainIpc(')
    expect(save).not.toMatch(/denyIfLimited/)
    const feed = sliceBetween('ipcMain.handle(IPC.parakeetFeed', 'ipcMain.handle(IPC.appleSpeechFeed')
    expect(feed).not.toMatch(/denyIfLimited/)
    const arm = sliceBetween('ipcMain.handle(IPC.armAudio', 'ipcMain.handle(IPC.saveTranscript')
    expect(arm).not.toMatch(/denyIfLimited/)
  })

  it('the live listen path uses takeHotPath so overflow is dropped, never queued', () => {
    const save = sliceBetween('ipcMain.handle(IPC.saveTranscript', 'registerBrainIpc(')
    expect(save).toMatch(/takeHotPath\('save-transcript'\)/)
    expect(save.indexOf("takeHotPath('save-transcript')")).toBeLessThan(save.indexOf('saveMeeting'))

    const feed = sliceBetween('ipcMain.handle(IPC.parakeetFeed', 'ipcMain.handle(IPC.appleSpeechFeed')
    expect(feed).toMatch(/takeHotPath\('asr-feed'\)/)
    expect(feed.indexOf("takeHotPath('asr-feed')")).toBeLessThan(feed.indexOf('parakeetTranscribe'))

    const apple = sliceBetween('ipcMain.handle(IPC.appleSpeechFeed', 'ipcMain.handle(IPC.localModelsList')
    expect(apple).toMatch(/takeHotPath\('asr-feed'\)/)
    expect(apple).not.toMatch(/denyIfLimited/)

    const arm = sliceBetween('ipcMain.handle(IPC.armAudio', 'ipcMain.handle(IPC.saveTranscript')
    expect(arm).toMatch(/takeHotPath\('arm-audio'\)/)

    const capture = sliceBetween('ipcMain.handle(IPC.captureScreen', 'ipcMain.handle(IPC.prewarmCapture')
    expect(capture).toMatch(/takeHotPath\('capture-screen'\)/)
    expect(capture).not.toMatch(/denyIfLimited/)
  })
})

describe('AUDIT-10 — remaining disk/network IPC is SSO-gated', () => {
  it('localPrewarm, prewarmCapture, rendererCrash, and update channels require a session', () => {
    const prewarm = sliceBetween('ipcMain.handle(IPC.localPrewarm', 'ipcMain.handle(IPC.captureScreen')
    expect(prewarm).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(prewarm.indexOf('if (!requireAuth()) return')).toBeLessThan(prewarm.indexOf('LocalPrewarmPayloadSchema'))

    const captureWarm = sliceBetween('ipcMain.handle(IPC.prewarmCapture', 'ipcMain.handle(IPC.screenContext')
    expect(captureWarm).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(captureWarm.indexOf('if (!requireAuth()) return')).toBeLessThan(captureWarm.indexOf('prewarmCapture()'))

    const crash = sliceBetween('ipcMain.handle(IPC.rendererCrash', 'ipcMain.handle(IPC.windowMoveBy')
    expect(crash).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(crash.indexOf('if (!requireAuth()) return')).toBeLessThan(crash.indexOf('persistCrash'))

    const check = sliceBetween('ipcMain.handle(IPC.updateCheck', 'ipcMain.handle(IPC.updateDownload')
    expect(check).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(check.indexOf('if (!requireAuth()) return')).toBeLessThan(check.indexOf('checkForUpdateNow'))

    const download = sliceBetween('ipcMain.handle(IPC.updateDownload', 'ipcMain.handle(IPC.updateInstall')
    expect(download).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(download.indexOf('if (!requireAuth()) return')).toBeLessThan(download.indexOf('startUpdateDownload'))

    const install = sliceBetween('ipcMain.handle(IPC.updateInstall', 'ipcMain.handle(IPC.openMailDraft')
    expect(install).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(install.indexOf('if (!requireAuth()) return')).toBeLessThan(install.indexOf('autoUpdater'))
  })

  it('licenseActivate stays ungated (license vs SSO deadlock) and still consumes its bucket', () => {
    const body = sliceBetween('ipcMain.handle(IPC.licenseActivate', 'ipcMain.handle(IPC.licenseStatus')
    expect(body).not.toMatch(/if \(!requireAuth\(\)\)/)
    expect(body).toMatch(/denyIfLimited\('license-activate'\)/)
  })
})

describe('AUDIT-10 — meeting-file IPC uses the shared basename allow-list', () => {
  it('recallOpen, recallExportPlain, recallDelete, and debriefSave call safeMeetingBasename', () => {
    const open = sliceToEnd('ipcMain.handle(IPC.recallOpen', historyIpcSrc)
    expect(open).toMatch(/safeMeetingBasename\(/)

    const exp = sliceBetween('ipcMain.handle(IPC.recallExportPlain', 'ipcMain.handle(IPC.recallDelete,', recallIpcSrc)
    expect(exp).toMatch(/safeMeetingBasename\(/)

    const del = sliceBetween('ipcMain.handle(IPC.recallDelete', 'ipcMain.handle(IPC.recallRename', recallIpcSrc)
    expect(del).toMatch(/safeMeetingBasename\(/)

    const debrief = sliceBetween('ipcMain.handle(IPC.debriefSave', 'ipcMain.handle(IPC.recallDeleteAll', recallIpcSrc)
    expect(debrief).toMatch(/safeMeetingBasename\(/)
  })
})

describe('AUDIT-10 — no production SQL client in src/main', () => {
  it('does not import sqlite, postgres, or issue CREATE TABLE', () => {
    const { readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const root = __dirname
    const stack = [root]
    const hits: string[] = []
    while (stack.length) {
      const dir = stack.pop()!
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const st = statSync(full)
        if (st.isDirectory()) {
          stack.push(full)
          continue
        }
        if (!name.endsWith('.ts')) continue
        if (name.includes('.test.') || name.includes('.contract.')) continue
        const src = readFileSync(full, 'utf8')
        if (/\b(?:better-sqlite3|sqlite3|pg\.Pool|postgres|CREATE TABLE)\b/.test(src)) hits.push(full)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('AUDIT-10 — IPC sender denials are audited, sampled', () => {
  it('assertMainWindow records a reason before throwing', () => {
    const body = sliceBetween('function assertMainWindow', 'function assertBrainReader')
    expect(body).toMatch(/if \(!win \|\| win\.isDestroyed\(\)\)/)
    expect(body).toMatch(/noteIpcDenied\('no_window'\)/)
    expect(body).toMatch(/noteIpcDenied\('sender'\)/)
    expect(body).toMatch(/noteIpcDenied\('frame'\)/)
    expect(indexSrc).toMatch(/auditLog\('security\.ipc_denied'/)
    expect(indexSrc).toMatch(/auditLog\('security\.rate_limited'/)
  })
})

describe('AUDIT-10 — Shiki HTML is sanitized before dangerouslySetInnerHTML', () => {
  it('CodeBlock runs highlighter output through sanitizeShikiHtml', () => {
    const src = readFileSync(join(__dirname, '../renderer/src/components/CodeBlock.tsx'), 'utf8')
    expect(src).toMatch(/import \{ sanitizeShikiHtml \} from '@shared\/sanitize-html'/)
    expect(src).toMatch(/sanitizeShikiHtml\(h\.codeToHtml/)
    expect(src).toMatch(/dangerouslySetInnerHTML/)
  })
})

describe('AUDIT-10 extra — XSS / import / webhook', () => {
  it('the only renderer dangerouslySetInnerHTML is CodeBlock after sanitizeShikiHtml', () => {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    const root = join(__dirname, '../renderer/src')
    const hits: string[] = []
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()!
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          stack.push(full)
          continue
        }
        if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue
        const src = readFileSync(full, 'utf8')
        if (src.includes('dangerouslySetInnerHTML') && !full.endsWith('CodeBlock.tsx')) hits.push(full)
      }
    }
    expect(hits).toEqual([])
  })

  it('every HTML shell ships a CSP, and no BrowserWindow enables webviewTag', () => {
    for (const rel of ['../renderer/index.html', '../renderer/decoder.html', '../../intelligence/index.html']) {
      const html = readFileSync(join(__dirname, rel), 'utf8')
      expect(html).toMatch(/http-equiv="Content-Security-Policy"/)
      expect(html).toMatch(/script-src/)
    }
    expect(indexSrc).not.toMatch(/webviewTag:\s*true/)
    expect(indexSrc).not.toMatch(/<webview/)
  })

  it('actual Graph calendar output retains allowed links and refuses unsafe join URLs', async () => {
    const cases: Array<{ url: unknown; expected: string | undefined }> = [
      {
        url: ' HTTPS://teams.microsoft.com/l/meetup-join/synthetic ',
        expected: 'https://teams.microsoft.com/l/meetup-join/synthetic'
      },
      { url: 'http://calendar.example.test/join', expected: 'http://calendar.example.test/join' },
      { url: 'mailto:synthetic@example.test', expected: 'mailto:synthetic@example.test' },
      { url: 'javascript:alert(1)', expected: undefined },
      { url: 'JaVaScRiPt:alert(1)', expected: undefined },
      { url: 'data:text/html,<script>alert(1)</script>', expected: undefined },
      { url: 'file:///synthetic/private/meeting', expected: undefined },
      { url: 'ms-msdt:/id synthetic', expected: undefined },
      { url: '//untrusted.example.test/join', expected: undefined },
      { url: 'https://calendar.example.test/join\r\nX-Injected: 1', expected: undefined },
      { url: 'https://calendar.example.test/\0join', expected: undefined },
      { url: `https://calendar.example.test/${'x'.repeat(2048)}`, expected: undefined },
      { url: 42, expected: undefined },
      { url: { href: 'https://calendar.example.test/join' }, expected: undefined },
      { url: null, expected: undefined },
      { url: undefined, expected: undefined }
    ]
    const rows = cases.map(({ url }, index) => ({
      subject: `Synthetic security event ${index}`,
      start: { dateTime: '2026-10-18T10:00:00' },
      end: { dateTime: '2026-10-18T10:30:00' },
      onlineMeeting: { joinUrl: url }
    }))
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ value: rows })
    }))
    vi.mocked(getGraphToken).mockClear()
    vi.mocked(auditLog).mockClear()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await calendarToday('UTC')
      expect(getGraphToken).toHaveBeenCalledExactlyOnceWith(['Calendars.Read'])
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/calendarView\?/),
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer synthetic-calendar-security-token',
            Prefer: 'outlook.timezone="UTC"'
          },
          signal: expect.any(AbortSignal)
        })
      )
      expect(result.ok).toBe(true)
      expect(result.events).toHaveLength(cases.length)
      expect(result.events?.map((event) => event.joinUrl)).toEqual(cases.map(({ expected }) => expected))
      expect(auditLog).toHaveBeenCalledExactlyOnceWith('calendar.read', { count: cases.length })
    } finally {
      vi.unstubAllGlobals()
      vi.mocked(getGraphToken).mockClear()
      vi.mocked(auditLog).mockClear()
    }
  })

  it('markdown links and agenda join URLs go through safeHref', () => {
    const md = readFileSync(join(__dirname, '../renderer/src/components/Markdown.tsx'), 'utf8')
    expect(md).toMatch(/safeHref\(href\)/)
    const agenda = readFileSync(join(__dirname, '../renderer/src/components/AgendaView.tsx'), 'utf8')
    expect(agenda).toMatch(/safeHref\(ev\.joinUrl\)/)
  })

  it('import never feeds ffmpeg until magic bytes say media, and never opens the source', () => {
    const pick = readFileSync(join(__dirname, 'import-audio.ts'), 'utf8')
    expect(pick).toMatch(/sniffMediaFile\(pick\.path\)/)
    const ff = readFileSync(join(__dirname, 'ffmpeg-decoder.ts'), 'utf8')
    const startFn = ff.indexOf('export function startFfmpegDecode')
    const endFn = ff.indexOf('\nexport ', startFn + 1)
    const body = endFn === -1 ? ff.slice(startFn) : ff.slice(startFn, endFn)
    expect(body).toContain('sniffMediaFile(sourcePath)')
    expect(body).toContain('IMPORT_NOT_MEDIA')
    expect(body.indexOf('sniffMediaFile(sourcePath)')).toBeLessThan(body.indexOf('child = spawn('))
    const start = sliceBetween(
      'ipcMain.handle(IPC.importAudioStart',
      'ipcMain.handle(IPC.importJobsList',
      importAudioIpcSrc
    )
    expect(start).not.toMatch(/shell\.openPath/)
    expect(start).not.toMatch(/execFile|execSync/)
  })

  it('import job IPC lazily initializes the queue before use, so packaged smoke cannot race first-paint boot', () => {
    const accessor = sliceBetween('function getImportJobs', '/** Minimal .env loader')
    expect(accessor).toMatch(/initializeImportJobs\(\)/)
    expect(accessor).toMatch(/if \(!importJobs\) throw new Error\('Audio import service is unavailable\.'\)/)

    const start = sliceBetween(
      'ipcMain.handle(IPC.importAudioStart',
      'ipcMain.handle(IPC.importJobsList',
      importAudioIpcSrc
    )
    expect(start).toMatch(/const jobs = getImportJobs\(\)/)
    expect(start).toMatch(/jobs\.start\(consumePickedAudio\(parsed\.token\)\)/)
    expect(start).not.toMatch(/if \(!importJobs\) throw new Error\('Audio import service is unavailable\.'\)/)

    const listAndMutations = sliceToEnd('ipcMain.handle(IPC.importJobsList', importAudioIpcSrc)
    requireImportSnapshotConnection(indexSrc, importAudioIpcSrc, importSnapshotSrc)
    expect(listAndMutations).not.toMatch(/getImportJobs\(\)\.list\(\)/)
    const registrationText = sliceBetween(
      'ipcMain.handle(IPC.importJobsList',
      'ipcMain.handle(IPC.importJobCancel',
      importAudioIpcSrc
    ).trim()
    // These mutations must break the actual connection, not leave a disconnected passing helper.
    for (const [indexText, audioText, helperText] of [
      [
        indexSrc.replace('import * as importJobsSnapshotIpc', 'import type * as importJobsSnapshotIpc'),
        importAudioIpcSrc,
        importSnapshotSrc
      ],
      [
        indexSrc.replace('import * as importJobsSnapshotIpc', 'import * as detachedSnapshotIpc'),
        importAudioIpcSrc,
        importSnapshotSrc
      ],
      [
        indexSrc,
        importAudioIpcSrc.replace('import * as importJobsSnapshotIpc', 'import type * as importJobsSnapshotIpc'),
        importSnapshotSrc
      ],
      [
        indexSrc,
        importAudioIpcSrc.replace('import * as importJobsSnapshotIpc', 'import * as detachedSnapshotIpc'),
        importSnapshotSrc
      ],
      [
        indexSrc,
        importAudioIpcSrc.replace(registrationText, `function unusedImportRegistration() { ${registrationText} }`),
        importSnapshotSrc
      ],
      [
        indexSrc,
        importAudioIpcSrc.replace(
          'importJobsSnapshotIpc.listImportJobsSnapshot(',
          'detachedSnapshotIpc.listImportJobsSnapshot('
        ),
        importSnapshotSrc
      ],
      [
        indexSrc,
        importAudioIpcSrc.replace('() => getImportJobs().snapshot()', '() => getImportJobs().list()'),
        importSnapshotSrc
      ],
      [indexSrc.replace('registerImportAudioIpc({', 'unusedImportAudioIpc({'), importAudioIpcSrc, importSnapshotSrc],
      [indexSrc, importAudioIpcSrc, importSnapshotSrc.replace('    requireAuth,', '    () => true,')],
      [indexSrc, importAudioIpcSrc, importSnapshotSrc.replace('jobs: snapshot.jobs.map(toView)', 'jobs: snapshot.jobs')]
    ])
      expect(() => requireImportSnapshotConnection(indexText, audioText, helperText)).toThrow()
    expect(listAndMutations).toMatch(/getImportJobs\(\)\.cancel\(parsed\.jobId\)/)
    expect(listAndMutations).toMatch(/getImportJobs\(\)\.resume\(parsed\.jobId\)/)
    expect(listAndMutations).toMatch(/getImportJobs\(\)\.remove\(parsed\.jobId\)/)
    expect(listAndMutations).not.toMatch(
      /if \(!importJobs\) throw new Error\('Audio import service is unavailable\.'\)/
    )
  })
})

describe('Q11 — account and credential hygiene in index.ts', () => {
  it('D9-1: pasting a non-empty Dust key takes the session off the OAuth refresh branch', () => {
    const body = sliceBetween('ipcMain.handle(IPC.setApiKey', 'ipcMain.handle(IPC.restoreEmbeddedCloudflareKey')
    expect(body).toMatch(/parsed\.provider === 'dust' && parsed\.key\.trim\(\)\)\s*retireDustOAuthSession\(\)/)
    expect(body.indexOf('setApiKey(parsed.provider, parsed.key)')).toBeLessThan(
      body.indexOf('retireDustOAuthSession()')
    )
    // refreshDustAuth only re-mints from OAuth while the origin says so: the branch the paste now leaves.
    const refresh = sliceBetween('function makeRefreshDustAuth', 'const fresh = await refreshDustCliSession()')
    expect(refresh).toMatch(/dustSessionOrigin === 'oauth'/)
  })

  it("D9-3: Disconnect removes the seeded dust-cli items, reading Métis's token before it is cleared", () => {
    // G20: the handler delegates to disconnectProvider (credential-clearers.ts), which the account-switch cleanup shares.
    const handler = sliceBetween('ipcMain.handle(IPC.clearApiKey', 'ipcMain.handle(IPC.testApiKey')
    expect(handler).toMatch(/disconnectProvider\(parsed\.provider\)/)
    const { text: clearers } = readModuleSource(__dirname, './credential-clearers')
    const body = clearers.slice(clearers.indexOf('export async function disconnectProvider'))
    const read = body.indexOf("getApiKey('dust')")
    expect(read).toBeGreaterThan(-1)
    expect(read).toBeLessThan(body.indexOf('clearApiKey(provider)'))
    expect(body).toMatch(/seededDustTokenForDisconnect\(getSettings\(\)\.dustSessionOrigin, getApiKey\('dust'\)\)/)
    expect(body).toMatch(/clearSeededDustCliSession\(/)
    expect(body).toMatch(/retireDustOAuthSession\(\)/)
  })

  it('D9-2: the answer-feedback handler passes the renderer askId through a bounded validator', () => {
    const body = sliceBetween('ipcMain.handle(IPC.answerFeedback', 'registerImportAudioIpc(')
    expect(body).toMatch(/boundedAnswerAskId\(r\?\.askId\)/)
    expect(body).toMatch(/recordOperatorRating\(getSettings\(\), rating, askId\)/)
  })
})
