# ROCKS — Local LLM ("Métis Local") · locked 2026-07-11 from PLAN.md v6 §8

Company rock: Métis answers lightweight meeting asks (suggest/summary/screenshots)
on-device — free, private, < 1.5 s warm.

## Rock 1: Provision and manage the llama-server sidecar runtime
Owner: Integrator (built by Sonnet executor under Visionary review)
Due: engagement day 1
Done means: pinned llama-server fetch+verify for mac arm64 AND win x64 assets, spawn/health/idle/kill lifecycle proven on mac arm64 (port parsed from the --port 0 "listening on" log line), guard script fails hard on missing target binary, guard wired into EVERY electron-builder path: predist, predist:win, dist:local, dist:win:appx, release, release:win, release:mas, release:win:store, build-installers.mjs, and build.yml both platform jobs — with a wiring-assertion unit test that greps package.json scripts and .github/workflows/build.yml for the guard invocations, so missing wiring fails the suite mechanically.
Proof: `npm test -- local-runtime` → exit 0 (real fetched mac binary spawn→health 200→kill; win asset fetch + guard failure cases platform-parameterized; wiring-assertion test green)
Status: DONE

## Rock 2: Model manifest, download, verify, delete
Owner: Integrator (Sonnet executor)
Due: engagement day 1
Done means: manifest containing EXACTLY the fully-pinned v1 models (qwen3.5-0.8b + qwen3.5-2b, URLs/sha256/bytes from §3 pins; a manifest-shape test asserts every entry carries a 64-hex sha256 for both gguf and mmproj, so an unpinned entry can never ship), Range-resume download with IPC progress, streamed sha256 rejection, RAM gating, delete.
Proof: `npm test -- local-models` → exit 0 (checksum-reject + manifest-shape/pin-enforcement + RAM-gate cases green)
Status: DONE

## Rock 3: `local` provider strategy + routing integration
Owner: Integrator (Sonnet executor)
Due: engagement day 2
Done means: ProviderId/ProviderKind/ProviderIdSchema 'local' (parity guard green) + ENV_VAR entry + PROVIDERS entry + streamLocal shim; eligibility, session-key injection, localPrimary precedence (override > local > cliPrimary > s.provider), localReady/per-task readiness in settings snapshot, renderer gate + summary-cascade conditioning; failover on local failure proven; think/deep/recap/answer never local.
Proof: `npm run typecheck && npm test -- local-routing` → exit 0
Status: DONE

## Rock 4: Settings "Local AI" card + IPC surface
Owner: Integrator (Sonnet executor)
Due: engagement day 2
Done means: Settings.tsx card (toggle, model picker + RAM guidance, download progress/cancel, delete, use-for checkboxes, status), new channels in shared/ipc.ts, preload exposure, state.ts types; metadata-only IPC.
Proof: `npm run typecheck && npm test` → exit 0 (full suite incl. new tests)
Status: DONE

## Rock 5: Warm-cache pre-warm + end-to-end latency proof
Owner: Integrator (Sonnet executor); e2e proof run by Visionary
Due: engagement day 3
Done means: local:prewarm IPC (renderer debounce ~5 s in the instant-suggestions effect region) → main → 1-token prefix POST keeping sidecar KV hot; e2e script downloads the lite model, spawns runtime, prefills 6k-char transcript, measures warm suggest TTFT.
Proof: `node scripts/prove-local-ttft.mjs` → prints `warm TTFT: <n> ms` with n ≤ 1500 on this M-series Mac, exit 0
Status: DONE
