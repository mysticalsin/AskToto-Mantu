import { describe, expect, it, vi } from 'vitest'
import { CONNECTOR_CATALOG, type ConnectorResult } from '@shared/connector-catalog'
import { createReadOnlyConnectorPort, ResearchWriteRefused } from './read-only-port'

const okResult = (opId: string): ConnectorResult => ({
  ok: true,
  output: { events: [] },
  provenance: {
    connectorKind: 'outlook',
    accountRef: 'acct_x' as never,
    opId,
    revision: 3,
    accountRule: 'only_account'
  }
})

function setup() {
  const execute = vi.fn(async (call: { opId: string }) => okResult(call.opId))
  const port = createReadOnlyConnectorPort(
    { execute },
    { current: () => ({ revision: 3, operations: CONNECTOR_CATALOG }) }
  )
  return { execute, port }
}

describe('read-only connector port (G67, T082)', () => {
  it.each([
    'outlook.draft.create',
    'outlook.event.create'
  ])('refuses %s (a non-read op) before execute is called', async (opId) => {
    const { execute, port } = setup()
    await expect(port.read(opId, {})).rejects.toBeInstanceOf(ResearchWriteRefused)
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses every catalog op whose effect is not read', async () => {
    const { execute, port } = setup()
    for (const op of CONNECTOR_CATALOG.filter((o) => o.effect !== 'read')) {
      await expect(port.read(op.opId, {})).rejects.toBeInstanceOf(ResearchWriteRefused)
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses an unknown op', async () => {
    const { execute, port } = setup()
    await expect(port.read('outlook.nothing', {})).rejects.toBeInstanceOf(ResearchWriteRefused)
    expect(execute).not.toHaveBeenCalled()
  })

  it('passes a read op through with the current catalog revision and no approval', async () => {
    const { execute, port } = setup()
    const result = await port.read('outlook.calendar.today', { tz: 'UTC' })
    expect(result.ok).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    const call = execute.mock.calls[0]![0] as Record<string, unknown>
    expect(call).toMatchObject({ opId: 'outlook.calendar.today', revision: 3, input: { tz: 'UTC' } })
    expect(call).not.toHaveProperty('approval')
    expect(result.ok && result.provenance.opId).toBe('outlook.calendar.today')
  })

  it('exposes nothing but read', () => {
    expect(Object.keys(setup().port)).toEqual(['read'])
  })
})
