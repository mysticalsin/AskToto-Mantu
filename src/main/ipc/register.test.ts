import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import * as ts from 'typescript'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import { UNAUTHENTICATED_RESULT } from '@shared/ipc-auth'
import { PUBLIC_IPC_HANDLERS } from './security'
import { registerHandler } from './register'

vi.mock('electron')
type Handler = Parameters<typeof ipcMain.handle>[1]
const event = {} as Electron.IpcMainInvokeEvent
const srcMainRoot = join(process.cwd(), 'src', 'main')

function handlers(): Map<string, Handler> {
  const registered = new Map<string, Handler>()
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, fn: Handler) => {
    registered.set(channel, fn)
  })
  return registered
}

function productionMainFiles(dir = srcMainRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionMainFiles(path)
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return []
    if (
      entry.name.endsWith('.d.ts') ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.contract.ts') ||
      entry.name.endsWith('.contract.test.ts')
    ) return []
    return [path]
  })
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.find((property): property is ts.PropertyAssignment => {
    if (!ts.isPropertyAssignment(property)) return false
    const propertyName = property.name
    return ts.isIdentifier(propertyName)
      ? propertyName.text === name
      : ts.isStringLiteral(propertyName) && propertyName.text === name
  })
}

function ipcChannelValue(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression)) return expression.text
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== 'IPC'
  ) return undefined
  const channel = IPC[expression.name.text as keyof typeof IPC]
  return typeof channel === 'string' ? channel : undefined
}

function importedRegisterHandlerNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  sourceFile.statements.forEach((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return
    if (!statement.moduleSpecifier.text.endsWith('/register') && statement.moduleSpecifier.text !== './register') return
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return
    bindings.elements.forEach((element) => {
      if ((element.propertyName ?? element.name).text === 'registerHandler') names.add(element.name.text)
    })
  })
  return names
}

function publicRegisterHandlerChannels(): Set<string> {
  const publicChannels = new Set<string>()
  for (const file of productionMainFiles()) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const registerHandlerNames = importedRegisterHandlerNames(sourceFile)
    if (registerHandlerNames.size === 0) continue

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        registerHandlerNames.has(node.expression.text)
      ) {
        const [options] = node.arguments
        if (options && ts.isObjectLiteralExpression(options)) {
          const auth = objectProperty(options, 'auth')?.initializer
          const channel = objectProperty(options, 'channel')?.initializer
          if (auth && ts.isStringLiteral(auth) && auth.text === 'public' && channel) {
            const value = ipcChannelValue(channel)
            const line = sourceFile.getLineAndCharacterOfPosition(channel.getStart()).line + 1
            publicChannels.add(value ?? `UNRESOLVED:${file}:${line}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return publicChannels
}

describe('M2-0249 registerHandler authentication policy', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset()
  })

  it('requires every registration to declare required or public authentication', () => {
    registerHandler({
      channel: IPC.writeupSpan,
      auth: 'required',
      isAuthenticated: () => true,
      args: z.tuple([z.string()]),
      assertSender: () => undefined
    }, (_event, value) => value.toUpperCase())

    function compileOnly(): void {
      // @ts-expect-error M2-0249: omitting auth must not compile for new handlers.
      registerHandler({
        channel: IPC.writeupSpan,
        isAuthenticated: () => true,
        args: z.tuple([]),
        assertSender: () => undefined
      }, () => undefined)
    }
    void compileOnly

    expect(ipcMain.handle).toHaveBeenCalledTimes(1)
  })

  it('returns the one typed unauthenticated result before the handler body runs', async () => {
    const registered = handlers()
    const body = vi.fn(() => ({ ok: true }))
    const assertSender = vi.fn()

    registerHandler({
      channel: IPC.writeupSpan,
      auth: 'required',
      isAuthenticated: () => false,
      args: z.tuple([z.object({ span: z.string() })]),
      assertSender
    }, body)

    await expect(registered.get(IPC.writeupSpan)!(event, { span: 'stop_to_recap_done' })).resolves.toEqual(UNAUTHENTICATED_RESULT)
    expect(assertSender).toHaveBeenCalledTimes(1)
    expect(body).not.toHaveBeenCalled()
  })

  it('validates arguments before auth so malformed payloads never reach a required handler', async () => {
    const registered = handlers()
    const isAuthenticated = vi.fn(() => true)
    const body = vi.fn()

    registerHandler({
      channel: IPC.writeupSpan,
      auth: 'required',
      isAuthenticated,
      args: z.tuple([z.object({ value: z.string() })]),
      assertSender: () => undefined
    }, body)

    await expect(registered.get(IPC.writeupSpan)!(event, { value: 1 })).rejects.toThrow()
    expect(isAuthenticated).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('refuses a public handler that has not been reviewed into the allowlist', () => {
    function compileOnly(): void {
      // @ts-expect-error M2-0249: public handlers must first be reviewed into PUBLIC_IPC_HANDLERS.
      registerHandler({
        channel: IPC.writeupSpan,
        auth: 'public',
        args: z.tuple([]),
        assertSender: () => undefined
      }, () => undefined)
    }
    void compileOnly

    expect(() => registerHandler({
      channel: IPC.writeupSpan,
      auth: 'public',
      args: z.tuple([]),
      assertSender: () => undefined
    } as never, () => undefined)).toThrow(/allowlist/)
  })

  it('fails closed when JavaScript or a cast passes an unknown auth policy', () => {
    expect(() => registerHandler({
      channel: IPC.localAppleEngineStatus,
      auth: 'unknown',
      args: z.tuple([]),
      assertSender: () => undefined
    } as never, () => undefined)).toThrow(/Unknown IPC auth policy/)
    expect(ipcMain.handle).not.toHaveBeenCalled()
  })

  it('keeps the reviewed public handler list explicit', () => {
    expect(PUBLIC_IPC_HANDLERS).toEqual([
      IPC.localAppleEngineStatus,
      IPC.permissionsOpenSettings,
      IPC.permissionsRepairScreen,
      IPC.permissionsAttestScreen,
      IPC.permissionsRevealCopy
    ])
  })

  it('lists every production public handler in the reviewed allowlist', () => {
    expect(publicRegisterHandlerChannels()).toEqual(new Set(PUBLIC_IPC_HANDLERS))
  })
})
