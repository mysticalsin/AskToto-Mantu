import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

describe('MQA-294 licence readiness and credential boundaries', () => {
  it('publishes only credential-presence flags and gates Listen with that flag', () => {
    const main = source('main/index.ts')
    expect(main).toContain('operatorConfigured: operatorUrlConfigured(s) && !!resolveOperatorCredential(s)')
    expect(main).toContain("operatorLicenseToken: ''")
    expect(main).toContain("operatorIngestSecret: ''")
    expect(source('renderer/src/App.tsx')).toContain('const operatorConfigured = settings?.operatorConfigured === true')
    expect(source('renderer/src/App.tsx')).not.toContain('settings?.operatorIngestSecret')
  })

  it('refreshes readiness from main events and after licence activation without refocusing', () => {
    expect(source('preload/index.ts')).toContain('sub(IPC.settingsChanged, cb)')
    expect(source('renderer/src/state.ts')).toContain('window.toto.onSettingsChanged(onFocus)')
    expect(source('main/index.ts')).toContain('onReadinessChanged: notifySettingsChanged')
    expect(source('renderer/src/components/Settings.tsx')).toContain('await refreshSettings()')
  })

  it('rejects an activation if its verified endpoint changed during the request', () => {
    expect(source('main/index.ts')).toContain('resolveOperatorBaseUrl(candidate) !== resolveOperatorBaseUrl(getSettings())')
  })

  it('MQA-295 clears saved credentials before a renderer-requested endpoint change', () => {
    const main = source('main/index.ts')
    const guard = main.slice(main.indexOf("if ('operatorUrl' in p && resolveOperatorBaseUrl"), main.indexOf('const next = setSettingsWithSpeakerPolicy(p)'))
    expect(guard.includes("operatorLicenseToken: ''")).toBe(true)
    expect(guard.includes("operatorIngestSecret: ''")).toBe(true)
  })

  it('does not bind a masked legacy credential input to persisted settings', () => {
    const settings = source('renderer/src/components/Settings.tsx')
    expect(settings).not.toContain("value={settings.operatorIngestSecret || ''}")
    expect(settings).not.toContain('onChange={(e) => patch({ operatorIngestSecret: e.target.value })}')
    expect(settings).not.toContain('Heartbeat still needs the ingest secret')
  })
})
