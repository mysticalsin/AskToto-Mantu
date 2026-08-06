# macOS ffmpeg Sidecar — Rebuild and Verify

Operator runbook for the one task that cannot be done from a Windows checkout: rebuilding the macOS
ffmpeg sidecar so it is self-contained, and proving it works. Takes about 15 minutes, most of it
waiting on a compile.

Release-process context lives in `ENTERPRISE_RELEASE.md` → "ffmpeg Sidecar Provisioning". This file
is the step-by-step.

## Why this exists

The sidecar that has been shipping links Homebrew's SDL2 by absolute path:

```
/opt/homebrew/opt/sdl2/lib/libSDL2-2.0.0.dylib
```

It is the reviewed binary — its SHA-256 matches `resources/ffmpeg/manifest.json` — but dyld refuses
to load it on any machine that does not have that exact file. Two consequences:

1. CI's `macOS package` job has been red for months.
2. **A macOS build made on a Mac that has Homebrew ships that binary**, so media import dies with
   `Library not loaded` for every user who does not happen to have Homebrew SDL2 installed. It works
   on the machine that built it, which is why it went unnoticed.

The rebuild produces a binary that links nothing outside `/usr/lib` and `/System/Library`.

## Prerequisites

- A Mac with Xcode Command Line Tools (`xcode-select --install`) — needed for `clang`, `otool`,
  `codesign`, `strip`.
- `gh` authenticated against this repo (`gh auth status`).
- Nothing else. The build deliberately uses no Homebrew packages; that is the entire point.

## 1. Pull

```bash
cd <your-checkout>
git checkout main
git pull
```

Everything below is on `main` — the fix is merged.

## 2. See the failure first (optional, 5 seconds)

Worth doing once so you know the gate is real and you can tell a fixed state from a cached one:

```bash
node scripts/check-ffmpeg-sidecar.mjs mac arm64
```

If your checkout still has the old sidecar at `resources/ffmpeg/darwin-arm64/ffmpeg`, this prints:

```
Error: resources/ffmpeg/darwin-arm64/ffmpeg matched the reviewed sha256 but links 1 library that a
clean macOS install does not have: /opt/homebrew/opt/sdl2/lib/libSDL2-2.0.0.dylib. ...
```

If the file is absent, you get an `ENOENT` on that path instead — also fine, step 3 creates it.

## 3. Build

```bash
./scripts/build-ffmpeg-sidecar-mac.sh arm64
```

What it does, in order — each step is a hard failure, so if it finishes, all of these passed:

1. Downloads `ffmpeg-7.1.1.tar.xz` and checks it against the reviewed source SHA-256.
2. Configures LGPL-only (`--disable-gpl --disable-nonfree`) with `--disable-autodetect`, which is
   what stops configure linking whatever it happens to find on your machine.
3. Builds (parallel, a few minutes).
4. Runs `otool -L` on the result and **fails** if anything links outside `/usr/lib` and
   `/System/Library`.
5. Checks the binary reports the LGPL and does not report GPL/nonfree parts.
6. Copies to `resources/ffmpeg/darwin-arm64/ffmpeg`, strips it, and ad-hoc signs it (an arm64 binary
   must carry a signature to execute at all, and `strip` invalidates the linker's).
7. Prints the new SHA-256 and the exact commands for the next two steps.

It runs entirely in a temp dir and cleans up after itself. It refuses to run on anything but macOS.

## 4. Record the hash

Put the printed SHA-256 into `resources/ffmpeg/manifest.json` under `darwin-arm64/ffmpeg`, and make
`configuration` match the `./configure` flags the script used (it now includes
`--disable-autodetect`). The manifest is the reviewed record of how the shipped binary was produced;
a drift between the two is what let a Homebrew-linked binary pass review while the manifest described
a self-contained static build.

## 5. Verify

```bash
node scripts/check-ffmpeg-sidecar.mjs mac arm64
```

Expected — and this time it also runs the binary and reads its licence banner, because the target
now matches the host:

```
[check:ffmpeg] OK — darwin-arm64/ffmpeg (<hash>…)
```

Independent proof it is self-contained, if you want to see it yourself:

```bash
otool -L resources/ffmpeg/darwin-arm64/ffmpeg
```

Every line must start with `/usr/lib/` or `/System/Library/`. Nothing under `/opt/homebrew`,
`/usr/local`, `@rpath`, or `@loader_path`.

## 6. Re-seed the CI asset

CI restores the sidecar from the `ffmpeg-sidecar-v1` release, so the old binary keeps coming back
until you replace the asset:

```bash
cp resources/ffmpeg/darwin-arm64/ffmpeg /tmp/ffmpeg-darwin-arm64
gh release upload ffmpeg-sidecar-v1 /tmp/ffmpeg-darwin-arm64 --clobber
```

`--clobber` is what overwrites the existing asset. Without it the upload fails as a duplicate and CI
silently keeps using the bad one.

## 7. Commit and confirm CI

```bash
git checkout -b fix/mac-ffmpeg-sidecar-rebuild
git commit -am "fix(mac): rebuild the ffmpeg sidecar self-contained"
git push -u origin fix/mac-ffmpeg-sidecar-rebuild
```

`macOS package` should now go green. The workflow caches the sidecar on
`hashFiles('resources/ffmpeg/manifest.json')`, so changing the hash in step 4 invalidates the old
cache by itself — you do not need to clear anything by hand.

## 8. Prove it in the app (the step that actually matters)

CI green only proves the gate passes. Confirm the decoder works end to end:

```bash
npm run dist
```

Then launch the packaged app from `release/` and import a media file (an `.m4a` or `.mp3` meeting
recording is the realistic case). Watch for:

- Import progresses with a real percentage rather than an indeterminate spinner — that means the
  duration probe spawned ffmpeg successfully.
- Transcription produces text.

If ffmpeg were still broken you would see the import fail immediately; the decoder spawns it as the
first thing it does.

Bonus check, closest thing to testing on a machine without Homebrew — confirms the binary that
actually got **bundled**, not just the one in `resources/`:

```bash
# npm run dist:local (output dir is overridden in that script)
otool -L /Users/tony/AI-Brain-build/asktoto-release/mac-arm64/Metis.app/Contents/Resources/ffmpeg/darwin-arm64/ffmpeg

# npm run dist (default output dir)
otool -L release/mac-arm64/Metis.app/Contents/Resources/ffmpeg/darwin-arm64/ffmpeg
```

The bundle is `Metis.app` — `productName` in `electron-builder.yml` is deliberately ASCII even though
everything user-visible says Métis. `electron-builder.yml` maps `resources/ffmpeg` → `ffmpeg`, hence
the path above. If either path has moved, find it rather than guessing (`**` needs
`shopt -s globstar`, and macOS ships bash 3.2, which has no globstar at all):

```bash
find <output-dir> -path '*Resources/ffmpeg*' -name ffmpeg -exec otool -L {} \;
```

Every line of the output must start with `/usr/lib/` or `/System/Library/`.

Two things `dist:local` already does for you: it runs `check-ffmpeg-sidecar.mjs mac arm64` as its
first step, so the portability gate passes before packaging starts, and it finishes with
`check-packaged-runtime.mjs mac … --post-sign`, which inspects what actually landed in the bundle.

## If something goes wrong

- **`configure` fails on a missing dependency** — it should not; `--disable-autodetect` means it
  needs nothing but the toolchain. Check `xcode-select -p` points at a real install.
- **The `otool` check in the script fails** — the build picked something up anyway. Send the printed
  list; the fix is an explicit `--disable-<thing>` for whatever it found.
- **The gate still reports the Homebrew dylib after a rebuild** — you are looking at the old file.
  Confirm `shasum -a 256 resources/ffmpeg/darwin-arm64/ffmpeg` matches what the script printed and
  what you put in the manifest.
- **CI still red after re-seeding** — check the asset actually replaced
  (`gh release view ffmpeg-sidecar-v1`) and that the manifest hash in the pushed commit is the new
  one; a stale `actions/cache` entry cannot survive a manifest change, but an un-clobbered upload can.

## Rollback

Nothing here is destructive to the repo. The only shared state is the `ffmpeg-sidecar-v1` release
asset, and the previous binary is recoverable from any machine that still has it under
`resources/ffmpeg/darwin-arm64/`. Reverting the manifest commit restores the old expected hash.
