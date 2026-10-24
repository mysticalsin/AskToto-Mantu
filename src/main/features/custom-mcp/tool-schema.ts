import { z } from 'zod'
import { actionDigest } from '../../action-guard'
import { isWriteToolName } from '../../mcp/write-tools'

/** What main keeps about a server-declared tool. Nothing here can carry a right: the effect is derived, never read. */
export interface ValidatedTool {
  name: string
  description: string
  effect: 'read' | 'create'
  inputDigest: string
  required: string[]
  properties: string[]
  closed: boolean
}

export type ToolListResult = { ok: true; tools: ValidatedTool[] } | { ok: false; rule: string }

const NAME = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_SCHEMA_BYTES = 16 * 1024
const MAX_LIST_BYTES = 256 * 1024
const MAX_DEPTH = 8
const MAX_DESCRIPTION = 1024
const MAX_ARG_KEYS = 20
const MAX_ARG_STRING = 50_000
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const sizeOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8')

/** First problem found while walking a JSON schema: too deep, or a `$ref` that leaves the document. */
function schemaProblem(node: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return 'customMcp.schemaDepth'
  if (Array.isArray(node)) {
    for (const item of node) {
      const p = schemaProblem(item, depth + 1)
      if (p) return p
    }
    return null
  }
  if (!isRecord(node)) return null
  for (const [key, value] of Object.entries(node)) {
    if ((key === '$ref' || key === '$dynamicRef') && !(typeof value === 'string' && value.startsWith('#'))) {
      return 'customMcp.schemaRef'
    }
    const p = schemaProblem(value, depth + 1)
    if (p) return p
  }
  return null
}

/**
 * The effect rule (T067): a tool is `read` only when the server says `readOnlyHint === true` AND its name does not
 * look like a write. Everything else is a write and needs the confirm card. A description cannot change this.
 */
export function classifyEffect(tool: { name: string; annotations?: unknown }): 'read' | 'create' {
  const hint = isRecord(tool.annotations) ? tool.annotations.readOnlyHint : undefined
  return hint === true && !isWriteToolName(tool.name) ? 'read' : 'create'
}

export function validateToolList(raw: unknown, limits: { maxTools: number }): ToolListResult {
  if (!Array.isArray(raw)) return { ok: false, rule: 'customMcp.toolList' }
  if (raw.length > limits.maxTools) return { ok: false, rule: 'customMcp.maxTools' }
  if (sizeOf(raw) > MAX_LIST_BYTES) return { ok: false, rule: 'customMcp.listSize' }

  const seen = new Set<string>()
  const tools: ValidatedTool[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== 'string' || !NAME.test(item.name) || seen.has(item.name)) {
      return { ok: false, rule: 'customMcp.toolName' }
    }
    seen.add(item.name)
    const schema = item.inputSchema
    if (!isRecord(schema) || schema.type !== 'object') return { ok: false, rule: 'customMcp.schemaType' }
    if (sizeOf(schema) > MAX_SCHEMA_BYTES) return { ok: false, rule: 'customMcp.schemaSize' }
    const problem = schemaProblem(schema, 1)
    if (problem) return { ok: false, rule: problem }

    const description = (typeof item.description === 'string' ? item.description : '')
      .replace(CONTROL, '')
      .slice(0, MAX_DESCRIPTION)
    const required = Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === 'string').slice(0, 64)
      : []
    tools.push({
      name: item.name,
      description,
      effect: classifyEffect({ name: item.name, annotations: item.annotations }),
      inputDigest: actionDigest(schema),
      required,
      properties: isRecord(schema.properties) ? Object.keys(schema.properties).slice(0, 64) : [],
      closed: schema.additionalProperties === false
    })
  }
  return { ok: true, tools }
}

/** Order-independent digest of everything a re-review must cover; a change means the catalog changed. */
export function toolsFingerprint(tools: readonly ValidatedTool[]): string {
  return actionDigest(
    [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description, effect: t.effect, inputDigest: t.inputDigest }))
  )
}

const ArgValue = z.union([z.string().max(MAX_ARG_STRING), z.number(), z.boolean(), z.null()])

/** A flat object of primitives (mirrors the MCP connection push cap); `required` and `closed` come from the tool. */
export function boundedArgsSchema(tool: Pick<ValidatedTool, 'required' | 'properties' | 'closed'>): z.ZodType {
  return z.record(z.string(), ArgValue).superRefine((args, ctx) => {
    const keys = Object.keys(args)
    if (keys.length > MAX_ARG_KEYS) ctx.addIssue({ code: 'custom', message: 'too many arguments' })
    for (const key of tool.required) {
      if (!(key in args)) ctx.addIssue({ code: 'custom', message: 'missing required argument' })
    }
    if (tool.closed && keys.some((key) => !tool.properties.includes(key))) {
      ctx.addIssue({ code: 'custom', message: 'unknown argument' })
    }
  })
}
