import { describe, expect, it } from 'vitest'
import { dockChatIsSquare } from './dock-chat-square'

describe('dockChatIsSquare — Tony HARD right-edge overlay text', () => {
  it('treats OVERLAY_DOCK_PANEL 380×560 as square', () => {
    expect(dockChatIsSquare(380, 560)).toBe(true)
  })
  it('rejects tall rectangular chat (no overlay text ever)', () => {
    expect(dockChatIsSquare(380, 1080)).toBe(false)
    expect(dockChatIsSquare(20, 1080)).toBe(false)
  })
  it('rejects empty geometry', () => {
    expect(dockChatIsSquare(0, 560)).toBe(false)
  })
})
