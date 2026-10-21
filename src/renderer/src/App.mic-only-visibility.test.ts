import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { CaptureDegraded as CaptureStateDegraded } from './lib/listen-capture-state'
import type { CaptureDegraded } from './lib/listen'
import { sourceIndexOf } from '../../../scripts/lib/source-layout'
import { readModuleSource } from '../../test-helpers/module-source'

// Normalize CRLF → LF (same rationale as App.capture-permission.test.ts): Windows checkouts would
// otherwise break any anchor whose newline sits mid-string.
const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')
const listenPath = join(__dirname, 'lib', 'listen.ts')
const listen = readFileSync(listenPath, 'utf8').replace(/\r\n/g, '\n')
// The recovery note literals moved out of listen.ts into listen-notes.ts (0a89199f); listen.ts imports them.
const listenNotesModule = readModuleSource(__dirname, './lib/listen-notes')
const listenNotesPath = listenNotesModule.path
const listenNotes = listenNotesModule.text.replace(/\r\n/g, '\n')
const bar = readFileSync(join(__dirname, 'components', 'Bar.tsx'), 'utf8').replace(/\r\n/g, '\n')
const pill = readFileSync(join(__dirname, 'components', 'ControlPill.tsx'), 'utf8').replace(/\r\n/g, '\n')
const settingsUi = readFileSync(join(__dirname, 'features', 'settings', 'AudioTab.tsx'), 'utf8').replace(/\r\n/g, '\n')

function descendants(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (child: ts.Node): void => {
    found.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function only<T>(values: T[], description: string): T {
  if (values.length !== 1) throw new Error(`Expected one ${description}, found ${values.length}`)
  return values[0]
}

function requireImportedCall(call: ts.CallExpression, source: ts.SourceFile, name: string): void {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== name) throw new Error(`Expected ${name} call`)
  const binds = (binding: ts.BindingName): boolean =>
    ts.isIdentifier(binding)
      ? binding.text === name
      : binding.elements.some((element) => !ts.isOmittedExpression(element) && binds(element.name))
  const declares = (node: ts.Node): boolean =>
    ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && binds(node.name)) ||
    ((ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isImportEqualsDeclaration(node)) &&
      node.name?.text === name)
  if (
    source.statements.some(
      (statement) =>
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((item) => binds(item.name))) ||
        ((ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement)) &&
          statement.name?.text === name)
    )
  )
    throw new Error(`Module-level ${name} shadows its import`)
  for (let scope: ts.Node | undefined = call.parent; scope && scope !== source; scope = scope.parent) {
    if (
      (ts.isFunctionDeclaration(scope) ||
        ts.isFunctionExpression(scope) ||
        ts.isArrowFunction(scope) ||
        ts.isMethodDeclaration(scope) ||
        ts.isConstructorDeclaration(scope) ||
        ts.isGetAccessorDeclaration(scope) ||
        ts.isSetAccessorDeclaration(scope)) &&
      (scope.parameters.some((parameter) => binds(parameter.name)) ||
        (scope.body && descendants(scope.body).some(declares)))
    )
      throw new Error(`Shadowed ${name} call`)
  }
}

function systemRecoverySuccessExpression(): { expression: ts.ArrowFunction; source: ts.SourceFile; message: string } {
  const source = ts.createSourceFile(listenPath, listen, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const sourceDiagnostics = ts.transpileModule(listen, { fileName: listenPath, reportDiagnostics: true }).diagnostics
  if (!sourceDiagnostics || sourceDiagnostics.length) throw new Error('Invalid listen syntax')
  const factoryBinding = only(
    descendants(source).filter(
      (node): node is ts.ImportSpecifier => ts.isImportSpecifier(node) && node.name.text === 'createListenAudioRecovery'
    ),
    'runtime recovery factory binding'
  )
  const factoryImport = factoryBinding.parent.parent.parent
  if (
    !ts.isImportDeclaration(factoryImport) ||
    factoryImport.moduleSpecifier.getText(source) !== "'./listen-audio-recovery'" ||
    factoryImport.importClause?.isTypeOnly ||
    factoryBinding.isTypeOnly ||
    (factoryBinding.propertyName?.text ?? factoryBinding.name.text) !== 'createListenAudioRecovery'
  )
    throw new Error('Expected runtime recovery factory import')
  const useListen = only(
    source.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'useListen' &&
        !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ),
    'exported useListen declaration'
  )
  const recovery = only(
    descendants(source).filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'audioRecovery' &&
        !!node.initializer
    ),
    'audioRecovery declaration'
  )
  if (!useListen.body || recovery.parent.parent.parent !== useListen.body)
    throw new Error('audioRecovery must bind directly in useListen')
  if (!ts.isCallExpression(recovery.initializer!) || recovery.initializer!.expression.getText(source) !== 'useMemo')
    throw new Error('Expected audioRecovery useMemo initializer')
  const memo = recovery.initializer!.arguments[0]
  if (!memo || !ts.isArrowFunction(memo) || ts.isBlock(memo.body)) throw new Error('Expected returned recovery factory')
  let returned: ts.Expression = memo.body
  while (ts.isParenthesizedExpression(returned)) returned = returned.expression
  if (!ts.isCallExpression(returned) || returned.expression.getText(source) !== 'createListenAudioRecovery')
    throw new Error('Expected useMemo to return the recovery factory')
  const factory = returned
  requireImportedCall(factory, source, 'createListenAudioRecovery')
  const hostFactory = factory.arguments[0]
  if (!hostFactory || !ts.isArrowFunction(hostFactory)) throw new Error('Expected recovery host factory')
  if (ts.isBlock(hostFactory.body)) throw new Error('Expected returned recovery host object')
  let hostBody: ts.Expression = hostFactory.body
  while (ts.isParenthesizedExpression(hostBody)) hostBody = hostBody.expression
  if (!ts.isObjectLiteralExpression(hostBody)) throw new Error('Expected returned recovery host object')
  const names = hostBody.properties.map((entry) => {
    if ((!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)) || !ts.isIdentifier(entry.name))
      throw new Error('Recovery host requires plain identifier properties')
    return entry.name.text
  })
  if (new Set(names).size !== names.length) throw new Error('Duplicate recovery host property')
  const callbacks = hostBody.properties.filter(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && entry.name.text === 'systemRecoverySucceeded'
  )
  const callback = only(callbacks, 'systemRecoverySucceeded host callback')
  if (!ts.isArrowFunction(callback.initializer) || !ts.isBlock(callback.initializer.body))
    throw new Error('Expected system recovery success arrow')
  const assignments = descendants(source).filter(
    (node): node is ts.BinaryExpression =>
      ts.isBinaryExpression(node) &&
      node.left.getText(source) === 'recoverSystemAudioRef.current' &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.right.getText(source) === 'audioRecovery.recoverSystemAudio'
  )
  const assignment = only(assignments, 'recovery method ref binding')
  if (assignment.parent.parent !== recovery.parent.parent.parent)
    throw new Error('Recovery ref must bind in the factory scope')
  const notesSource = ts.createSourceFile(listenNotesPath, listenNotes, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const notesImport = only(
    descendants(source).filter(
      (node): node is ts.ImportSpecifier => ts.isImportSpecifier(node) && node.name.text === 'THEM_LOST_MSG'
    ),
    'THEM_LOST_MSG import in listen'
  )
  const notesDeclaration = notesImport.parent.parent.parent
  if (
    !ts.isImportDeclaration(notesDeclaration) ||
    notesDeclaration.moduleSpecifier.getText(source) !== "'./listen-notes'" ||
    notesDeclaration.importClause?.isTypeOnly ||
    notesImport.isTypeOnly
  )
    throw new Error('Expected runtime THEM_LOST_MSG import from listen-notes')
  const messages = descendants(notesSource).filter(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'THEM_LOST_MSG'
  )
  const message = only(messages, 'THEM_LOST_MSG constant')
  if (!message.initializer || !ts.isStringLiteral(message.initializer))
    throw new Error('Expected original literal recovery note')
  return { expression: callback.initializer, source, message: message.initializer.text }
}

function runSystemRecoveryProjection(): void {
  const { expression, source, message } = systemRecoverySuccessExpression()
  const permission = 'System permission was granted after capture started.'
  const microphone = 'Microphone permission remains unavailable.'
  const unrelated = 'An unrelated capture error remains visible.'
  const rows = [
    { error: message, degraded: null, expectedError: null, expectedDegraded: null },
    {
      error: permission,
      degraded: { side: 'them' as const, note: permission, permission: true },
      expectedError: null,
      expectedDegraded: null
    },
    {
      error: unrelated,
      degraded: { side: 'them' as const, note: 'A different system note.', permission: false },
      expectedError: unrelated,
      expectedDegraded: null
    },
    {
      error: microphone,
      degraded: { side: 'you' as const, note: microphone, permission: true },
      expectedError: microphone,
      expectedDegraded: { side: 'you', note: microphone, permission: true }
    },
    { error: unrelated, degraded: null, expectedError: unrelated, expectedDegraded: null },
    {
      error: message,
      degraded: { side: 'you' as const, note: microphone, permission: false },
      expectedError: null,
      expectedDegraded: { side: 'you', note: microphone, permission: false }
    }
  ]
  for (const row of rows) {
    const original = { error: row.error, captureDegraded: row.degraded, untouched: { marker: 'preserved' } }
    const before = structuredClone(original)
    const untouched = original.untouched
    let projected: typeof original | undefined
    const themDegradedRef = { current: row.degraded }
    const emitted = ts.transpileModule(`(${expression.getText(source)})()`, {
      fileName: listenPath,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    })
    if (!emitted.diagnostics || emitted.diagnostics.length) throw new Error('Invalid recovery projection source')
    const code = emitted.outputText
    if (!code.trim()) throw new Error('TypeScript did not transpile the selected callback')
    const context = vm.createContext({
      THEM_LOST_MSG: message,
      themDegradedRef,
      setState: (update: (state: typeof original) => typeof original): void => {
        projected = update(original)
      }
    })
    vm.runInContext(code, context, { timeout: 1_000 })
    expect(projected?.error).toBe(row.expectedError)
    expect(projected?.captureDegraded).toEqual(row.expectedDegraded)
    if (row.degraded?.side === 'you') expect(projected?.captureDegraded).toBe(row.degraded)
    expect(projected?.untouched).toBe(untouched)
    expect(themDegradedRef.current).toBeNull()
    expect(original).toEqual(before)
  }
}

// Tony 2026-07-20: a whole meeting ran with Screen Recording off (15,521 capture.failed audit events).
// The mic-only soft note only rendered inside the Copilot body — invisible with the panel collapsed or
// the widget minimized — while the "Heard live" chip and the pill's red rec-dot claimed all was fine.
// These anchors pin the persistent-chrome visibility that fixed it.
describe('mic-only capture degradation stays visible', () => {
  it('useListen exposes a structured captureDegraded state, permission-classified for the them side', () => {
    expectTypeOf<CaptureDegraded>().toEqualTypeOf<CaptureStateDegraded>()
    expect(listen).toMatch(
      /export type \{ CaptureDegraded, CaptureHealth, CaptureSelectionOutcome \} from '\.\/listen-capture-state'/
    )
    expect(listen).toMatch(/captureDegraded: CaptureDegraded \| null/)
    // Set from the start()-time soft note, with the Screen-Recording cause carried as `permission`.
    expect(listen).toMatch(/const micCaptured = capturedTracks\.includes\('microphone'\)/)
    expect(listen).toMatch(/side: micCaptured \? 'them' : 'you', note, permission: micCaptured && isSysPermDenied/)
    // Reset on every fresh start and on final teardown — a stale flag must not leak across sessions.
    expect(listen).toMatch(
      /error: null,\s+captureDegraded: null,\s+captureHealth: null,\s+noSpeechWarning: false,[\s\S]*?listening: true,\s+capturing: false,\s+paused: false/
    )
    expect(listen).toMatch(
      /listening: false,\s+capturing: false,\s+paused: false,\s+loading: false,\s+error,\s+captureDegraded: null,\s+captureHealth: null/
    )
  })

  it('mid-session recovery of the them channel clears the start-time mic-only note (was left stuck)', () => {
    // Run the original host projection from the factory that the real recovery helper calls on success.
    runSystemRecoveryProjection()
  })

  it("the Bar's Heard-live chip flips to an honest amber Mic-only/No-mic state while degraded", () => {
    expect(bar).toMatch(/captureDegraded\?: CaptureDegraded \| null/)
    expect(bar).toMatch(/props\.captureDegraded\.side === 'them' \? 'Mic only' : 'No mic'/)
    // Degradation retains priority, but the tooltip starts with its note and appends safe mic and
    // recognizer facts; paused capture intentionally omits every live-status detail.
    const heardLiveChip = bar.slice(
      sourceIndexOf(bar, '/* "Heard live" chip'),
      sourceIndexOf(bar, 'className={[', sourceIndexOf(bar, '/* "Heard live" chip'))
    )
    expect(heardLiveChip).toMatch(
      /title=\{\s*!props\.paused\s*\?\s*\[\s*props\.captureDegraded\?\.note \?\? null,[\s\S]*?Live microphone: \$\{props\.captureHealth\.selectionOutcome\}[\s\S]*?Transcription: \$\{props\.recognizerStatus\.model[\s\S]*?\]\s*\.filter\(Boolean\)[\s\S]*?:\s*undefined\s*\}/
    )
    expect(bar).toMatch(
      /props\.captureDegraded \|\|\s*props\.noSpeechWarning \|\|\s*props\.captureHealth\?\.selectionOutcome === 'fallback-default'/
    )
    expect(app).toMatch(/captureDegraded=\{listen\.captureDegraded\}/)
  })

  it('the minimized circle keeps mood color; degraded truth rides the tooltip, not a red/amber paint', () => {
    expect(pill).toMatch(/degradedNote\?: string \| null/)
    expect(pill).toMatch(/const title = degradedNote \|\| 'Expand Métis'/)
    expect(pill).toMatch(/<ObsidianOrb/)
    expect(pill).toMatch(/title=\{title\}/)
    expect(pill).not.toMatch(/moodFromListen/)
    expect(app).toMatch(/degradedNote=\{listen\.captureDegraded\?\.note \?\? null\}/)
  })

  it('persists a mic-only stretch to Settings once per degraded stretch (asrLastFallbackAt contract)', () => {
    // Ref-guarded like webgpuNotifiedRef: a Dismiss in Settings mid-meeting must not be re-patched by the
    // same still-true state.
    expect(app).toMatch(/const micOnlyNotifiedRef = useRef\(false\)/)
    expect(app).toMatch(/listen\.captureDegraded\?\.side === 'them'/)
    expect(app).toMatch(/void patch\(\{ micOnlyFallbackAt: Date\.now\(\) \}\)/)
  })

  it('Settings → Audio surfaces the trace with a Screen Recording action and a Dismiss', () => {
    expect(settingsUi).toMatch(/settings\.micOnlyFallbackAt != null/)
    expect(settingsUi).toMatch(/captured your microphone only/)
    expect(settingsUi).toMatch(/openPermissionSettings\('screenRecording'\)/)
    expect(settingsUi).toMatch(/patch\(\{ micOnlyFallbackAt: null \}\)/)
  })
})
