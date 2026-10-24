import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { matrixRowFor } from '@shared/component-failure-matrix'
import type { OffloadPlan, OffloadReceipt } from '@shared/component-offload'
import type { OptionalComponentStatus } from '@shared/speech-pack'
import {
  OptionalComponentsView,
  formatBytes,
  optionalConfirmKey,
  type OptionalComponentsViewProps
} from './OptionalComponentsSection'

function status(
  id: OptionalComponentStatus['id'],
  over: Partial<OptionalComponentStatus> = {}
): OptionalComponentStatus {
  return {
    id,
    label:
      id === 'whisper'
        ? 'Whisper (offline speech)'
        : id === 'parakeet'
          ? 'Parakeet (fast offline speech)'
          : 'Métis Local',
    provider: `Provider of ${id}`,
    sourceHost: 'huggingface.co',
    privacy: 'on-device',
    privacyNote: `Privacy note of ${id}`,
    downloadBytes: 150 * 1024 * 1024,
    installedBytes: 200 * 1024 * 1024,
    presence: 'absent',
    blockedBy: null,
    failure: null,
    installable: false,
    removable: false,
    removableBytes: 0,
    offer: { surface: 'settings', consent: 'required' },
    ...over
  }
}

const plan: OffloadPlan = {
  planId: '11111111-1111-4111-8111-111111111111',
  componentId: 'whisper',
  label: 'Whisper (offline speech)',
  removableBytes: 200 * 1024 * 1024,
  degradesTo: 'cloud-speech',
  expiresAt: new Date(1000).toISOString()
}
const receipt: OffloadReceipt = {
  receiptId: '22222222-2222-4222-8222-222222222222',
  componentId: 'whisper',
  label: 'Whisper (offline speech)',
  removedAt: new Date(0).toISOString(),
  bytesFreed: 209_715_200,
  freeBytesBefore: 5 * 1024 ** 3,
  freeBytesAfter: 5 * 1024 ** 3 + 209_715_200,
  verifiedAbsent: true,
  sessionDataTouched: false
}

function render(over: Partial<OptionalComponentsViewProps> = {}): { html: string; text: string } {
  const props: OptionalComponentsViewProps = {
    components: [
      status('local-llm'),
      status('whisper', { presence: 'installed', removable: true, removableBytes: 200 * 1024 * 1024 }),
      status('parakeet', { presence: 'bundled' })
    ],
    plan: null,
    receipt: null,
    receipts: [],
    message: null,
    busy: false,
    onRemove: () => undefined,
    onConfirm: () => undefined,
    onKeep: () => undefined,
    ...over
  }
  const html = renderToStaticMarkup(createElement(OptionalComponentsView, props))
  return {
    html,
    text: html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, ' ')
  }
}

describe('OptionalComponentsSection (G87)', () => {
  it('shows size, provider, source host and privacy for each component', () => {
    const { text } = render()
    for (const id of ['local-llm', 'whisper', 'parakeet']) {
      expect(text).toContain(`Provider of ${id}`)
      expect(text).toContain(`Privacy note of ${id}`)
    }
    expect(text).toContain('huggingface.co')
    expect(text).toContain('150 MB download')
    expect(text).toContain('200 MB on disk')
  })

  it('lists the components that are not removable, with provider and privacy', () => {
    const { text } = render()
    expect(text).toContain('Also on this device')
    expect(text).toContain('macOS helper')
    expect(text).toContain('System voices')
    expect(text).toContain('MCP servers')
    expect(text).toContain('Not removable.')
  })

  it('shows the failure copy and what still works', () => {
    const { text } = render({ components: [status('whisper', { failure: 'insufficient-disk' })] })
    expect(text).toContain(matrixRowFor('whisper', 'insufficient-disk')?.copy)
    expect(text).toContain('Falls back to: Cloud speech or Apple Speech')
  })

  it('shows distinct copy per failure kind', () => {
    const seen = new Set<string>()
    for (const failure of ['repair-needed', 'insufficient-disk', 'incompatible-target', 'startup-failed'] as const) {
      const id = failure === 'startup-failed' ? 'local-llm' : 'whisper'
      const { html } = render({ components: [status(id, { failure })] })
      expect(html).toContain(`data-failure="${failure}"`)
      seen.add(matrixRowFor(id, failure)?.copy ?? '')
    }
    expect(seen.size).toBe(4)
  })

  it('offers Remove only on removable rows and never on bundled rows', () => {
    const { html, text } = render()
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(text).toContain('Remove Whisper (offline speech)')
    expect(text).toContain('ships inside the app and cannot be removed here')
    const bundledOnly = render({ components: [status('parakeet', { presence: 'bundled', removable: false })] })
    expect(bundledOnly.html).not.toContain('<button')
  })

  it('Remove requires the confirm card: the card names the bytes and what degrades, and the button waits', () => {
    const before = render()
    expect(before.text).not.toContain('Confirm remove')
    const after = render({ plan })
    expect(after.text).toContain('Remove Whisper (offline speech)?')
    expect(after.text).toContain('frees about 200 MB')
    expect(after.text).toContain('Cloud speech or Apple Speech')
    expect(after.text).toContain('meetings and notes are not touched')
    expect(after.text).toContain('Confirm remove')
    expect(after.text).toContain('Keep it')
  })

  it('shows the receipt with freed bytes', () => {
    const { text } = render({ receipt, receipts: [receipt] })
    expect(text).toContain('Removed Whisper (offline speech)')
    expect(text).toContain('Freed 200 MB (measured)')
    expect(text).toContain('Files confirmed gone.')
    expect(text).toContain('Free disk space: 5.0 GB before, 5.2 GB after')
    expect(text).toContain('Removal history (1)')
  })

  it('formats sizes without inventing precision', () => {
    expect(formatBytes(1536)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })

  it('remove and confirm buttons show visible focus (G91)', () => {
    expect(render().html).toMatch(/<button[^>]*class="[^"]*focus-ring/)
    const buttons = render({ plan }).html.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    for (const b of buttons) expect(b).toContain('focus-ring')
  })

  it('confirm names the component (G91)', () => {
    expect(render({ plan }).html).toContain('aria-label="Confirm remove Whisper (offline speech)"')
  })

  it('optionalConfirmKey: Escape keeps, nothing confirms by key (G91)', () => {
    expect(optionalConfirmKey('Escape')).toBe('keep')
    expect(optionalConfirmKey('Enter')).toBeNull()
    expect(optionalConfirmKey('y')).toBeNull()
  })
})
