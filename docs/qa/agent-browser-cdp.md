# CDP smoke for isolated Métis worktrees

The hosted smoke builds the current worktree on disposable macOS and Windows runners, starts a fresh Electron profile, binds CDP to `127.0.0.1`, confirms the CDP browser PID is the process it launched, then checks the composer DOM, diagnostic access, and clean shutdown. macOS uses Vercel Agent Browser CLI 0.39.0. Windows uses the app's pinned Playwright CDP client: both Windows CLI variants repeatedly hung during connect or snapshot in hosted runs, so that adapter exercises equivalent DOM, page-error, console, and network-event access without masking the CLI failure. The report identifies the driver and contains only pass/fail fields and synthetic run metadata. It never stores page text, screenshots, request URLs, headers, or bodies.

This lane supplements the existing Playwright lifecycle suite. It is a quick DOM and diagnostic smoke, not proof of audio capture, installer behavior, native Mac history, or physical-device quality. The Windows fallback proves Playwright can observe all three diagnostic event types using synthetic events; it does not claim the Agent Browser CLI works on Windows.

Windows CI also runs a readable-main diagnostic build beside the normal bytecode build, with temporary source maps to pinpoint app-local startup exceptions. It disables main-process bytecode only in that disposable smoke runner so a startup failure can be attributed to bytecode loading or the application main process. This diagnostic build is never packaged or released and does not change the production configuration.

## Run an isolated agent session

Use one Git worktree per coding agent and assign a different unused port to every concurrently running Métis instance. CDP is privileged, so keep it on loopback, never tunnel it to the public internet, and use a fresh test profile. Do not enable CDP in production app startup.

Example worktree setup:

```sh
git worktree add ../AskToto-agent-a -b codex/agent-a
git worktree add ../AskToto-agent-b -b codex/agent-b
```

In each worktree, start only its own smoke instance with its own port (for example 9231 and 9232). Never let two agents share a profile, CLI session name, or port.

1. Build the app from that worktree with the project's pinned Node 22 runtime:

   ```sh
   npm ci
   npm run build
   ```

2. On macOS, install and run Agent Browser with Node 24. The app remains built with Node 22; Agent Browser is a temporary QA tool, not a Métis dependency. Its QA-only lockfile pins the npm tarball, lifecycle scripts are disabled, and the platform-native release binary is installed only after a SHA-256 check:

   ```sh
   npm run qa:agent-browser:install
   npm run qa:agent-browser:binary
   ```

3. Start the isolated app and attach Agent Browser. The launcher seeds a synthetic, completed-onboarding profile and checks that the selected CDP port belongs to its own Electron process. Add `--keep-open` when an agent needs to continue exploring after the smoke.

   ```sh
   npm run qa:agent-browser -- --port 9231 --keep-open
   ```

   The launcher reads Electron's `/json/version` response, validates that its browser WebSocket is on `127.0.0.1` and the requested port, then connects the CLI to that URL once. It gives the CLI a dedicated short socket directory inside the disposable profile, avoiding dependence on the user's normal Agent Browser session or a long default socket path. The launcher prints platform-specific environment assignments and an exact CLI command. In a second terminal in that same worktree, paste the printed assignments first, then reuse the printed command prefix with `snapshot -i`, `console`, `errors`, `network requests`, or other Agent Browser commands. This deliberately points the CLI at the same disposable home/profile as the launcher; using the agent's normal home can create a different session store and fail to attach. The environment snippet contains only temporary profile paths and a loopback CDP URL, not credentials. Do not share it beyond the active local QA session.

On Windows, run the launcher under the app's pinned Node 22 runtime with a distinct port, for example `9232`:

```sh
node scripts/qa/agent-browser-smoke.mjs --port 9232 --keep-open
```

The launcher uses Playwright directly over the verified loopback CDP connection, prints the connection address, and keeps the isolated app alive until Ctrl+C. It requests Métis's normal quit path and then cleans only its owned process tree and temporary profile. Do not treat this as a successful Agent Browser CLI run; the driver is stated in the report.

The report records successful Agent Browser reads on macOS or successful synthetic event probes on Windows. It proves diagnostic access, not that the app has no errors; raw event output is never retained. Never attach to Tony's daily-use app or to an endpoint whose process identity has not been verified. Do not retain raw console or network output in CI artifacts because it can contain meeting content, credentials, or local paths.
