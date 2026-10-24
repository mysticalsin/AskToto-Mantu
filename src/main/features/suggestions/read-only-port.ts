import {
  isWriteEffect,
  type AccountRef,
  type ConnectorOperation,
  type ConnectorResult
} from '@shared/connector-catalog'

/** The slice of the connector executor research uses: a call with no approval field at all. */
interface ReadCall {
  opId: string
  revision: number
  input: unknown
  accountRef?: AccountRef
}

/** Thrown before any provider call when research asks for something that is not a plain read. */
export class ResearchWriteRefused extends Error {
  constructor(readonly opId: string) {
    super('Research may only read.')
  }
}

export interface ReadOnlyConnectorPort {
  /** Runs a catalog operation whose effect is `read`. Never carries an approval. */
  read(opId: string, input: unknown, accountRef?: AccountRef): Promise<ConnectorResult>
}

/**
 * The only connector surface the research pipeline receives (G67, R082). It exposes `read` alone, looks the operation
 * up in the catalog in force, and throws `ResearchWriteRefused` for an unknown operation or any effect other than
 * `read` before the executor is called. There is no approval parameter and no way to reach the executor's write path.
 */
export function createReadOnlyConnectorPort(
  executor: { execute(call: ReadCall): Promise<ConnectorResult> },
  catalog: { current(): { revision: number; operations: readonly ConnectorOperation[] } }
): ReadOnlyConnectorPort {
  return {
    async read(opId, input, accountRef) {
      const snapshot = catalog.current()
      const op = snapshot.operations.find((candidate) => candidate.opId === opId)
      if (!op || isWriteEffect(op.effect)) throw new ResearchWriteRefused(opId)
      return executor.execute({
        opId,
        revision: snapshot.revision,
        input,
        ...(accountRef ? { accountRef } : {})
      })
    }
  }
}
