import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { z } from 'zod'
import ts from 'typescript'
import { IPC } from '@shared/ipc'
import { UNAUTHENTICATED_RESULT } from '@shared/ipc-auth'
import { PUBLIC_IPC_HANDLERS } from './security'
import { registerHandler } from './register'

vi.mock('electron')

type Handler = Parameters<typeof ipcMain.handle>[1]
const event = {} as Electron.IpcMainInvokeEvent

function handlers(): Map<string, Handler> {
  const registered = new Map<string, Handler>()
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, fn: Handler) => {
    registered.set(channel, fn)
  })
  return registered
}

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path))
      continue
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.contract.test.ts')) continue
    files.push(path)
  }
  return files
}

function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const prop = node.properties.find((entry): entry is ts.PropertyAssignment =>
    ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && entry.name.text === name
  )
  return prop?.initializer
}

function ipcChannelFrom(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression) && expression.expression.getText() === 'IPC') {
    const value = IPC[expression.name.text as keyof typeof IPC]
    return typeof value === 'string' ? value : null
  }
  if (ts.isStringLiteral(expression)) return expression.text
  return null
}

function registeredPublicHandlers(): string[] {
  const publicHandlers = new Set<string>()
  for (const path of sourceFiles(join(__dirname, '..'))) {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'registerHandler') {
        const [first] = node.arguments
        if (first && ts.isObjectLiteralExpression(first)) {
          const auth = property(first, 'auth')
          const channel = property(first, 'channel')
          if (auth && ts.isStringLiteral(auth) && auth.text === 'public' && channel) {
            const resolved = ipcChannelFrom(channel)
            if (!resolved) throw new Error(`Could not resolve public IPC channel in ${path}: ${channel.getText(file)}`)
            publicHandlers.add(resolved)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return [...publicHandlers].sort()
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

    // @ts-expect-error M2-0249: omitting auth must not compile for new handlers.
    registerHandler({
      channel: IPC.writeupSpan,
      isAuthenticated: () => true,
      args: z.tuple([]),
      assertSender: () => undefined
    }, () => undefined)

    expect(ipcMain.handle).toHaveBeenCalledTimes(2)
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
    expect(() => registerHandler({
      channel: IPC.writeupSpan,
      auth: 'public',
      args: z.tuple([]),
      assertSender: () => undefined
    }, () => undefined)).toThrow(/allowlist/)
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

  it('lists every handler actually registered as public in the reviewed allowlist', () => {
    expect(registeredPublicHandlers()).toEqual([...PUBLIC_IPC_HANDLERS].sort())
  })
})
