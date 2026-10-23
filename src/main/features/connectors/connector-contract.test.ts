import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONNECTOR_CATALOG, isWriteEffect } from '@shared/connector-catalog'
import { OUTLOOK_DRAFT_SCOPES, OUTLOOK_EVENT_SCOPES } from '../../outlook-write'
import { createBuiltinHandlers } from './connector-handlers'
import { OUTLOOK_CONSENT_COPY } from './connector-runtime'

const MAIN = join(__dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('connector catalog <-> handler contract', () => {
  const handlers = createBuiltinHandlers()

  it('has a handler for every catalog op and a catalog entry for every handler (no advertised fake)', () => {
    expect(Object.keys(handlers).sort()).toEqual(CONNECTOR_CATALOG.map((op) => op.opId).sort())
  })

  it('declares the same scopes the Graph code actually requests', () => {
    const byId = (id: string) => CONNECTOR_CATALOG.find((op) => op.opId === id)?.scopes
    expect(byId('outlook.draft.create')).toEqual(OUTLOOK_DRAFT_SCOPES)
    expect(byId('outlook.event.create')).toEqual(OUTLOOK_EVENT_SCOPES)
  })

  it('carries consent copy for every write op so a stale grant keeps the existing honest message', () => {
    for (const op of CONNECTOR_CATALOG.filter((o) => isWriteEffect(o.effect))) {
      expect(OUTLOOK_CONSENT_COPY[op.opId]).toMatch(/will not send/i)
    }
  })
})

describe('write paths cannot bypass the ActionGuard', () => {
  // Direct Graph write calls are legal only inside the catalog handlers, which the executor gates.
  const GRAPH_WRITE_CALLERS = new Set(['features/connectors/connector-handlers', 'outlook-write'])
  // Legacy raw MCP push call sites. G64 moves them behind the guard; this list may only shrink.
  const LEGACY_MCP_PUSH_CALLERS = new Set(['index', 'mcp/mcpClient', 'operator-integrations'])

  const files = sources(MAIN).map((f) => ({
    rel: relative(MAIN, f)
      .replaceAll('\\', '/')
      .replace(/\.tsx?$/, ''),
    text: readFileSync(f, 'utf8')
  }))

  it('only the catalog handlers call the Outlook write functions', () => {
    const callers = files
      .filter((f) => /\bcreateOutlook(?:Draft|Event)\s*\(/.test(f.text))
      .map((f) => f.rel)
      .filter((rel) => !GRAPH_WRITE_CALLERS.has(rel))
    expect(callers).toEqual([])
  })

  it('does not grow the set of raw MCP push call sites', () => {
    const callers = files.filter((f) => /\bpushToMcp\s*\(/.test(f.text)).map((f) => f.rel)
    expect(callers.filter((rel) => !LEGACY_MCP_PUSH_CALLERS.has(rel))).toEqual([])
  })

  it('wires the Outlook IPC writes through the connector runtime, not the raw functions', () => {
    const index = files.find((f) => f.rel === 'index')?.text ?? ''
    expect(index).not.toMatch(/\bcreateOutlook(?:Draft|Event)\s*\(/)
    expect(index).toMatch(/runConnectorWrite\(\s*'outlook\.draft\.create'/)
    expect(index).toMatch(/runConnectorWrite\(\s*'outlook\.event\.create'/)
  })
})
