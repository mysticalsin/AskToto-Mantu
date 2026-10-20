import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { registerDraftTranscriptIpc } from '../../src/main/ipc/draft-transcript-ipc'
import { parseRecapMarkdown } from '../../src/main/transcripts-recap'
import {
  SaveMeetingSchema,
  stripProvisionalLines,
  DEFAULT_SETTINGS,
  IPC,
  type SaveDraftTranscriptResult,
  TranscriptLineSchema as PublicTranscriptLineSchema
} from '../../src/shared/ipc'
import { TranscriptLineSchema } from '../../src/shared/transcript-line'

/**
 * Wave 0–6 / QA approval — source contracts that the rebuild's critical seams stay wired.
 * Physical CDP suite coverage for these is still expanding; these pins prevent silent regressions
 * of routingMode, consolidation, MCP confidential skip, SUMMARY→actionItems, and failover notice.
 */
const ROOT = join(__dirname, '..', '..')

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function parseTypeScript(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function liveNodes(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = []
  const isBoundary = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  const walk = (node: ts.Node, isRoot: boolean): void => {
    found.push(node)
    if (!isRoot && isBoundary(node)) return
    node.forEachChild((child) => walk(child, false))
  }
  walk(root, true)
  return found
}

function namedBindings(
  source: ts.SourceFile,
  moduleName: string,
  exportedName: string,
  localName = exportedName
): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName ||
      statement.importClause?.isTypeOnly
    )
      return false
    const bindings = statement.importClause?.namedBindings
    return (
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          (element.propertyName?.text ?? element.name.text) === exportedName &&
          element.name.text === localName
      )
    )
  })
}

function namedReExport(source: ts.SourceFile, moduleName: string, exportedName: string): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    )
      return false
    return (
      !!statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (element) => !element.isTypeOnly && !element.propertyName && element.name.text === exportedName
      )
    )
  })
}

function ipcHandler(source: ts.SourceFile, channel: string): ts.ArrowFunction {
  const registration = source.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'registerIpc'
  )
  expect(registration && ts.isFunctionDeclaration(registration) && registration.body, 'registerIpc body').toBeTruthy()
  if (!registration || !ts.isFunctionDeclaration(registration) || !registration.body)
    throw new Error('registerIpc function body is missing')
  const handlers = registration.body.statements.filter((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
    const call = statement.expression
    if (!ts.isPropertyAccessExpression(call.expression)) return false
    const channelExpression = call.arguments[0]
    return (
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === 'ipcMain' &&
      call.expression.name.text === 'handle' &&
      !!channelExpression &&
      ts.isPropertyAccessExpression(channelExpression) &&
      ts.isIdentifier(channelExpression.expression) &&
      channelExpression.expression.text === 'IPC' &&
      channelExpression.name.text === channel
    )
  })
  expect(handlers, `${channel} handler count`).toHaveLength(1)
  const callback = (handlers[0] as ts.ExpressionStatement).expression as ts.CallExpression
  const handler = callback.arguments[1]
  expect(handler && ts.isArrowFunction(handler), `${channel} handler callback`).toBe(true)
  return handler as ts.ArrowFunction
}

function callExpression(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
}

function shadowsName(handler: ts.ArrowFunction | ts.FunctionDeclaration, name: string): boolean {
  return liveNodes(handler).some((node) => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) return node.name.text === name
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text === name
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return node.name.text === name
    return false
  })
}

function parseInlineTypeScript(source: string): ts.SourceFile {
  return ts.createSourceFile('<inline>', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

const mainSource = parseTypeScript('src/main/index.ts')

function draftRegistrationConnected(source: ts.SourceFile): boolean {
  const imports = [
    ['./ipc/draft-transcript-ipc', 'registerDraftTranscriptIpc'],
    ['electron', 'ipcMain'],
    ['./auth', 'requireAuth'],
    ['./auth', 'captureAuthSessionBoundary'],
    ['./store', 'getSettings'],
    ['./settings-observation', 'captureDraftSettingsBoundary'],
    ['./transcripts', 'saveDraftTranscript'],
    ['./transcripts', 'preserveDraftTranscript'],
    ['./transcripts', 'discardDraftTranscript']
  ]
  if (!imports.every(([moduleName, name]) => namedBindings(source, moduleName, name))) return false
  const registration = source.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'registerIpc'
  )
  if (!registration || !ts.isFunctionDeclaration(registration) || !registration.body) return false
  const calls = registration.body.statements.flatMap((statement) =>
    ts.isExpressionStatement(statement) && callExpression(statement.expression, 'registerDraftTranscriptIpc')
      ? [statement.expression]
      : []
  )
  if (calls.length !== 1 || calls[0].arguments.length !== 1) return false
  const dependencies = calls[0].arguments[0]
  if (!ts.isObjectLiteralExpression(dependencies)) return false
  const expected = [
    'ipcMain',
    'assertMainWindow',
    'requireAuth',
    'captureAuthSessionBoundary',
    'getSettings',
    'captureDraftSettingsBoundary',
    'saveDraftTranscript',
    'preserveDraftTranscript',
    'discardDraftTranscript'
  ]
  return (
    dependencies.properties.length === expected.length &&
    expected.every(
      (name) =>
        !shadowsName(registration, name) &&
        dependencies.properties.filter(
          (property) =>
            ts.isShorthandPropertyAssignment(property) &&
            property.name.text === name &&
            !property.objectAssignmentInitializer
        ).length === 1
    )
  )
}

function directRecapReturns(handler: ts.ArrowFunction): ts.CallExpression[] {
  if (!ts.isBlock(handler.body)) return []
  return handler.body.statements.flatMap((statement) => {
    if (
      !ts.isReturnStatement(statement) ||
      !statement.expression ||
      !callExpression(statement.expression, 'parseRecapMarkdown')
    )
      return []
    return [statement.expression]
  })
}

function directStripAssignmentIndex(handler: ts.ArrowFunction): number {
  if (!ts.isBlock(handler.body)) return -1
  return handler.body.statements.findIndex((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false
    const assignment = statement.expression
    if (
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isPropertyAccessExpression(assignment.left) ||
      assignment.left.expression.getText() !== 'm' ||
      assignment.left.name.text !== 'lines' ||
      !callExpression(assignment.right, 'stripProvisionalLines')
    )
      return false
    const argument = assignment.right.arguments[0]
    return (
      !!argument &&
      ts.isPropertyAccessExpression(argument) &&
      argument.expression.getText() === 'm' &&
      argument.name.text === 'lines'
    )
  })
}

function isReceiptProperty(node: ts.Node, name: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'receipt' &&
    node.name.text === name
  )
}

function receiptAssignment(statement: ts.Statement, name: string): ts.Expression | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return undefined
  const assignment = statement.expression
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !isReceiptProperty(assignment.left, name))
    return undefined
  return assignment.right
}

// The handler's returned `transcriptSaveReceipts.run(key, owner, async (receipt) => { ... }).then((path) => ({ path }))`.
function receiptRun(handler: ts.ArrowFunction): { index: number; callback: ts.ArrowFunction } | undefined {
  if (!ts.isBlock(handler.body)) return undefined
  const statements = handler.body.statements
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index]
    if (!ts.isReturnStatement(statement) || !statement.expression) continue
    const thenCall = statement.expression
    if (
      !ts.isCallExpression(thenCall) ||
      !ts.isPropertyAccessExpression(thenCall.expression) ||
      thenCall.expression.name.text !== 'then' ||
      thenCall.arguments.length !== 1
    )
      continue
    const run = thenCall.expression.expression
    if (
      !ts.isCallExpression(run) ||
      !ts.isPropertyAccessExpression(run.expression) ||
      !ts.isIdentifier(run.expression.expression) ||
      run.expression.expression.text !== 'transcriptSaveReceipts' ||
      run.expression.name.text !== 'run' ||
      run.arguments.length !== 3
    )
      continue
    const callback = run.arguments[2]
    if (
      !ts.isArrowFunction(callback) ||
      !ts.isBlock(callback.body) ||
      !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      callback.parameters.length !== 1 ||
      !ts.isIdentifier(callback.parameters[0].name) ||
      callback.parameters[0].name.text !== 'receipt'
    )
      continue
    const mapper = thenCall.arguments[0]
    if (
      !ts.isArrowFunction(mapper) ||
      mapper.parameters.length !== 1 ||
      !ts.isIdentifier(mapper.parameters[0].name) ||
      mapper.parameters[0].name.text !== 'path' ||
      !ts.isParenthesizedExpression(mapper.body)
    )
      continue
    const result = mapper.body.expression
    if (
      !ts.isObjectLiteralExpression(result) ||
      result.properties.length !== 1 ||
      !ts.isShorthandPropertyAssignment(result.properties[0]) ||
      result.properties[0].name.text !== 'path'
    )
      continue
    return { index, callback }
  }
  return undefined
}

// The durable save is guarded by `receipt.durablePath === undefined`: it is skipped only when this exact receipt
// already saved. The receipt key fingerprints `m` after the provisional strip, so no unstripped payload bypasses it.
function directSaveDurableIndex(handler: ts.ArrowFunction): number {
  const flow = receiptRun(handler)
  if (!flow || !ts.isBlock(flow.callback.body)) return -1
  const statements = flow.callback.body.statements
  const settingsIdx = statements.findIndex((statement) => {
    if (
      !ts.isIfStatement(statement) ||
      statement.elseStatement ||
      !ts.isPrefixUnaryExpression(statement.expression) ||
      statement.expression.operator !== ts.SyntaxKind.ExclamationToken ||
      !isReceiptProperty(statement.expression.operand, 'settings')
    )
      return false
    const source = receiptAssignment(statement.thenStatement, 'settings')
    return !!source && callExpression(source, 'getSettings') && source.arguments.length === 0
  })
  const bindIdx = statements.findIndex(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'saveSettings' &&
          !!declaration.initializer &&
          isReceiptProperty(declaration.initializer, 'settings')
      )
  )
  const durableIdx = statements.findIndex((statement) => {
    if (
      !ts.isIfStatement(statement) ||
      statement.elseStatement ||
      !ts.isBinaryExpression(statement.expression) ||
      statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
      !isReceiptProperty(statement.expression.left, 'durablePath') ||
      !ts.isIdentifier(statement.expression.right) ||
      statement.expression.right.text !== 'undefined'
    )
      return false
    const saved = receiptAssignment(statement.thenStatement, 'durablePath')
    if (!saved || !ts.isAwaitExpression(saved)) return false
    const call = saved.expression
    return (
      callExpression(call, 'saveMeeting') &&
      call.arguments.length === 2 &&
      ts.isIdentifier(call.arguments[0]) &&
      call.arguments[0].text === 'saveSettings' &&
      ts.isIdentifier(call.arguments[1]) &&
      call.arguments[1].text === 'm'
    )
  })
  if (settingsIdx < 0 || bindIdx <= settingsIdx || durableIdx <= bindIdx) return -1
  return flow.index
}

function fixtureArrow(source: string): ts.ArrowFunction {
  const file = parseInlineTypeScript(source)
  return (file.statements[0] as ts.VariableStatement).declarationList.declarations[0].initializer as ts.ArrowFunction
}

function receiptFixtureSource(overrides: { start?: string; settings?: string; bind?: string; save?: string }): string {
  const parts = {
    start: 'return',
    settings: 'if (!receipt.settings) receipt.settings = getSettings()',
    bind: 'const saveSettings = receipt.settings',
    save: 'if (receipt.durablePath === undefined) receipt.durablePath = await saveMeeting(saveSettings, m)',
    ...overrides
  }
  return `
    const fixture = async () => {
      const m = SaveMeetingSchema.parse(raw)
      m.lines = stripProvisionalLines(m.lines)
      ${parts.start} transcriptSaveReceipts.run('key', undefined, async (receipt) => {
        ${parts.settings}
        ${parts.bind}
        ${parts.save}
        return receipt.durablePath
      }).then((path) => ({ path }))
    }
  `
}

function directDraftSaveCalls(handler: ts.ArrowFunction): ts.CallExpression[] {
  if (!ts.isBlock(handler.body)) return []
  return handler.body.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) && !ts.isReturnStatement(statement)) return []
    const expression = statement.expression
    if (!expression || !ts.isAwaitExpression(expression)) return []
    const call = expression.expression
    return callExpression(call, 'saveDraftTranscript') ? [call] : []
  })
}

describe('QA rebuild contracts — Wave 2 routing + failover notice', () => {
  it('exposes routingMode and lastFailover on PublicSettings; dismiss IPC exists', () => {
    const ipc = read('src/shared/ipc.ts')
    expect(ipc).toMatch(/routingMode: z\.enum\(\['local', 'api', 'auto'\]\)/)
    expect(ipc).toMatch(/lastFailover:/)
    expect(ipc).toMatch(/dismissFailoverNotice:/)
  })

  it('failover() records lastFailoverNotice and auditLog provider.failover', () => {
    const main = read('src/main/index.ts')
    expect(main).toMatch(/lastFailoverNotice = \{/)
    expect(main).toMatch(/auditLog\('provider\.failover'/)
    expect(main).toMatch(/IPC\.dismissFailoverNotice/)
  })

  it('App renders a dismissible failover chip', () => {
    const app = read('src/renderer/src/App.tsx')
    expect(app).toMatch(/settings\?\.lastFailover/)
    expect(app).toMatch(/dismissFailoverNotice/)
  })
})

describe('QA rebuild contracts — Wave 3 consolidation', () => {
  it('saveTranscript defers ingest when brainConsolidation.enabled', () => {
    const main = read('src/main/index.ts')
    // The deferral is now decided once per save receipt from the settings captured for that save.
    expect(main).toMatch(/receipt\.deferredIngest \?\?= saveSettings\.brainConsolidation\.enabled/)
    expect(main).toMatch(/\{ deferred: receipt\.deferredIngest \}/)
    expect(main).toMatch(/scheduleIntelligenceIndex|runIntelligenceIndex|runConsolidationIfDue/)
  })
})

describe('QA rebuild contracts — Wave 4 confidential MCP', () => {
  it('Review blocks CRM and task push when confidentialFlag is on', () => {
    const review = read('src/renderer/src/components/Review.tsx')
    expect(review).toMatch(/confidential\. CRM push is blocked/)
    expect(review).toMatch(/confidential\. Task push is blocked/)
    expect(review).toMatch(/!confidentialFlag/)
  })

  it('pushQueue skips confidential outbound actions', () => {
    const q = read('src/main/mcp/pushQueue.ts')
    expect(q).toMatch(/confidential/)
    expect(q).toMatch(/skipped_confidential|skip.*confidential/i)
  })
})

describe('QA rebuild contracts — Wave 1D SUMMARY headings', () => {
  it('rejects type-only or disconnected recap imports and exports', () => {
    for (const binding of [
      'type { parseRecapMarkdown }',
      '{ type parseRecapMarkdown }',
      '{ parseRecapMarkdown as unused }'
    ]) {
      const fixture = parseInlineTypeScript(`import ${binding} from './transcripts-recap'`)
      expect(namedBindings(fixture, './transcripts-recap', 'parseRecapMarkdown'), binding).toBe(false)
    }
    for (const binding of ['type { parseRecapMarkdown }', '{ type parseRecapMarkdown }', '{ unrelated }']) {
      const fixture = parseInlineTypeScript(`export ${binding} from './transcripts-recap'`)
      expect(namedReExport(fixture, './transcripts-recap', 'parseRecapMarkdown'), binding).toBe(false)
    }
  })

  it('parseRecapMarkdown aliases Next steps into actionItems', () => {
    const markdown =
      '## Next steps\n- Send the pricing plan by Friday (Alice)\n## Decisions\n- Use the revised pricing model'
    expect(parseRecapMarkdown(markdown)).toMatchObject({
      actionItems: [{ text: 'Send the pricing plan', owner: 'Alice', dueDateText: 'Friday' }],
      decisions: ['Use the revised pricing model'],
      markdown
    })

    const precedenceMarkdown =
      '## Action items\n- Use contracted pricing — Bob\n## Next steps\n- This later section must not win'
    expect(parseRecapMarkdown(precedenceMarkdown).actionItems).toEqual([
      { text: 'Use contracted pricing', owner: 'Bob', dueDateText: null }
    ])

    const transcripts = parseTypeScript('src/main/transcripts.ts')
    const main = mainSource
    expect(namedBindings(transcripts, './transcripts-recap', 'parseRecapMarkdown')).toBe(true)
    expect(namedReExport(transcripts, './transcripts-recap', 'parseRecapMarkdown')).toBe(true)
    expect(namedBindings(main, './transcripts', 'parseRecapMarkdown')).toBe(true)
    expect(namedBindings(main, 'electron', 'ipcMain')).toBe(true)
    expect(namedBindings(main, '@shared/ipc', 'IPC')).toBe(true)
    const recapHandler = ipcHandler(main, 'exportRecapJson')
    expect(shadowsName(recapHandler, 'parseRecapMarkdown')).toBe(false)
    const recapReturns = directRecapReturns(recapHandler)
    expect(recapReturns).toHaveLength(1)
    expect(recapReturns[0].arguments).toHaveLength(1)
    const recapInput = recapReturns[0].arguments[0]
    expect(ts.isConditionalExpression(recapInput)).toBe(true)
    if (!ts.isConditionalExpression(recapInput)) throw new Error('recap handler must pass its string-guarded input')
    expect(ts.isBinaryExpression(recapInput.condition)).toBe(true)
    if (!ts.isBinaryExpression(recapInput.condition)) throw new Error('recap input guard must be a comparison')
    expect(recapInput.condition.operatorToken.kind).toBe(ts.SyntaxKind.EqualsEqualsEqualsToken)
    expect(ts.isTypeOfExpression(recapInput.condition.left)).toBe(true)
    if (!ts.isTypeOfExpression(recapInput.condition.left)) throw new Error('recap input guard must check typeof')
    expect(ts.isIdentifier(recapInput.condition.left.expression)).toBe(true)
    if (!ts.isIdentifier(recapInput.condition.left.expression))
      throw new Error('recap input guard must inspect markdown')
    expect(recapInput.condition.left.expression.text).toBe('markdown')
    expect(ts.isStringLiteral(recapInput.condition.right) && recapInput.condition.right.text === 'string').toBe(true)
    expect(ts.isIdentifier(recapInput.whenTrue) && recapInput.whenTrue.text === 'markdown').toBe(true)
    expect(ts.isStringLiteral(recapInput.whenFalse) && recapInput.whenFalse.text === '').toBe(true)
    const disconnectedRecapSource = parseInlineTypeScript(`
      const disconnected = () => {
        const unused = () => parseRecapMarkdown('## Next steps')
        return null
      }
    `)
    const disconnectedRecap = (disconnectedRecapSource.statements[0] as ts.VariableStatement).declarationList
      .declarations[0].initializer as ts.ArrowFunction
    expect(directRecapReturns(disconnectedRecap)).toHaveLength(0)
  })

  it('SUMMARY_PROMPT uses ## Next steps / ## Decisions', () => {
    const prompts = read('src/shared/prompts.ts')
    expect(prompts).toMatch(/## Next steps:/)
    expect(prompts).toMatch(/## Decisions:/)
  })
})

function normalizeMutationSource(source: string): string {
  return source.replace(/\r\n/g, '\n')
}

describe('QA rebuild contracts — Wave 1 provisional strip', () => {
  it.each([
    '\n',
    '\r\n'
  ])('connects the consumed draft registration and refuses disconnected production dependencies with %j newlines', (newline) => {
    expect(draftRegistrationConnected(mainSource)).toBe(true)
    const source = normalizeMutationSource(mainSource.text.replace(/\r?\n/g, newline))
    expect(draftRegistrationConnected(parseInlineTypeScript(source))).toBe(true)
    const mutations = [
      ["'./ipc/draft-transcript-ipc'", "'./disconnected-draft-handler'"],
      ['  captureAuthSessionBoundary,', '  captureAuthSessionBoundary as disconnectedAuthBoundary,'],
      ['  registerDraftTranscriptIpc({', '  const unusedDraftRegistration = () => registerDraftTranscriptIpc({'],
      ['  registerDraftTranscriptIpc({', '  registerDraftTranscriptIpc({})\n  registerDraftTranscriptIpc({'],
      [
        '    captureDraftSettingsBoundary,\n    saveDraftTranscript',
        '    captureDraftSettingsBoundary: () => () => true,\n    saveDraftTranscript'
      ],
      ['    saveDraftTranscript,\n', '    saveDraftTranscript: saveMeeting,\n'],
      ['    discardDraftTranscript\n  })', '    discardDraftTranscript: preserveDraftTranscript\n  })'],
      ['  registerDraftTranscriptIpc({', '  const getSettings = () => ({})\n  registerDraftTranscriptIpc({']
    ]
    for (const [before, after] of mutations) {
      expect(source).toContain(before)
      expect(draftRegistrationConnected(parseInlineTypeScript(source.replace(before, after)))).toBe(false)
    }
  })

  it('executes the registered draft schema, sender/auth gates and provisional filtering with typed dependencies', async () => {
    type Dependencies = Parameters<typeof registerDraftTranscriptIpc>[0]
    let invoke!: (raw: unknown) => Promise<SaveDraftTranscriptResult>
    const sender = vi.fn<Dependencies['assertMainWindow']>()
    const requireAuth = vi.fn(() => true)
    const getSettings = vi.fn(() => DEFAULT_SETTINGS)
    const backend = vi.fn<Dependencies['saveDraftTranscript']>(async (_settings, _meeting, beforeReplace) => {
      beforeReplace?.()
      return { status: 'saved' }
    })
    const currentAuth = vi.fn(() => true)
    const currentSettings = vi.fn(() => true)
    registerDraftTranscriptIpc({
      ipcMain: {
        handle(channel, handler) {
          expect(channel).toBe(IPC.saveDraftTranscript)
          invoke = (raw) => Promise.resolve(handler({} as IpcMainInvokeEvent, raw))
        }
      },
      assertMainWindow: sender,
      requireAuth,
      getSettings,
      captureAuthSessionBoundary: () => currentAuth,
      captureDraftSettingsBoundary: () => currentSettings,
      saveDraftTranscript: backend
    })
    const final = { speaker: 'you' as const, text: 'Synthetic final', t: 1 }
    const payload = {
      startedAt: 1,
      title: 'Synthetic draft',
      lines: [final, { ...final, text: 'Synthetic interim', provisional: true }]
    }
    await expect(invoke(payload)).resolves.toEqual({ status: 'saved' })
    expect(backend).toHaveBeenCalledTimes(1)
    expect(backend.mock.calls[0][0]).toBe(DEFAULT_SETTINGS)
    expect(backend.mock.calls[0][1]).toEqual({ ...SaveMeetingSchema.parse(payload), lines: [final] })
    expect(currentAuth).toHaveBeenCalledTimes(1)
    expect(currentSettings).toHaveBeenCalledTimes(1)
    backend.mockClear()
    getSettings.mockClear()
    const senderFailure = new Error('Synthetic sender refusal')
    sender.mockImplementationOnce(() => {
      throw senderFailure
    })
    await expect(invoke(payload)).rejects.toBe(senderFailure)
    requireAuth.mockReturnValueOnce(false)
    await expect(invoke(payload)).resolves.toEqual({ status: 'failed' })
    await expect(invoke({ ...payload, lines: [{ ...final, provisional: 'true' }] })).resolves.toEqual({
      status: 'failed'
    })
    expect(backend).not.toHaveBeenCalled()
    expect(getSettings).not.toHaveBeenCalled()
  })

  it('stripProvisionalLines exists and save paths use it', () => {
    expect(PublicTranscriptLineSchema).toBe(TranscriptLineSchema)
    const base = { speaker: 'you' as const, text: 'saved line', t: 1 }
    expect(TranscriptLineSchema.safeParse(base).success).toBe(true)
    expect(TranscriptLineSchema.safeParse({ ...base, provisional: false }).success).toBe(true)
    expect(TranscriptLineSchema.safeParse({ ...base, provisional: true }).success).toBe(true)
    expect(TranscriptLineSchema.safeParse({ ...base, provisional: 'true' }).success).toBe(false)
    expect(SaveMeetingSchema.safeParse({ startedAt: 1, lines: [base] }).success).toBe(true)
    expect(SaveMeetingSchema.safeParse({ startedAt: 1, lines: [{ ...base, provisional: 'true' }] }).success).toBe(false)

    const provisionalLines = [
      { ...base },
      { ...base, text: 'interim', t: 2, provisional: true },
      { ...base, text: 'confirmed', t: 3, provisional: false }
    ]
    expect(stripProvisionalLines(provisionalLines)).toEqual([provisionalLines[0], provisionalLines[2]])
    const finalLines = [provisionalLines[0], provisionalLines[2]]
    expect(stripProvisionalLines(finalLines)).toBe(finalLines)

    const main = mainSource
    expect(namedBindings(main, '@shared/ipc', 'stripProvisionalLines')).toBe(true)
    expect(namedBindings(main, '@shared/ipc', 'SaveMeetingSchema')).toBe(true)
    expect(namedBindings(main, './transcripts', 'saveMeeting')).toBe(true)
    expect(namedBindings(main, './store', 'getSettings')).toBe(true)
    expect(namedBindings(main, 'electron', 'ipcMain')).toBe(true)
    expect(namedBindings(main, '@shared/ipc', 'IPC')).toBe(true)
    const saveHandler = ipcHandler(main, 'saveTranscript')
    const saveBody = saveHandler.body
    expect(ts.isBlock(saveBody)).toBe(true)
    if (!ts.isBlock(saveBody)) throw new Error('saveTranscript must have a block body')
    const saveStatements = [...saveBody.statements]
    const parsedMeeting = saveStatements.findIndex((statement) => {
      if (!ts.isVariableStatement(statement)) return false
      return statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'm' &&
          !!declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          ts.isPropertyAccessExpression(declaration.initializer.expression) &&
          ts.isIdentifier(declaration.initializer.expression.expression) &&
          declaration.initializer.expression.expression.text === 'SaveMeetingSchema' &&
          declaration.initializer.expression.name.text === 'parse'
      )
    })
    const stripAssignment = directStripAssignmentIndex(saveHandler)
    const saveDurable = directSaveDurableIndex(saveHandler)
    for (const importedName of ['SaveMeetingSchema', 'stripProvisionalLines', 'saveMeeting', 'getSettings'])
      expect(shadowsName(saveHandler, importedName), `save handler must not shadow ${importedName}`).toBe(false)
    expect(parsedMeeting).toBeGreaterThanOrEqual(0)
    expect(stripAssignment).toBeGreaterThan(parsedMeeting)
    expect(saveDurable).toBeGreaterThan(stripAssignment)

    const receiptFlow = receiptRun(saveHandler)
    expect(receiptFlow, 'saveTranscript must return the receipt flow').toBeDefined()
    if (!receiptFlow) throw new Error('saveTranscript must return the receipt flow')
    for (const name of ['SaveMeetingSchema', 'stripProvisionalLines', 'saveMeeting', 'getSettings', 'm'])
      expect(shadowsName(receiptFlow.callback, name), `receipt callback must not shadow ${name}`).toBe(false)
    const saveSettingsDeclarations = liveNodes(receiptFlow.callback).filter(
      (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'saveSettings'
    )
    expect(saveSettingsDeclarations, 'receipt callback declares saveSettings once').toHaveLength(1)
    const callbackReassignsMeeting = liveNodes(receiptFlow.callback).some(
      (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ['m', 'm.lines'].includes(node.left.getText())
    )
    expect(callbackReassignsMeeting, 'the receipt callback must not reassign the stripped meeting').toBe(false)
    for (const statement of saveStatements.slice(stripAssignment + 1, saveDurable)) {
      const reassigned = liveNodes(statement).some(
        (node) =>
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ['m', 'm.lines'].includes(node.left.getText())
      )
      expect(reassigned, 'nothing may reassign the stripped meeting before the durable save').toBe(false)
    }

    const disconnectedSaveSource = parseInlineTypeScript(`
      const disconnected = async () => {
        const m = SaveMeetingSchema.parse(raw)
        const unused = () => { m.lines = stripProvisionalLines(m.lines) }
        const r = { path: await saveMeeting(getSettings(), m) }
      }
    `)
    const disconnectedSave = (disconnectedSaveSource.statements[0] as ts.VariableStatement).declarationList
      .declarations[0].initializer as ts.ArrowFunction
    expect(directStripAssignmentIndex(disconnectedSave)).toBe(-1)

    expect(directSaveDurableIndex(fixtureArrow(receiptFixtureSource({})))).toBeGreaterThanOrEqual(0)
    const nestedSave =
      'const unused = async () => { receipt.durablePath = await saveMeeting(saveSettings, m) }'
    const disconnectedReceiptFixtures: Record<string, string> = {
      'save in a nested arrow': receiptFixtureSource({ save: nestedSave }),
      'wrong settings source': receiptFixtureSource({ settings: 'if (!receipt.settings) receipt.settings = {}' }),
      'binding after the save': receiptFixtureSource({
        bind: '',
        save:
          'if (receipt.durablePath === undefined) receipt.durablePath = await saveMeeting(saveSettings, m)\n' +
          '        const saveSettings = receipt.settings'
      }),
      'receipt run not returned': receiptFixtureSource({ start: 'void' }),
      'wrong meeting saved': receiptFixtureSource({
        save: 'if (receipt.durablePath === undefined) receipt.durablePath = await saveMeeting(saveSettings, raw)'
      })
    }
    for (const [label, source] of Object.entries(disconnectedReceiptFixtures))
      expect(directSaveDurableIndex(fixtureArrow(source)), label).toBe(-1)

    const returnedDraftSource = parseInlineTypeScript(`
      const returned = async () => {
        return await saveDraftTranscript(getSettings(), { ...parsed.data, lines: stripProvisionalLines(parsed.data.lines) })
      }
    `)
    const returnedDraft = (returnedDraftSource.statements[0] as ts.VariableStatement).declarationList.declarations[0]
      .initializer as ts.ArrowFunction
    expect(directDraftSaveCalls(returnedDraft)).toHaveLength(1)

    const disconnectedDraftSource = parseInlineTypeScript(`
      const disconnected = async () => {
        const unused = async () => await saveDraftTranscript(getSettings(), {})
        return null
      }
    `)
    const disconnectedDraft = (disconnectedDraftSource.statements[0] as ts.VariableStatement).declarationList
      .declarations[0].initializer as ts.ArrowFunction
    expect(directDraftSaveCalls(disconnectedDraft)).toHaveLength(0)
  })
})
