import { describe, expect, it } from 'vitest'
import { AttachmentSendError } from '@shared/attachments'
import { askStartFailureMessage } from './ask-turn'

describe('a refused attachment reaches the owner as its own copy (G54)', () => {
  it('askStartFailureMessage names an attachment refusal and nothing else', () => {
    expect(askStartFailureMessage(new AttachmentSendError('wrong-target'))).toBe(
      'This file was attached to another conversation. Attach it again here.'
    )
    expect(askStartFailureMessage(new Error('disk path /Users/x leaked'))).toBe('Could not start the answer.')
  })
})
