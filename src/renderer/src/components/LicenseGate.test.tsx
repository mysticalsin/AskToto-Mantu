import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, PublicSettingsSchema } from '@shared/ipc'

const settings = PublicSettingsSchema.parse({
  ...DEFAULT_SETTINGS,
  hasApiKey: false,
  providerReady: false,
  visionReady: false,
  hasKeys: {},
  hasEncryption: true,
  resolvedMeetingsFolder: ''
})

describe('LicenseGate dialog accessibility', () => {
  afterEach(() => {
    vi.doUnmock('react')
    vi.doUnmock('../lib/dialog-focus')
    vi.resetModules()
  })

  it('renders as a labelled modal dialog with the activation controls inside it', async () => {
    const { LicenseGate } = await import('./LicenseGate')
    const html = renderToStaticMarkup(
      <LicenseGate settings={settings} onRecheck={async () => {}} />
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    const labelId = html.match(/aria-labelledby="([^"]+)"/)?.[1]
    expect(labelId).toBeTruthy()
    expect(html).toContain(`id="${labelId}"`)
    expect(html).toContain('>This copy of Métis needs an active license</div>')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('License server URL')
    expect(html).toContain('License key')
    expect(html).toContain('Activate')
    expect(html).toContain('Retry')
  })

  it('activates the focus trap when the gate mounts', async () => {
    const root = { id: 'dialog-root' } as unknown as HTMLDivElement
    const cleanup = vi.fn()
    const trap = vi.fn(() => cleanup)
    let refCount = 0

    vi.resetModules()
    vi.doMock('react', async (importOriginal) => {
      const react = await importOriginal<typeof import('react')>()
      return {
        ...react,
        useEffect: (effect: () => void | (() => void)) => effect(),
        useId: () => `license-id-${refCount++}`,
        useRef: (init: unknown) => {
          if (init === true) return { current: true }
          return { current: root }
        },
        useState: <T,>(init: T) => [init, vi.fn()] as const
      }
    })
    vi.doMock('../lib/dialog-focus', () => ({ activateDialogFocusTrap: trap }))

    const { LicenseGate } = await import('./LicenseGate')
    LicenseGate({ settings, onRecheck: async () => {} })

    expect(trap).toHaveBeenCalledWith(root)
  })
})
