# Frozen local recap diagnostic (MQA-321)

This is a 16-case synthetic diagnostic, **not an enterprise-release certificate**. It uses the real `runImportedRecap → createStream → local` production chain and production prompts, output budgets, cache/slot options and native spawn arguments. It does not emulate ASR, speaker recognition, the Electron UI, installation, or real meeting quality.

## Frozen inputs and acceptance

- The 12 existing files in `src/shared/__fixtures__/golden` remain byte-for-byte unchanged. `fixtures/local-recap/manifest.json` pins their SHA-256 hashes and adds source-quoted recap expectations. The legacy extraction goldens are not used as an unquestioned owner/commitment oracle.
- `You` and `Them` are mapped to synthetic `Speaker 1` and `Speaker 2` clusters. This is an input adapter, not evidence of real-name identification. A participant's desire is not annotated as their commitment.
- The thirteenth clean case is the exact Alex/Jamie pilot scenario that exposed the missing-owner defect. Three appended transcript-injection variants reuse its clean truth. Hostile instructions do not extend the accepted number/action facts.
- Every run includes all 16 cases, once by default, in fixed order. `--trials 5` records five complete passes, with no best-of selection. Interrupted, missing, duplicate or incomplete cases cannot produce a pass.
- Required sections, topic relevance, English/French language, named action/owner/timing pairs, selected numeric facts and units, open questions, and explicit successful terminal completion are checked. A name in the quotes section is not an owned action. Repeated action bullets, inventing an owner for the collective pilot, and promoting the weekend-coverage question to an action fail.
- The scorer is a deterministic, finite-fixture sentinel, not a general semantic truth detector. It may reject valid paraphrases outside reviewed aliases and cannot prove that every unannotated claim is faithful. A human must review every raw result before changing expectations. Do not loosen an expectation solely to make a model pass.

Before a production prompt/model/runtime acceptance claim, the LLM-engineering gate still requires at least 50 representative, appropriately authorized examples, repeated-run evidence, calibrated human review and an approved latency/resource budget. This small synthetic set does not satisfy those requirements. The reported latency quantiles are sample observations, not population tail estimates.

## Commands

Run from the repository root after dependencies are installed. No command downloads a model or binary.

```sh
# Fast unit checks: no model inference.
npx vitest run scripts/evals/local-recap.test.ts scripts/evals/local-recap-safety.test.ts --maxWorkers=2

# Import the real production chain and validate all frozen fixtures, without inference.
node scripts/evals/local-recap.mjs --check

# Explicit native run; both absolute executable path and independently reviewed hash are required.
node scripts/evals/local-recap.mjs --run \
  --binary /absolute/path/to/llama-server \
  --binary-sha256 REVIEWED_64_HEX_SHA256 \
  --output /absolute/new-baseline-report.json

# Controlled comparison: same frozen case inventory; no implicit temperature override.
node scripts/evals/local-recap.mjs --run \
  --binary /absolute/path/to/candidate/llama-server \
  --binary-sha256 REVIEWED_64_HEX_SHA256 \
  --baseline /absolute/new-baseline-report.json \
  --output /absolute/new-candidate-report.json

# Re-score raw saved results, never trusting saved PASS flags; no inference.
node scripts/evals/local-recap.mjs --score /absolute/new-baseline-report.json
```

The example binary paths and hash token are placeholders, not executable recommendations. On Windows use an absolute `llama-server.exe` path. Freeze and record the settings before comparing; `--temperature 0` is an explicit QA experiment, not the production default. Binary/hash are required even for the baseline; the override substitutes only the child executable path, never product resources, model pins, or spawn arguments.

## Isolation and provenance

The runner uses a fresh synthetic profile, strips provider credentials and the real HOME from its environment, denies non-runtime child processes, blocks cloud/CLI provider strategies, and denies fetch plus direct Node HTTP/HTTPS except the owned `127.0.0.1` runtime. Redirects are denied. This is an application-level test boundary, not an OS network sandbox for an arbitrary malicious executable: run only a separately verified, trusted llama.cpp distribution. The SHA-256 identifies the exact process executable; adjacent library hashes are recorded, not vouched for by a new signature or complete dynamic-loader inventory.

The compact model pair must already exist and pass production size/hash verification. The harness never downloads or edits resources. Reports preserve actual serialized request bodies (but not authorization headers), prompt and transcript hashes, source-file hashes, model pins, executable hash, spawn profile, terminal usage/completion, raw output, first-token and total timings, and owned-process exit status. The ephemeral runtime authentication token is redacted from recorded arguments. Actual source bytes are frozen before production modules load and checked before/after cases; a concurrent edit invalidates the run even if HEAD is unchanged.

Each case has a real 180-second wall-clock safety ceiling that aborts its active stream and runtime. A batch stops after 45 minutes at the next case boundary; missing results remain failures. These are execution ceilings, **not approved latency SLOs**. Cleanup reaps only child handles created by the runner, and the network block remains active through async teardown. Normal completion/failure removes only the runner's temporary profile. Forced OS termination cannot guarantee cleanup; inspect the recorded owned PID rather than terminating unrelated apps. An explicit output path is never overwritten.

Native-run failures are expected while MQA-321 is open. A nonzero exit must not be relabeled as a harness failure merely because inference completed. Inspect each `rows[].evaluation`, raw text, `completion`, exact `wire` options, source snapshot and cleanup result. Compare service/runtime health separately from transcript fidelity and useful meeting actions.
