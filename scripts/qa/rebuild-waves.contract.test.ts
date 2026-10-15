import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseRecapMarkdown } from '../../src/main/transcripts-recap'
import {
  SaveMeetingSchema,
  stripProvisionalLines,
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
      statement.moduleSpecifier.text !== moduleName
    )
      return false
    const bindings = statement.importClause?.namedBindings
    return (
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          (element.propertyName?.text ?? element.name.text) === exportedName && element.name.text === localName
      )
    )
  })
}

function namedReExport(source: ts.SourceFile, moduleName: string, exportedName: string): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    )
      return false
    return (
      !!statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) => !element.propertyName && element.name.text === exportedName)
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

function shadowsName(handler: ts.ArrowFunction, name: string): boolean {
  return liveNodes(handler).some((node) => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) return node.name.text === name
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text === name
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return node.name.text === name
    return false
  })
}

function parseInlineTypeScript(source: string): ts.SourceFile {
  return ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
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

function directSaveDurableIndex(handler: ts.ArrowFunction): number {
  if (!ts.isBlock(handler.body)) return -1
  return handler.body.statements.findIndex((statement) => {
    if (!ts.isVariableStatement(statement)) return false
    return statement.declarationList.declarations.some((declaration) => {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== 'r' ||
        !declaration.initializer ||
        !ts.isObjectLiteralExpression(declaration.initializer)
      )
        return false
      return declaration.initializer.properties.some((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          property.name.getText() !== 'path' ||
          !ts.isAwaitExpression(property.initializer)
        )
          return false
        const call = property.initializer.expression
        if (!callExpression(call, 'saveMeeting') || call.arguments.length !== 2) return false
        return (
          callExpression(call.arguments[0], 'getSettings') &&
          ts.isIdentifier(call.arguments[1]) &&
          call.arguments[1].text === 'm'
        )
      })
    })
  })
}

function directDraftSaveCalls(handler: ts.ArrowFunction): ts.CallExpression[] {
  if (!ts.isBlock(handler.body)) return []
  return handler.body.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return []
    const call = statement.expression.expression
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
    expect(main).toMatch(/deferred:\s*getSettings\(\)\.brainConsolidation\.enabled/)
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
    const recapModule = parseTypeScript('src/main/transcripts-recap.ts')
    const main = parseTypeScript('src/main/index.ts')
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
    expect(
      recapModule.statements.filter(
        (statement) =>
          ts.isFunctionDeclaration(statement) &&
          statement.name?.text === 'parseRecapMarkdown' &&
          ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
    ).toHaveLength(1)

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

describe('QA rebuild contracts — Wave 1 provisional strip', () => {
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

    const main = parseTypeScript('src/main/index.ts')
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

    const draftHandler = ipcHandler(main, 'saveDraftTranscript')
    const draftBody = draftHandler.body
    expect(ts.isBlock(draftBody)).toBe(true)
    if (!ts.isBlock(draftBody)) throw new Error('saveDraftTranscript must have a block body')
    const draftCalls = directDraftSaveCalls(draftHandler)
    expect(draftCalls).toHaveLength(1)
    const draftCall = draftCalls[0]
    expect(draftCall.arguments).toHaveLength(2)
    expect(callExpression(draftCall.arguments[0], 'getSettings')).toBe(true)
    expect(ts.isObjectLiteralExpression(draftCall.arguments[1])).toBe(true)
    if (!ts.isObjectLiteralExpression(draftCall.arguments[1]))
      throw new Error('draft save value must be an object literal')
    const parsedDraft = draftBody.statements.find((statement) => {
      if (!ts.isVariableStatement(statement)) return false
      return statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'parsed' &&
          !!declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          ts.isPropertyAccessExpression(declaration.initializer.expression) &&
          ts.isIdentifier(declaration.initializer.expression.expression) &&
          declaration.initializer.expression.expression.text === 'SaveMeetingSchema' &&
          declaration.initializer.expression.name.text === 'safeParse'
      )
    })
    expect(parsedDraft).toBeDefined()
    for (const importedName of ['SaveMeetingSchema', 'stripProvisionalLines', 'saveDraftTranscript', 'getSettings'])
      expect(shadowsName(draftHandler, importedName), `draft handler must not shadow ${importedName}`).toBe(false)
    const spreadParsed = draftCall.arguments[1].properties.some(
      (property) => ts.isSpreadAssignment(property) && property.expression.getText() === 'parsed.data'
    )
    const strippedDraftLines = draftCall.arguments[1].properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === 'lines' &&
        callExpression(property.initializer, 'stripProvisionalLines') &&
        property.initializer.arguments.length === 1 &&
        property.initializer.arguments[0].getText() === 'parsed.data.lines'
    )
    expect(spreadParsed).toBe(true)
    expect(strippedDraftLines).toBe(true)

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
