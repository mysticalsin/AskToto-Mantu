# Runbook: update

How a fix reaches an installed Métis, and how to check that the update path is intact. The platform view is in
[`docs/PLATFORM-MAP.md`](../PLATFORM-MAP.md); signing inputs are in [`docs/SIGNING.md`](../SIGNING.md).

## 1. The path

Installed apps poll `latest.yml` (Windows) and `latest-mac.yml` (macOS) on the release feed, the public
`Metis-Releases` repository, with `electron-updater`. The portable Windows build never updates itself. An enterprise fleet
can point at a private generic feed with the managed-config `updateFeedUrl` (`src/main/updater.ts`).

A release is a pushed `v*` tag: `release.yml` builds and signs macOS and Windows, then verifies that the asset set and the
`latest*.yml` sizes and SHA-512 values match the built files before anything is published. **Never push a tag as part of a
docs, QA or feature change.** Tagging is the owner's step.

A candidate that has not been tagged is published as an owner-channel prerelease by `promote-candidate.yml`: never Latest, no
`latest*.yml`, so no installed app updates from it.

## 2. Check the release gates

The metadata gate compares the update files against the built artifacts, the version-parity gate compares the places the
version is written, and the release gate is the pre-release check. They read files and need the built release directory or
release secrets, so this page resolves them and the release job runs them:

```bash verify-dry
node scripts/check-update-metadata.mjs
node scripts/check-version-parity.mjs
node scripts/check-release.mjs
npm run check:update-metadata
npm run check:release
```

## 3. Roll back a bad release

Installed apps take whatever `latest*.yml` on the feed says is newest, so a rollback is a new, higher version that contains
the previous good code, released through the same path. Editing or deleting `latest*.yml` by hand on the feed is not a
rollback: the size and SHA-512 must match the asset, and a mismatch makes every updater refuse it.

## 4. Evidence

A release decision is computed from the evidence registry on the release commit, not asserted; see
`scripts/release/decide.mjs`. What ran in CI is read with `gh run view`:

```bash verify-dry
node scripts/release/decide.mjs --commit HEAD
gh run view
```
