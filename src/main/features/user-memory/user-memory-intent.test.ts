import { describe, expect, it } from 'vitest'
import { parseRememberIntent } from './user-memory-intent'

describe('what counts as asking Métis to remember (G57)', () => {
  it.each([
    ['Call me Tony', { kind: 'preference', text: 'Call the owner Tony' }],
    ['please call me Dr. Silva.', { kind: 'preference', text: 'Call the owner Dr. Silva' }],
    ['From now on answer in Portuguese', { kind: 'preference', text: 'Answer in Portuguese' }],
    ['Always keep answers to three bullets!', { kind: 'preference', text: 'Keep answers to three bullets' }],
    ['Remember that I prefer metric units', { kind: 'preference', text: 'I prefer metric units' }],
    ["I'm working on Project Atlas", { kind: 'project-context', text: 'Working on Project Atlas' }],
    ['My current project is the Q4 renewal', { kind: 'project-context', text: 'Working on the Q4 renewal' }]
  ])('%s', (turn, expected) => {
    expect(parseRememberIntent(turn)).toEqual(expected)
  })

  it.each([
    'What did we decide about pricing?',
    'Can you remember that for me?',
    'Summarize the call and always include the owner',
    'Call me back about the invoice and then draft the email to the customer today',
    'The customer said call me Boss',
    'remember',
    'I am working on it? really',
    `Remember that ${'x'.repeat(500)}`,
    'Remember that line one\nline two',
    ''
  ])('ordinary asks remember nothing: %s', (turn) => {
    expect(parseRememberIntent(turn)).toBeNull()
  })
})
