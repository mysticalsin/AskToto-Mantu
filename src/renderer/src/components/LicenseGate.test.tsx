import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, PublicSettingsSchema } from '@shared/ipc'
import { LicenseGate } from './LicenseGate'

describe('LicenseGate dialog accessibility', () => {
  it('renders as a labelled modal dialog with the activation controls inside it', () => {
    const html = renderToStaticMarkup(
      <LicenseGate
        settings={PublicSettingsSchema.parse({
          ...DEFAULT_SETTINGS,
          hasApiKey: false,
          providerReady: false,
          visionReady: false,
          hasKeys: {},
          hasEncryption: true,
          resolvedMeetingsFolder: ''
        })}
        onRecheck={async () => {}}
      />
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
})
