# Agent Browser for isolated Métis worktrees

Métis's hosted Agent Browser lane builds the current worktree on disposable macOS and Windows runners, starts a fresh Electron profile, binds CDP to `127.0.0.1`, confirms the CDP browser PID is the process it launched, then checks the composer DOM and diagnostic commands. The report contains only pass/fail fields and synthetic run metadata. It never stores page text, screenshots, request URLs, headers, or bodies.

This lane supplements the existing Playwright lifecycle suite. It is a quick DOM and diagnostic smoke, not proof of audio capture, installer behavior, native Mac history, or physical-device quality.

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

2. Install and run Agent Browser with Node 24. The app remains built with Node 22; Agent Browser is a temporary QA tool, not a Métis dependency. Its QA-only lockfile pins the npm tarball, lifecycle scripts are disabled, and the platform-native release binary is installed only after a SHA-256 check:

   ```sh
   npm run qa:agent-browser:install
   npm run qa:agent-browser:binary
   ```

3. Start the isolated app and attach Agent Browser. The launcher seeds a synthetic, completed-onboarding profile and checks that the selected CDP port belongs to its own Electron process. Add `--keep-open` when an agent needs to continue exploring after the smoke.

   ```sh
   npm run qa:agent-browser -- --port 9231 --keep-open
   ```

   The launcher prints platform-specific environment assignments and an exact CLI command. In a second terminal in that same worktree, paste the printed assignments first, then reuse the printed command prefix with `console`, `errors`, `network requests`, or other Agent Browser commands. This deliberately points the CLI at the same disposable home/profile as the launcher; using the agent's normal home can create a different session store and fail to attach. The environment snippet contains only temporary profile paths, not credentials. Do not share it beyond the active local QA session.

On Windows, use Node 24 for the CLI and an explicit distinct port, for example `9232`. The launcher prints PowerShell assignments and an exact `node.exe` command for that platform. Stop the launcher with Ctrl+C when the agent finishes. It requests Métis's normal quit path and then cleans only its owned process tree and temporary profile.

The smoke report records that the console, page-error, and network commands exited successfully. It does not assert that their output is empty; use the attached CLI session for diagnostic inspection. Never attach to Tony's daily-use app or to an endpoint whose process identity has not been verified. Do not retain raw console or network output in CI artifacts because it can contain meeting content, credentials, or local paths.
