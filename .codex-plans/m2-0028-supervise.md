# M2-0028 mac-helper supervise

## Checklist

- [x] Inspect scoped files and surrounding tests.
- [x] Add behavior-first test coverage for supervision flag, wrapper fallback, and process-group stop behavior.
- [x] Implement `mac-helper supervise` on macOS with process group isolation, parent death watching, signal forwarding, and child-status exit.
- [x] Route local and FM runtimes through supervised launch when enabled, preserving direct spawn when disabled.
- [x] Emit `sidecar.unsupervised` audit on wrapper missing/failing fallback.
- [x] Add HK-M packaged QA tool support for 20-cycle main SIGKILL sidecar cleanup evidence and same-name survivor checks.
- [x] Add CI workflow dispatch path for packaged HK-M and codesign evidence without local app/test execution.
- [x] Run allowed local `npx tsc --noEmit` checks for node/web/tests and document results.

## Review

Implementation complete. Packaged/live HK-M and codesign evidence are wired for GitHub Actions, not run locally.

Verification:

- `npx tsc --noEmit -p tsconfig.node.json`: passed.
- `npx tsc --noEmit -p tsconfig.web.json`: passed.
- `npx tsc --noEmit -p tsconfig.tests.json`: 7 errors, all pre-existing outside M2-0028 files; within the owner bar of no more than 7.
- Not run locally by rule: npm test, vitest, node QA scripts, app launch, build/package, codesign.
