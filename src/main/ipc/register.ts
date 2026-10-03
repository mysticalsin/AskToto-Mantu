import { ipcMain } from 'electron'
import { UNAUTHENTICATED_RESULT, type UnauthenticatedResult } from '@shared/ipc-auth'
import type { z } from 'zod'
import { assertReviewedPublicHandler, type IpcChannel, type ReviewedPublicIpcChannel } from './security'

type InvokeEvent = Electron.IpcMainInvokeEvent
type AssertSender = (event: InvokeEvent) => void
type RequireAuth = () => boolean
type AnyArgsSchema = z.ZodTuple<[z.ZodTypeAny, ...z.ZodTypeAny[]] | [], z.ZodUnknown | null>
type ParsedArgs<Schema extends AnyArgsSchema> = z.infer<Schema>

type BaseOptions<Schema extends AnyArgsSchema> = {
  channel: IpcChannel
  args: Schema
  assertSender: AssertSender
}

type RequiredAuthOptions<Schema extends AnyArgsSchema> = BaseOptions<Schema> & {
  auth: 'required'
  isAuthenticated: RequireAuth
}

type PublicAuthOptions<Schema extends AnyArgsSchema> = Omit<BaseOptions<Schema>, 'channel'> & {
  channel: ReviewedPublicIpcChannel
  auth: 'public'
}

export type RegisterHandlerOptions<Schema extends AnyArgsSchema> =
  | RequiredAuthOptions<Schema>
  | PublicAuthOptions<Schema>

export type RegisteredHandlerResult<Result> = Result | UnauthenticatedResult

export function registerHandler<Schema extends AnyArgsSchema, Result>(
  options: RegisterHandlerOptions<Schema>,
  handler: (event: InvokeEvent, ...args: ParsedArgs<Schema>) => Result | Promise<Result>
): void {
  const auth = (options as { auth?: unknown }).auth
  if (auth !== 'public' && auth !== 'required') {
    throw new Error(`Unknown IPC auth policy for ${options.channel}: ${String(auth)}`)
  }
  if (auth === 'public') assertReviewedPublicHandler(options.channel)

  ipcMain.handle(options.channel, async (event, ...rawArgs: unknown[]): Promise<RegisteredHandlerResult<Awaited<Result>>> => {
    options.assertSender(event)
    const parsedArgs = options.args.parse(rawArgs) as ParsedArgs<Schema>
    if (options.auth === 'required' && !options.isAuthenticated()) return UNAUTHENTICATED_RESULT
    return await handler(event, ...parsedArgs) as Awaited<Result>
  })
}
