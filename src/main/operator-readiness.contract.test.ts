import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n')

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

function requireOperatorPolicy(policyPath: string, policyText: string): void {
  const policy = ts.createSourceFile(policyPath, policyText, ts.ScriptTarget.Latest, true)
  const policyDiagnostics = ts.transpileModule(policyText, {
    fileName: policyPath,
    reportDiagnostics: true
  }).diagnostics
  if (!policyDiagnostics || policyDiagnostics.length) throw new Error('Invalid startup-policy syntax')
  const imports = descendants(policy).filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) && node.moduleSpecifier.getText(policy) === "'@shared/operator-entitlements'"
  )
  const operatorImport = only(imports, 'operator-entitlements import')
  if (!operatorImport.importClause?.namedBindings || !ts.isNamedImports(operatorImport.importClause.namedBindings))
    throw new Error('Expected named operatorGate import')
  expect(operatorImport.importClause.isTypeOnly).toBe(false)
  expect(
    operatorImport.importClause.namedBindings.elements.filter(
      (item) =>
        !item.isTypeOnly &&
        (item.propertyName?.text ?? item.name.text) === 'operatorGate' &&
        item.name.text === 'operatorGate'
    )
  ).toHaveLength(1)
  expect(
    descendants(policy).filter((node) => ts.isImportSpecifier(node) && node.name.text === 'operatorGate')
  ).toHaveLength(1)

  const gateNotice = only(
    descendants(policy).filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'listenOperatorGateNotice' &&
        !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ),
    'exported listenOperatorGateNotice declaration'
  )
  if (!gateNotice.body || gateNotice.parent !== policy) throw new Error('Expected top-level policy body')
  const body = gateNotice.body.statements
  expect(
    body.filter(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((item) => item.name.getText(policy) === 'snapshot')
    )
  ).toHaveLength(1)
  const gate = only(
    body.filter(
      (node): node is ts.VariableStatement =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((item) => item.name.getText(policy) === 'gate')
    ),
    'gate binding'
  ).declarationList.declarations[0]
  expect(gate.name.getText(policy)).toBe('gate')
  if (!gate.initializer || !ts.isCallExpression(gate.initializer)) throw new Error('Expected actual operatorGate call')
  const call = gate.initializer
  requireImportedCall(call, policy, 'operatorGate')
  expect(call.expression.getText(policy)).toBe('operatorGate')
  expect(call.arguments.map((arg) => arg.getText(policy))).toEqual([
    "'listen'",
    'settings.operatorConfigured === true',
    'snapshot'
  ])
  const result = only(
    body.filter((node): node is ts.ReturnStatement => ts.isReturnStatement(node)),
    'policy result return'
  )
  expect(result.expression?.getText(policy)).toBe("gate.allowed ? null : gate.reason || 'Listen is not available.'")
}

function requireAppGateBeforeCapture(appPath: string, appText: string): void {
  const app = ts.createSourceFile(appPath, appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const appDiagnostics = ts.transpileModule(appText, {
    fileName: appPath,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX }
  }).diagnostics
  if (!appDiagnostics || appDiagnostics.length) throw new Error('Invalid App syntax')
  const appNodes = descendants(app)
  const imports = appNodes.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) && node.moduleSpecifier.getText(app) === "'./lib/listen-startup-policy'"
  )
  const declaration = only(imports, 'startup-policy import')
  const bindings = declaration.importClause?.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) throw new Error('Expected named startup-policy imports')
  expect(declaration.importClause?.isTypeOnly).toBe(false)
  expect(
    bindings.elements.filter(
      (item) =>
        !item.isTypeOnly &&
        (item.propertyName?.text ?? item.name.text) === 'listenOperatorGateNotice' &&
        item.name.text === 'listenOperatorGateNotice'
    )
  ).toHaveLength(1)
  expect(
    appNodes.filter((node) => ts.isImportSpecifier(node) && node.name.text === 'listenOperatorGateNotice')
  ).toHaveLength(1)

  const appFunction = only(
    app.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'App' &&
        !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ),
    'exported App declaration'
  )

  const start = only(
    appNodes.filter(
      (node) => ts.isVariableDeclaration(node) && node.name.getText(app) === 'startListen' && !!node.initializer
    ),
    'startListen declaration'
  ) as ts.VariableDeclaration
  if (!appFunction.body || start.parent.parent.parent !== appFunction.body)
    throw new Error('startListen must bind directly in App')
  if (!ts.isCallExpression(start.initializer!) || start.initializer!.expression.getText(app) !== 'useCallback')
    throw new Error('Expected startListen useCallback initializer')
  const callback = start.initializer!.arguments[0]
  if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body))
    throw new Error('Expected startListen callback body')
  const nodes = descendants(callback.body)
  const refusal = only(
    nodes.filter((node) => ts.isVariableDeclaration(node) && node.name.getText(app) === 'refusal'),
    'refusal binding'
  ) as ts.VariableDeclaration
  if (refusal.parent.parent.parent !== callback.body) throw new Error('Refusal must be a direct callback statement')
  if (!refusal.initializer || !ts.isCallExpression(refusal.initializer)) throw new Error('Expected gate helper call')
  requireImportedCall(refusal.initializer, app, 'listenOperatorGateNotice')
  expect(refusal.initializer.expression.getText(app)).toBe('listenOperatorGateNotice')
  expect(refusal.initializer.arguments.map((arg) => arg.getText(app))).toEqual(['settings ?? {}'])
  const gateBranch = only(
    nodes.filter(
      (node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(app) === 'refusal'
    ),
    'refusal branch'
  )
  if (gateBranch.parent !== callback.body) throw new Error('Gate branch must be a direct callback statement')
  if (!ts.isBlock(gateBranch.thenStatement)) throw new Error('Expected refusal block')
  const branchStatements = gateBranch.thenStatement.statements
  expect(branchStatements).toHaveLength(2)
  const setter = branchStatements[0]
  if (!ts.isExpressionStatement(setter) || !ts.isCallExpression(setter.expression))
    throw new Error('Expected refusal notice setter')
  expect(setter.expression.expression.getText(app)).toBe('setOperatorGateNotice')
  expect(setter.expression.arguments.map((arg) => arg.getText(app))).toEqual(['refusal'])
  expect(ts.isReturnStatement(branchStatements[1]) && !branchStatements[1].expression).toBe(true)
  const startCall = only(
    nodes.filter((node) => ts.isCallExpression(node) && node.expression.getText(app) === 'listen.start'),
    'listen.start boundary'
  ) as ts.CallExpression
  for (let parent = startCall.parent; parent && parent !== callback.body; parent = parent.parent)
    if (ts.isArrowFunction(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent))
      throw new Error('Disconnected nested capture call')
  const statementFor = (node: ts.Node): ts.Node => {
    let current = node
    while (current.parent && current.parent !== callback.body) current = current.parent
    return current
  }
  const refusalIndex = callback.body.statements.indexOf(statementFor(refusal) as ts.Statement)
  const branchIndex = callback.body.statements.indexOf(statementFor(gateBranch) as ts.Statement)
  expect(refusalIndex).toBeGreaterThanOrEqual(0)
  expect(branchIndex).toBe(refusalIndex + 1)
  const captureIndex = callback.body.statements.findIndex((statement) => descendants(statement).includes(startCall))
  expect(captureIndex).toBeGreaterThan(branchIndex)
}

describe('MQA-294 licence readiness and credential boundaries', () => {
  it('publishes only credential-presence flags and gates Listen with that flag', () => {
    const main = source('main/index.ts')
    expect(main).toContain('operatorConfigured: operatorUrlConfigured(s) && !!resolveOperatorCredential(s)')
    expect(main).toContain("operatorLicenseToken: ''")
    expect(main).toContain("operatorIngestSecret: ''")
    const appPath = 'renderer/src/App.tsx'
    const app = source(appPath)
    expect(app).not.toContain('settings?.operatorIngestSecret')
    const policyPath = 'renderer/src/lib/listen-startup-policy.ts'
    const policy = source(policyPath)
    requireOperatorPolicy(policyPath, policy)
    requireAppGateBeforeCapture(appPath, app)
  })

  it('refreshes readiness from main events and after licence activation without refocusing', () => {
    expect(source('preload/index.ts')).toContain('sub(IPC.settingsChanged, cb)')
    expect(source('renderer/src/state.ts')).toContain('window.toto.onSettingsChanged(onFocus)')
    expect(source('main/index.ts')).toContain('onReadinessChanged: notifySettingsChanged')
    const settingsSources = [
      source('renderer/src/features/settings/SettingsRoot.tsx'),
      source('renderer/src/features/settings/OperatorLicenseCard.tsx')
    ].join('\n')
    expect(settingsSources).toContain('await refreshSettings()')
  })

  it('rejects an activation if its verified endpoint changed during the request', () => {
    expect(source('main/index.ts')).toContain(
      'resolveOperatorBaseUrl(candidate) !== resolveOperatorBaseUrl(getSettings())'
    )
  })

  it('MQA-295 clears saved credentials before a renderer-requested endpoint change', () => {
    const main = source('main/index.ts')
    const guard = main.slice(
      main.indexOf("if ('operatorUrl' in p && resolveOperatorBaseUrl"),
      main.indexOf('const next = setSettingsWithSpeakerPolicy(p)')
    )
    expect(guard.includes("operatorLicenseToken: ''")).toBe(true)
    expect(guard.includes("operatorIngestSecret: ''")).toBe(true)
  })

  it('does not bind a masked legacy credential input to persisted settings', () => {
    const settings = source('renderer/src/features/settings/SettingsRoot.tsx')
    expect(settings).not.toContain("value={settings.operatorIngestSecret || ''}")
    expect(settings).not.toContain('onChange={(e) => patch({ operatorIngestSecret: e.target.value })}')
    expect(settings).not.toContain('Heartbeat still needs the ingest secret')
  })
})
