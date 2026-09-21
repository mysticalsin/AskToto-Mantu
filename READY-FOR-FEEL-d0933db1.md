# READY-FOR-FEEL — d0933db1 (claude/cap4-motion)

Cap2 wake. Product wake phrase is **Hey Métis / Hi Métis** only. Silent ASR mishear aliases exist in
`src/shared/metis-wake.ts` so live speech still arms; they are not the narrative and are not a rename.

Cap4 Appearance `12c295e9` kept. Pack HOLD. No merge, no SHIP. This is a FEEL tip, not a release.

---

## What the live dig found on Totos-Mac

Two separate facts, both true, and only the second is a code defect.

### 1. The binary Tony was testing has no Cap2 ear in it

- `~/Library/Logs/asktoto/main.log` — **zero** occurrences of the string `cap2`, across every session
  in the file, while the same log carries 1745 meeting-path `apple-speech` lines. The Cap2 ear logs
  `[cap2] ...` on any engine verdict, so an ear that was armed at all would have left a trace.
- `/Applications/Metis.app` → `Contents/Resources/app.asar`, dated 2026-09-07: no `cap2-ear`,
  no `you-asr`, no `metisCommandEar`.
- `/private/tmp/metis-1.9.5-final-20260920b/release/mac-universal/Metis.app` → `app.asar`, packed
  today 23:07: same three strings absent.
- Both packs come from the **metis-1.9.5-release-audit** tree, not from `claude/cap4-motion`.

No commit on this branch can make that binary hear "Hey Métis". Any FEEL run has to start from a
build of this branch — see the run steps below.

### 2. The code defect underneath — Parakeet claimed "ready" while it was deaf

`parakeetModelReady()` only proves the model **files** are on disk. On this Mac they are
(`Parakeet and Whisper floor ready`, five times) while the isolated helper cannot load its native
addon at all:

```
[parakeet-host] Could not find sherpa-onnx-node. Tried
  ./node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node
  ...
```
1745 of those warnings in the log.

So the Cap2 gate said "ready", every wake window spawned a host that failed, and main answered the
ear with `{ text: '', error: true }`. The ear read that as **genuine silence, not a broken engine**:
it reset the fail counter on each one, so a permanently deaf Parakeet was never retired and sat in
front of Apple Speech for the whole session, paying a doomed round-trip on every single window.

That is the exact fail-silent mode `metis-command-ear.ts`'s own header says must never happen again.

---

## The fix in d0933db1

Both halves of one root cause. Nothing else touched.

**`src/main/index.ts`**
- New `cap2ParakeetUsable()` — probes `parakeetAddonError()` once per session on top of
  `parakeetModelReady()`, and logs the reason once via `logCap2EngineOnce`.
- `IPC.parakeetFeed`'s Cap2 gate, `IPC.cap2EarPrepare`'s `engines` report, and the boot
  `[cap2] wake engines parakeet=… apple=…` line all read that verdict. An engine that can never
  produce text now reports `unavailable: true` instead of failing silent.

**`src/renderer/src/lib/metis-command-ear.ts`**
- New `feedErrored()`. A resolved `{ error: true }` counts as an engine failure instead of resetting
  the counter, so a repeatedly failing engine retires after `ENGINE_FAIL_MAX` and the cascade reaches
  Apple Speech immediately rather than on every window forever.

**`src/renderer/src/lib/metis-command-ear.contract.test.ts`** — new case locking both halves.

### Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `check:test-types` | **26** known errors — at baseline, not risen |
| `metis-command-ear.contract.test.ts` + `metis-command-boundary.contract.test.ts` | 18 passed |
| `metis-command-session` + `parakeet` + `apple-speech` unit | 23 passed |

`ASKTOTO_CAP2_PROVE` is **not** a pass here. It injects text past the mic and proves nothing about
the ear. The prove below is Tony's own voice.

---

## LIVE PROVE — Tony says "Hey Métis"

**HARD:** never `export ASKTOTO_USERDATA` into the shell that launches a packaged Metis.

### Step 0 — run the right code

```bash
cd /Users/tony/dev/metis-dock-design
git log --oneline -1          # must print d0933db1
npm run dev
```

If you want a packaged run instead, it must be packed **from this worktree**, not from
`/private/tmp/metis-1.9.5-final-20260920b` and not from `metis-1.9.5-release-audit`. Verify before
trusting any FEEL result:

```bash
node -e "const s=require('fs').readFileSync(process.argv[1]).toString('latin1');\
console.log('cap2-ear:',s.includes('cap2-ear'),'you-asr:',s.includes('you-asr'))" \
  <path-to>/Metis.app/Contents/Resources/app.asar
```
Both must print `true`. If either is `false`, stop — that binary cannot wake.

### Step 1 — watch the log

```bash
tail -f ~/Library/Logs/asktoto/main.log | grep --line-buffered "cap2"
```

At boot you must see one line:

```
[cap2] wake engines parakeet=<ready|missing> apple=<ready|missing>
```

On this Mac, with the addon still missing, the honest answer is now
`parakeet=missing apple=ready` (it used to lie with `parakeet=ready`), plus one
`[cap2] wake engine unavailable: parakeet (native addon unavailable: …)`.

If it prints `parakeet=missing apple=missing`, the ear is deaf by construction — the chip says
`Ear on · no ASR engine` and no amount of speaking will wake it. That is a build problem, not a
wake problem.

### Step 2 — mic + ear armed

Open the DevTools console on the overlay renderer.

- `document.documentElement.dataset.metisCommandEar` → `"1"`
- Console shows **no** `[cap2-ear] {state: 'denied'…}` and no `{state: 'error', reason: 'mic-silent'}`.
  `mic-silent` means macOS handed back a track of zeros — grant the mic in System Settings →
  Privacy & Security → Microphone and relaunch.
- The ear chip is visible while armed, even with the Island/Dock parked.

### Step 3 — say it

With the island **parked**, say out loud, normally: **"Hey Métis"**.

Expected, in order:

1. Console: `[cap2-ear] apple Hey Metis` (or `parakeet …` on a Mac where the addon loads).
   The `via` name and the exact spelling may vary — the mishear aliases are silent by design.
2. Log: `[cap2] you-asr apple Hey Metis`
3. The overlay **unparks to a top-center host** (`revealForMetisCommandPill`) — the parked dock must
   not swallow the pill.
4. The pill appears reading **Hi Métis**, then **Hi Métis, I'm listening...**
5. The **ObsidianOrb animates** on the pill.

### Step 4 — the negative that must hold

Say bare **"Métis"** alone. Nothing may happen: no pill, no orb, no unpark. The greeting is
mandatory (`WAKE_RE` requires `hey|hi` + the name).

Then say **"Thank you"** — pill dismisses, double chime, overlay returns to park.

---

## What is still open after this tip

- **The sherpa-onnx addon is genuinely missing from the packaged app on this Mac.** This tip makes
  Métis honest about it and stops the wasted round-trips; it does not install the addon. Until that
  is fixed in packaging, Cap2 wake on this machine rides on Apple Speech alone.
- **Apple Speech returned `No speech detected` on all 1745 meeting-path windows in this log.** Every
  one. If Step 3 above produces `[cap2-ear]` status lines but never any text, that is the next thread
  to pull, and it is an Apple/window-length question, not a wake-regex question. It could not be
  isolated from outside the app — the helper is SIGABRT'd by TCC when spawned from a plain shell,
  so it has to be measured from inside a running Metis.
