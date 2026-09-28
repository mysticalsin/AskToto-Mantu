# win-supervise

`supervise.exe [--] <exe> [args...]` runs one command in a private job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, no breakaway flags, and atomic placement through
`PROC_THREAD_ATTRIBUTE_JOB_LIST`. Its exit code is the child's; 125 means supervise.exe itself failed.

## Why it exists only conditionally

libuv puts non-detached children in a kill-on-close job. Whether that also covers grandchildren under
Electron 43 is measured, not assumed: the HK-W lane (`scripts/qa/hk-w.ps1`, run by
`.github/workflows/windows-qa.yml`, suite `hk-w`) hard-kills only `Metis.exe` for 20 cycles and reports
`jobSemantics` in `hk-w-summary.json`.

- `descendants-killed`: the libuv job is enough. `supervise.exe` is not wired into the app.
- `descendants-survive`: run the workflow with `build_supervise=true` to build this source on
  `windows-latest` and upload the (unsigned) binary as an artifact, then wire the sidecar spawns through it.

The binary would itself need Authenticode signing; that is tracked on the Windows signing ticket and is
blocked until the signing route exists. The workflow never signs or publishes it.
