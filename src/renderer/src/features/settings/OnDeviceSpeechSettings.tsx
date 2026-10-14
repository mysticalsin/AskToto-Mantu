import type { PublicSettings } from '@shared/ipc'
import { Info } from 'lucide-react'
import { isWindows } from '../../lib/keys'
import { FieldHint } from '../../components/ui'
import { ManagedChip } from '../../ui/ManagedChip'
import { ctl } from '../../ui/ctl'
import { CoreAsrAssetsRow, WhisperQualityRow } from './AiSection'
import { SpeechPackSection, type SpeechPackBridge } from './SpeechPackSection'

type SpeechSettings = Pick<PublicSettings, 'asrEngine' | 'asrQuality' | 'managedKeys'>

/** The full set of local-engine controls, hidden by an organization cloud-only profile. */
export function OnDeviceSpeechSettings({
  settings,
  patch,
  bridge,
  bundled
}: {
  settings: SpeechSettings
  patch: (p: Partial<PublicSettings>) => void
  bridge: SpeechPackBridge
  bundled: boolean
}): JSX.Element {
  return (
    <>
      <CoreAsrAssetsRow />
      <SpeechPackSection bridge={bridge} selectedEngine={settings.asrEngine} />
      <WhisperQualityRow bundled={bundled} settings={settings} patch={patch} />
      <div className="flex flex-col gap-1.5 px-1 py-1">
        <label className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
          Transcription engine
          <FieldHint text="For fresh setup, 8 GB or less selects Parakeet; more than 8 GB selects Whisper. Unknown memory uses Parakeet. Existing choices and organization policy are preserved. Parakeet supports European languages; Whisper supports a wider range of languages. Apple Speech uses the macOS on-device recognizer for live meetings; imports use Whisper. Managed cloud profiles hide these on-device engines and use Cloudflare Nova-3 or Soniox instead.">
            <Info
              size={12}
              className="shrink-0 text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
            />
          </FieldHint>
          <ManagedChip keys={settings.managedKeys} k="asrEngine" />
        </label>
        <select
          value={settings.asrEngine}
          onChange={(e) => patch({ asrEngine: e.target.value as 'parakeet' | 'whisper' | 'apple' })}
          disabled={settings.managedKeys.includes('asrEngine')}
          aria-label="Transcription engine"
          className={'w-full ' + ctl}
        >
          <option value="parakeet">Parakeet · European languages</option>
          <option value="whisper">Whisper · multilingual</option>
          <option value="apple">Apple Speech · on-device{isWindows ? ' (macOS only)' : ''}</option>
        </select>
      </div>
    </>
  )
}
