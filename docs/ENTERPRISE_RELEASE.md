# Release build requirements

Public source-version reference; no release authorization, private account status or qualification claim. Preserve manifest hashes, architecture-specific native payloads, update compatibility, provenance and fail-closed gates. Missing evidence, unexplained skips or failed acceptance block qualification.

## ffmpeg Sidecar Provisioning

The tracked `resources/ffmpeg/manifest.json` and LGPL license define the reviewed binaries. CI restores binaries from the `ffmpeg-sidecar-v1` release and verifies them against the manifest; a cache hit is not a substitute for verification. All three platform assets are required. The following documents the complete seed operation for a separately authorized release operator; it is not a command to execute during development:

```bash
cp resources/ffmpeg/darwin-arm64/ffmpeg /tmp/ffmpeg-darwin-arm64
cp resources/ffmpeg/darwin-x64/ffmpeg /tmp/ffmpeg-darwin-x64
cp resources/ffmpeg/win32-x64/ffmpeg.exe /tmp/ffmpeg-win32-x64.exe
gh release create ffmpeg-sidecar-v1 \
  /tmp/ffmpeg-darwin-arm64 /tmp/ffmpeg-darwin-x64 /tmp/ffmpeg-win32-x64.exe \
  resources/ffmpeg/manifest.json resources/ffmpeg/LICENSE.LGPL-2.1.txt \
  --repo <owner>/<repo> --title "ffmpeg sidecar v1" \
  --notes "Reviewed LGPL-only binaries; verify against manifest.json."
```

Do not replace missing assets with arbitrary downloaded binaries or delete the verification gate. Build macOS assets from the reviewed source using `scripts/build-ffmpeg-sidecar-mac.sh arm64` and `scripts/build-ffmpeg-sidecar-mac.sh x64` on an authorized build host. The x64 cross-build on Apple Silicon needs `nasm` and Rosetta 2 for the executable verification step. The build verifies the source hash, disables GPL/nonfree/autodetected dependencies and checks for non-system dylibs. Preserve that portability check and the packaged hash checks. See [macOS sidecar rebuild](MAC_SIDECAR_REBUILD.md).

## Managed configuration

Verify actual paths and implemented policy keys against this source version; public templates do not authorize or enact controls.

## Customer Control Proof

MQA-068: `LICENSE_ENFORCEMENT = false` and `LICENSE_UI_ENABLED = false`; the device license gate is compiled off. A setting or separately deployed service does not activate these compiled-out paths. Do not advertise activation, seats or revocation as installed-app controls.

## Store Caveat

Distribution channels need separate platform qualification. Preserve original release bytes and provenance privately; rewritten source is not a new attestation for old binaries. Test packaged macOS/Windows lifecycle, encrypted upgrade, preservation, recovery, rollback and security before claiming readiness.

The source-defined Windows machine policy path is `%ProgramData%\Métis\managed-config.json`; verify trusted administrator ownership and only implemented keys.
