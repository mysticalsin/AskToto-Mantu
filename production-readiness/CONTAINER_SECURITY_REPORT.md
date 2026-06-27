# Container Security Report — AskToto

**Reviewer:** senior DevSecOps engineer. **Date:** 2026-06-27.
**Verdict: N/A — there is no container surface in AskToto.** This is an honest, evidence-backed N/A, not a skipped gate.

---

## 1. Why this gate is Not Applicable

AskToto is a **local Electron desktop application** distributed as native installers (macOS `.dmg`/`.zip`, Windows `.nsis`/`.portable`/`.appx`, iOS `.xcodeproj`). It has **no server-side runtime, no container image, and no container orchestration**. There is nothing to build, scan, harden, or run as an OCI image.

### Evidence — no container artifacts exist
```
$ find . -path ./node_modules -prune -o \( -iname 'Dockerfile*' -o -iname '*.dockerfile' \
    -o -iname 'docker-compose*' -o -iname '*.containerfile' \) -print
→ (no output — none found)

$ ls Dockerfile docker-compose.yml
→ (absent)
```
- No `Dockerfile`, no `docker-compose.yml`, no `.dockerignore`, no Containerfile.
- No Kubernetes / Helm manifests. The only `*.yml`/`*.yaml` files in the tree are: `electron-builder.yml`, `.github/workflows/build.yml`, `vitest.config` (ts), `release/*.yml` (electron-updater manifests `latest.yml`/`latest-mac.yml`/`builder-debug.yml`/`app-update.yml`), and `ios/project.yml` — none of which are container or orchestration definitions.
- `package.json` scripts are `electron-vite` + `electron-builder` only (`dev`, `build`, `dist`, `dist:win`, `dist:win:appx`) — no `docker build`/`docker run`/registry push.
- The architecture (confirmed in `production-readiness/ARCHITECTURE.md` and `DATA_FLOW.md`) is a two-process Electron app (hardened main + sandboxed renderer) running entirely on the end-user's machine. No multi-tenant backend, no cluster, no image registry.

---

## 2. The analogous trust boundary that *does* apply

For an Electron app, the conceptual equivalent of "container hardening" is the **process sandbox model**, which is covered in the application-security review, not here. For completeness, the equivalent controls that exist are:
- **asar packaging** (`electron-builder.yml: asar: true`) — app code packed into a single archive (analogous to an image layer). Note the Electron *ASAR Integrity Bypass* advisory applies to the shipped Electron version (see SUPPLY_CHAIN_SECURITY_REPORT.md §3.3).
- **macOS hardened runtime + entitlements** (`build/entitlements.mac.plist`: only `allow-jit`, `allow-unsigned-executable-memory` for the WASM/onnx runtime, and `device.audio-input`) — the OS-sandbox analogue of a container security profile / seccomp.
- **Renderer sandbox** (`contextIsolation` on, `sandbox` on, `nodeIntegration` off, strict CSP in `src/renderer/index.html:9`) — the privilege-drop analogue of running a container as non-root with a read-only FS.

These belong to the app-hardening / runtime-security gates and are evidenced there; they are **not** container controls.

---

## 3. Conditional guidance (only if this ever changes)

If AskToto later grows a server-side component (e.g., a self-hosted update host, a managed-config service, or a telemetry sink) that is containerised, this gate would become applicable and should then require: a pinned minimal base image (distroless/alpine-slim), non-root `USER`, multi-stage build, `trivy`/`grype` image scan in CI, no secrets in layers, read-only root FS, and a signed image (cosign). **None of this is needed for the current desktop-only distribution.**

---

## 4. Finding

- **N/A (justified) — No container/orchestration surface.** `find` for Dockerfiles/compose/k8s returns nothing; distribution is native installers + optional static auto-update host. Gate 7 (Containers) = **N/A**. Re-evaluate only if a containerised backend is introduced.
