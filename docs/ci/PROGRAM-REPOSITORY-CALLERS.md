# Program Repository Callers (M2-0510)

This public repository owns the reusable workflows. The program repository owns the
caller workflows below and its runtime variables. Keep the caller content here as the
public, non-test source of truth for the lead to install in that repository.

`release-check` in `program-audit-dispatch.yml` wires the release evidence inputs to
the reusable audit workflow. The first release-check run belongs to M2-0511.

## `ledger-check.yml`

```yaml
name: Program ledger check

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  ledger:
    name: Check program ledger
    uses: mysticalsin/AskToto-Mantu/.github/workflows/ledger.yml@main
    with:
      ledger-path: ${{ vars.PROGRAM_LEDGER_PATH }}
```

## `program-audit-dispatch.yml`

```yaml
name: Program audit dispatch

on:
  workflow_dispatch:
    inputs:
      mode:
        description: Audit mode to run
        required: true
        type: choice
        options:
          - backfill
          - sample
          - velocity
          - release-check
      population_of:
        description: Sample population ticket when since is blank
        required: false
        type: string
        default: M2-0046
      since:
        description: Sample lower bound; when set, population_of is ignored
        required: false
        type: string
      seed:
        description: Sample seed commit SHA
        required: false
        type: string
      gate:
        description: Program gate
        required: false
        type: string
        default: m3
      gates_path:
        description: Release-check gates input path
        required: false
        type: string
      provenance_path:
        description: Release-check provenance input path
        required: false
        type: string
      notes_path:
        description: Release-check notes input path
        required: false
        type: string

permissions:
  contents: read
  pull-requests: read

jobs:
  backfill:
    name: Backfill evidence records
    if: inputs.mode == 'backfill'
    uses: mysticalsin/AskToto-Mantu/.github/workflows/program-audit.yml@main
    with:
      mode: backfill
      ledger-path: ${{ vars.PROGRAM_LEDGER_PATH }}

  sample_population:
    name: Draw sample from population ticket
    if: inputs.mode == 'sample' && inputs.since == ''
    uses: mysticalsin/AskToto-Mantu/.github/workflows/program-audit.yml@main
    with:
      mode: sample
      ledger-path: ${{ vars.PROGRAM_LEDGER_PATH }}
      population-of: ${{ inputs.population_of }}
      seed: ${{ inputs.seed }}

  sample_since:
    name: Draw sample since bound
    if: inputs.mode == 'sample' && inputs.since != ''
    uses: mysticalsin/AskToto-Mantu/.github/workflows/program-audit.yml@main
    with:
      mode: sample
      ledger-path: ${{ vars.PROGRAM_LEDGER_PATH }}
      since: ${{ inputs.since }}
      seed: ${{ inputs.seed }}

  velocity:
    name: Forecast velocity
    if: inputs.mode == 'velocity'
    uses: mysticalsin/AskToto-Mantu/.github/workflows/program-audit.yml@main
    with:
      mode: velocity
      ledger-path: ${{ vars.PROGRAM_LEDGER_PATH }}
      records-path: ${{ vars.PROGRAM_RECORDS_PATH }}
      gate: ${{ inputs.gate }}

  release_check:
    name: Check release evidence
    if: inputs.mode == 'release-check'
    uses: mysticalsin/AskToto-Mantu/.github/workflows/program-audit.yml@main
    with:
      mode: release-check
      ledger-path: ${{ vars.PROGRAM_LEDGER_PATH }}
      records-path: ${{ vars.PROGRAM_RECORDS_PATH }}
      gate: ${{ inputs.gate }}
      gates-path: ${{ inputs.gates_path }}
      provenance-path: ${{ inputs.provenance_path }}
      notes-path: ${{ inputs.notes_path }}
```

## Lead Actions

LEAD_ACTION: add ledger-check.yml and program-audit-dispatch.yml to the program repository's .github/workflows/ and supersede the caller on branch m2-0057-sanitize-prior-exec

LEAD_ACTION: set repository variables PROGRAM_LEDGER_PATH and PROGRAM_RECORDS_PATH in the program repository to its ledger and evidence-records paths

LEAD_ACTION: dispatch backfill on program main and record the run id and uploaded artifact

LEAD_ACTION: commit the backfill records and gaps from the artifact into the program evidence-records store

LEAD_ACTION: dispatch velocity with gate=m3 on program main and record the run id and uploaded artifact

LEAD_ACTION: commit FORECAST.md citing the velocity run id before D-14's needed_by date, 2026-10-09

LEAD_ACTION: leave the first release-check run to M2-0511
