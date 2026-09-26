import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordOperatorAsk, resolveQuestionType, setOperatorFetchForTests } from './operator-ingest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.8.0-test' }
}))
vi.mock('./license', () => ({
  getMachineId: () => 'machine-test-0001'
}))
vi.mock('./logger', () => ({
  mainLog: { warn: () => {}, info: () => {}, error: () => {} }
}))

const SETTINGS = {
  operatorUrl: 'https://operator.test',
  operatorIngestSecret: 'shared-secret-for-tests'
}

function captureFetch(): { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  setOperatorFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
  return { calls }
}

afterEach(() => {
  setOperatorFetchForTests(null)
})

describe('resolveQuestionType', () => {
  it('prefers the caller label, falls back to local classification, never free-form', () => {
    expect(resolveQuestionType({ questionType: 'how-to', question: 'what is x' })).toBe('how-to')
    expect(resolveQuestionType({ question: 'what is the capital of belgium' })).toBe('factual')
    expect(resolveQuestionType({ question: 'anything', vision: true })).toBe('screen')
    expect(resolveQuestionType({ questionType: 'evil' as never, question: undefined })).toBe('unknown')
    expect(resolveQuestionType({})).toBe('unknown')
  })
})

describe('recordOperatorAsk question type', () => {
  it('ships the type as a metric with Ask text ON and OFF; text only when ON', async () => {
    const on = captureFetch()
    await recordOperatorAsk(
      { ...SETTINGS, sendAskText: true },
      { id: 'ask-on', question: 'How do I rotate the ingest secret?', provider: 'anthropic' }
    )
    expect(on.calls).toHaveLength(1)
    expect(on.calls[0].url).toBe('https://operator.test/v1/ingest')
    expect(on.calls[0].body.questionType).toBe('how-to')
    expect(on.calls[0].body.question).toBe('How do I rotate the ingest secret?')

    const off = captureFetch()
    await recordOperatorAsk(
      { ...SETTINGS, sendAskText: false },
      { id: 'ask-off', question: 'How do I rotate the ingest secret?', provider: 'anthropic' }
    )
    expect(off.calls).toHaveLength(1)
    expect(off.calls[0].body.questionType).toBe('how-to')
    expect(off.calls[0].body.question).toBeUndefined()
    expect(JSON.stringify(off.calls[0].body)).not.toContain('rotate the ingest secret')
  })

  it('a vision Ask is typed screen and a blank prompt is unknown, never a guess', async () => {
    const f = captureFetch()
    await recordOperatorAsk(SETTINGS, { id: 'v', vision: true, question: 'what is the capital of belgium' })
    await recordOperatorAsk(SETTINGS, { id: 'blank', question: '' })
    expect(f.calls[0].body.questionType).toBe('screen')
    expect(f.calls[1].body.questionType).toBe('unknown')
  })

  it('does nothing without an https URL and a secret', async () => {
    const f = captureFetch()
    await recordOperatorAsk({ operatorUrl: 'http://plain.test', operatorIngestSecret: 'x' }, { id: 'a', question: 'why' })
    await recordOperatorAsk({ operatorUrl: 'https://operator.test' }, { id: 'b', question: 'why' })
    expect(f.calls).toHaveLength(0)
  })

  it('a fetch failure is swallowed so an Ask never fails because Operator is down', async () => {
    setOperatorFetchForTests((async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch)
    await expect(recordOperatorAsk(SETTINGS, { id: 'down', question: 'why' })).resolves.toBeUndefined()
  })
})
