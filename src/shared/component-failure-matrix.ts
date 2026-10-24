import { z } from 'zod'

/**
 * Optional-component failure matrix (G87, CAP-37). Pure data: for every optional on-device component, each
 * failure mode that can apply to it, what the product falls back to, and the sentence Settings shows. The
 * resolver (main/features/components/speech-pack/optional-components.ts) maps live facts to a mode; this table
 * only says what that mode means. Sizes, providers and privacy notes stay in optional-component-descriptors.ts.
 *
 * The distinct kinds matter (spec M212-P12): insufficient disk, a digest mismatch, an incompatible driver and a
 * startup failure are different problems with different remedies and must never collapse into one "error".
 */
export const FailureModeSchema = z.enum([
  'package-invalid',
  'incompatible-target',
  'runtime-not-published',
  'repair-needed',
  'download-failed',
  'insufficient-disk',
  'insufficient-ram',
  'startup-failed'
])
export type FailureMode = z.infer<typeof FailureModeSchema>

export const DegradeTargetSchema = z.enum(['cloud-speech', 'other-local-speech', 'cloud-llm', 'feature-off'])
export type DegradeTarget = z.infer<typeof DegradeTargetSchema>

export const MatrixComponentIdSchema = z.enum(['local-llm', 'whisper', 'parakeet'])
export type MatrixComponentId = z.infer<typeof MatrixComponentIdSchema>

export interface MatrixRow {
  readonly component: MatrixComponentId
  readonly mode: FailureMode
  readonly degradesTo: DegradeTarget
  /** What the person reads. At most 160 characters; says what still works. */
  readonly copy: string
}

/** Failure modes that can occur for each component. Speech packs have no RAM gate and no sidecar to start. */
export const APPLICABLE_FAILURE_MODES: Readonly<Record<MatrixComponentId, readonly FailureMode[]>> = {
  'local-llm': [
    'package-invalid',
    'incompatible-target',
    'runtime-not-published',
    'repair-needed',
    'download-failed',
    'insufficient-disk',
    'insufficient-ram',
    'startup-failed'
  ],
  whisper: [
    'package-invalid',
    'incompatible-target',
    'runtime-not-published',
    'repair-needed',
    'download-failed',
    'insufficient-disk'
  ],
  parakeet: [
    'package-invalid',
    'incompatible-target',
    'runtime-not-published',
    'repair-needed',
    'download-failed',
    'insufficient-disk'
  ]
}

function speechRows(component: 'whisper' | 'parakeet', name: string): MatrixRow[] {
  return [
    {
      component,
      mode: 'package-invalid',
      degradesTo: 'cloud-speech',
      copy: `The installed package could not be verified, so ${name} is off. Cloud speech and Apple Speech still work.`
    },
    {
      component,
      mode: 'incompatible-target',
      degradesTo: 'cloud-speech',
      copy: `${name} cannot run on this device with this package. Cloud speech and Apple Speech still work.`
    },
    {
      component,
      mode: 'runtime-not-published',
      degradesTo: 'cloud-speech',
      copy: `The ${name} runtime is not published for this build yet. Cloud speech and Apple Speech still work.`
    },
    {
      component,
      mode: 'repair-needed',
      degradesTo: 'other-local-speech',
      copy: `The ${name} files failed their check. Repair them, or use the other offline engine or cloud speech.`
    },
    {
      component,
      mode: 'download-failed',
      degradesTo: 'cloud-speech',
      copy: `The ${name} download did not finish. Nothing was installed. Cloud speech and Apple Speech still work.`
    },
    {
      component,
      mode: 'insufficient-disk',
      degradesTo: 'cloud-speech',
      copy: `There is not enough free disk space for ${name}. Free some space and retry. Cloud speech still works.`
    }
  ]
}

export const COMPONENT_FAILURE_MATRIX: readonly MatrixRow[] = [
  {
    component: 'local-llm',
    mode: 'package-invalid',
    degradesTo: 'cloud-llm',
    copy: 'The installed package could not be verified, so Métis Local is off. Cloud suggestions still work.'
  },
  {
    component: 'local-llm',
    mode: 'incompatible-target',
    degradesTo: 'cloud-llm',
    copy: 'Métis Local cannot run on this device with this package. Cloud suggestions still work.'
  },
  {
    component: 'local-llm',
    mode: 'runtime-not-published',
    degradesTo: 'cloud-llm',
    copy: 'The Métis Local runtime is not published for this build yet. Cloud suggestions still work.'
  },
  {
    component: 'local-llm',
    mode: 'repair-needed',
    degradesTo: 'cloud-llm',
    copy: 'The Métis Local model files failed their check. Download them again. Cloud suggestions still work.'
  },
  {
    component: 'local-llm',
    mode: 'download-failed',
    degradesTo: 'cloud-llm',
    copy: 'The Métis Local download did not finish. Nothing was installed. Cloud suggestions still work.'
  },
  {
    component: 'local-llm',
    mode: 'insufficient-disk',
    degradesTo: 'cloud-llm',
    copy: 'There is not enough free disk space for Métis Local. Free some space and retry. Cloud suggestions still work.'
  },
  {
    component: 'local-llm',
    mode: 'insufficient-ram',
    degradesTo: 'cloud-llm',
    copy: 'This computer does not have enough memory for Métis Local. Cloud suggestions still work.'
  },
  {
    component: 'local-llm',
    mode: 'startup-failed',
    degradesTo: 'cloud-llm',
    copy: 'Métis Local is installed but did not start. Cloud suggestions still work; restart Métis to retry.'
  },
  ...speechRows('whisper', 'Whisper'),
  ...speechRows('parakeet', 'Parakeet')
]

export function matrixRowFor(component: MatrixComponentId, mode: FailureMode): MatrixRow | null {
  return COMPONENT_FAILURE_MATRIX.find((row) => row.component === component && row.mode === mode) ?? null
}

/** The `blockedBy` values of OptionalComponentStatus, each mapped to the failure mode it is. */
export const BLOCKED_BY_FAILURE_MODE = {
  'package-invalid': 'package-invalid',
  'package-incompatible': 'incompatible-target',
  'runtime-not-published': 'runtime-not-published'
} as const satisfies Record<string, FailureMode>

/** Speech-pack row states (SpeechPackComponentSnapshot.state); null means the state is not a failure. */
export const SPEECH_ROW_STATE_FAILURE_MODE = {
  'not-installed': null,
  'repair-needed': 'repair-needed',
  'not-configured': 'runtime-not-published',
  queued: null,
  downloading: null,
  verifying: null,
  'self-testing': null,
  ready: null,
  paused: null,
  error: 'download-failed'
} as const satisfies Record<string, FailureMode | null>

/** LocalModelUnavailableReason values; null means the reason is a normal state, not a failure. */
export const LOCAL_MODEL_REASON_FAILURE_MODE = {
  'invalid-bundle': 'repair-needed',
  'insufficient-ram': 'insufficient-ram',
  'insufficient-disk': 'insufficient-disk',
  downloading: null,
  'download-failed': 'download-failed',
  'not-downloaded': null
} as const satisfies Record<string, FailureMode | null>

/**
 * Components Settings lists but cannot remove (no optional download to free). `failures` names only what a
 * real detection seam reports today; a row without a seam shows provider and privacy only.
 */
export interface NonRemovableComponent {
  readonly id: 'mac-helper' | 'system-voices' | 'mcp-servers'
  readonly label: string
  readonly provider: string
  readonly privacyNote: string
  readonly removable: false
  readonly failures: readonly { readonly seam: string; readonly stillWorks: string }[]
}

export const NON_REMOVABLE_COMPONENTS: readonly NonRemovableComponent[] = [
  {
    id: 'mac-helper',
    label: 'macOS helper',
    provider: 'Métis, built into the macOS app',
    privacyNote: 'Apple Speech and screen permissions run on this Mac. Nothing here is sent to a speech service.',
    removable: false,
    failures: []
  },
  {
    id: 'system-voices',
    label: 'System voices (spoken replies)',
    provider: 'Voices installed with your operating system',
    privacyNote: 'Spoken replies are generated by your operating system on this computer.',
    removable: false,
    // Seam: main/features/spoken-replies/spoken-replies-service.ts failed reasons no_voice | engine | spawn.
    failures: [{ seam: 'spoken-replies: no_voice, engine, spawn', stillWorks: 'The answer stays on screen.' }]
  },
  {
    id: 'mcp-servers',
    label: 'MCP servers',
    provider: 'Servers you add yourself',
    privacyNote: 'Each server decides what it receives. Métis sends a server only what a tool call needs.',
    removable: false,
    failures: []
  }
]

export type LocalModelReasonName = keyof typeof LOCAL_MODEL_REASON_FAILURE_MODE

/** What the product falls back to once the component's files are offloaded (removed on purpose). */
export const OFFLOAD_DEGRADES_TO = {
  'local-llm': 'cloud-llm',
  whisper: 'cloud-speech',
  parakeet: 'cloud-speech'
} as const satisfies Record<MatrixComponentId, DegradeTarget>
