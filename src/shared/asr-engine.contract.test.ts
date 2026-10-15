import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, IPC, SettingsSchema } from './ipc'
import { preferredFreshAsrEngine } from './asr-hardware-preference'

const root = process.cwd()
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

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

function exported(node: ts.FunctionDeclaration): boolean {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

function findAppEngineBinding(appPath: string, appText: string, policyPath: string, policyText: string): void {
  const policy = ts.createSourceFile(policyPath, policyText, ts.ScriptTarget.Latest, true)
  const policyDiagnostics = ts.transpileModule(policyText, {
    fileName: policyPath,
    reportDiagnostics: true
  }).diagnostics
  if (!policyDiagnostics || policyDiagnostics.length) throw new Error('Invalid startup-policy syntax')
  const resolver = only(
    descendants(policy).filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'resolveListenEngine' && exported(node)
    ),
    'exported resolveListenEngine declaration'
  )
  if (!resolver.body) throw new Error('Expected resolver body')
  const result = only(
    resolver.body.statements.filter((statement): statement is ts.ReturnStatement => ts.isReturnStatement(statement)),
    'resolver return'
  )
  if (!result.expression || !ts.isConditionalExpression(result.expression)) throw new Error('Expected cloud decision')
  let fallback: ts.Expression = result.expression.whenFalse
  while (ts.isParenthesizedExpression(fallback)) fallback = fallback.expression
  expect(fallback.getText(policy)).toBe("settings?.asrEngine ?? 'parakeet'")

  const app = ts.createSourceFile(appPath, appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const appDiagnostics = ts.transpileModule(appText, {
    fileName: appPath,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX }
  }).diagnostics
  if (!appDiagnostics || appDiagnostics.length) throw new Error('Invalid App syntax')
  const imported = descendants(app).filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) && node.moduleSpecifier.getText(app) === "'./lib/listen-startup-policy'"
  )
  const declaration = only(imported, 'startup-policy import')
  const clause = declaration.importClause?.namedBindings
  if (!clause || !ts.isNamedImports(clause)) throw new Error('Expected named startup-policy imports')
  expect(declaration.importClause?.isTypeOnly).toBe(false)
  expect(
    clause.elements.filter(
      (element) =>
        !element.isTypeOnly &&
        (element.propertyName?.text ?? element.name.text) === 'resolveListenEngine' &&
        element.name.text === 'resolveListenEngine'
    )
  ).toHaveLength(1)
  expect(
    descendants(app).filter((node) => ts.isImportSpecifier(node) && node.name.text === 'resolveListenEngine')
  ).toHaveLength(1)

  const appFunction = only(
    app.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'App' && exported(node)
    ),
    'exported App declaration'
  )

  const start = only(
    descendants(app).filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'startListen' &&
        !!node.initializer
    ),
    'startListen declaration'
  )
  if (!appFunction.body || start.parent.parent.parent !== appFunction.body)
    throw new Error('startListen must bind directly in App')
  if (!ts.isCallExpression(start.initializer!) || start.initializer!.expression.getText(app) !== 'useCallback')
    throw new Error('Expected startListen useCallback initializer')
  const callback = start.initializer!.arguments[0]
  if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body))
    throw new Error('Expected the startListen callback body')
  const body = descendants(callback.body)
  const engines = body.filter(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'engine'
  )
  const engine = only(engines, 'startListen engine binding')
  if (!engine.initializer || !ts.isCallExpression(engine.initializer)) throw new Error('Expected engine helper call')
  requireImportedCall(engine.initializer, app, 'resolveListenEngine')
  expect(engine.initializer.expression.getText(app)).toBe('resolveListenEngine')
  expect(engine.initializer.arguments.map((arg) => arg.getText(app))).toEqual(['settings'])
  const starts = body.filter(
    (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(app) === 'listen.start'
  )
  const listenStart = only(starts, 'listen.start call')
  expect(listenStart.arguments[2]?.getText(app)).toBe(engine.name.getText(app))
  const engineStatement = engine.parent.parent
  const listenStatement = listenStart.parent.parent
  if (
    !ts.isVariableStatement(engineStatement) ||
    !ts.isExpressionStatement(listenStatement) ||
    engineStatement.parent !== listenStatement.parent ||
    !ts.isBlock(engineStatement.parent)
  )
    throw new Error('Engine and capture must share a lexical block')
  const statements = engineStatement.parent.statements
  expect(statements.indexOf(engineStatement)).toBeGreaterThanOrEqual(0)
  expect(statements.indexOf(engineStatement)).toBeLessThan(statements.indexOf(listenStatement))
}

describe('ASR engine fallback and fresh-setup contracts', () => {
  it('schema + DEFAULT_SETTINGS + listen/App fallbacks all default asrEngine to parakeet', () => {
    expect(DEFAULT_SETTINGS.asrEngine).toBe('parakeet')
    const { asrEngine: _omit, ...rest } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(rest).asrEngine).toBe('parakeet')
    const appPath = 'src/renderer/src/App.tsx'
    const app = read(appPath)
    expect(app).toContain("import { listenOperatorGateNotice, resolveListenEngine } from './lib/listen-startup-policy'")
    const listenPath = 'src/renderer/src/lib/listen.ts'
    const listen = read(listenPath)
    expect(listen).toMatch(/useRef<'whisper' \| 'parakeet' \| 'apple' \| 'cloud'>\('parakeet'\)/)
    expect(listen).toMatch(/engine: 'whisper' \| 'parakeet' \| 'apple' \| 'cloud' = 'parakeet'/)
    const policyPath = 'src/renderer/src/lib/listen-startup-policy.ts'
    findAppEngineBinding(appPath, app, policyPath, read(policyPath))
  })

  it('onboarding provisions ASR and exposes a safe recovery for a damaged immutable bundle', () => {
    const onboard = read('src/renderer/src/components/OnboardingExperience.tsx')
    expect(onboard).toMatch(/asrAssetsEnsure/)
    expect(onboard).toMatch(/asrAssetsStatus/)
    expect(onboard).toMatch(/setupAsrBlocksContinue/)
    expect(onboard).toMatch(/firstRunCanFinish/)
    expect(onboard).toMatch(/asrAssetsEnsure\(\)/)
    expect(onboard).not.toMatch(/models missing in this build/)
    expect(onboard).toMatch(/asrRowNeedsRepair/)
    expect(onboard).toMatch(/Reinstall Métis with the official installer, then reopen it\./)
    expect(read('src/preload/index.ts')).toMatch(/asrAssetsStatus/)
    expect(IPC.asrAssetsEnsure).toBe('asr:assets-ensure')
  })

  it('accepts RAM-specific fresh choices without changing the conservative legacy fallback', () => {
    const { asrEngine: _omit, ...legacy } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(legacy).asrEngine).toBe('parakeet')
    expect(SettingsSchema.parse({ ...legacy, asrEngine: preferredFreshAsrEngine(8 * 1024 ** 3) }).asrEngine).toBe(
      'parakeet'
    )
    expect(SettingsSchema.parse({ ...legacy, asrEngine: preferredFreshAsrEngine(16 * 1024 ** 3) }).asrEngine).toBe(
      'whisper'
    )
    // Settings.speech-models.test.tsx renders the real Speech UI and checks both device classes.
  })
})
