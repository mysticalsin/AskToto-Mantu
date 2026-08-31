import { Chip } from './ui'
import { InlineOrb } from './AgentStatus'
import {
  INTELLIGENCE_UPDATE_LABEL,
  INTELLIGENCE_UPDATING_LABEL
} from '@shared/intelligence-pass'

/**
 * Update Intelligence — the explicit trigger for the local-first agent pass.
 * See docs/design/INTELLIGENCE-UPDATE.md.
 */
export function IntelligenceUpdateButton({
  running,
  disabled,
  onClick
}: {
  running: boolean
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <Chip
      variant="accent"
      title="Update Intelligence from your meetings"
      disabled={disabled || running}
      onClick={onClick}
    >
      <span data-intelligence-update="" className="inline-flex items-center gap-1.5">
        {running && <InlineOrb kind="working" />}
        {running ? INTELLIGENCE_UPDATING_LABEL : INTELLIGENCE_UPDATE_LABEL}
      </span>
    </Chip>
  )
}
