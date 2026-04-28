# ProofShot CLI

Visual verification tool for AI coding agents. Records browser sessions, captures screenshots, collects errors, and bundles proof artifacts.

## Using ProofShot on projects

### Install

```bash
npm install -g proofshot        # global install
proofshot install                # installs skill files for Claude Code, Cursor, etc.
```

For Electron/CDP recording, also install: `npm install -g playwright-core`

### Standard flow (web apps)

```bash
# 1. Start — opens headless Chromium, starts recording
proofshot start --run "npm run dev" --description "verify login flow"
# or if dev server is already running:
proofshot start --url http://localhost:3000 --description "verify login flow"

# 2. Interact
proofshot exec snapshot -i                # list interactive elements
proofshot exec click @e3                  # click element by ref
proofshot exec fill @e2 "hello@test.com"  # fill input
proofshot exec screenshot step-1.png      # capture screenshot
proofshot exec navigate /dashboard        # go to route
proofshot exec key Escape                 # press key

# 3. Stop — bundles video, screenshots, error report, viewer
proofshot stop

# 4. (Optional) Post to GitHub PR
proofshot pr
```

### Electron / CDP flow

For Electron apps or any browser started with `--remote-debugging-port`:

```bash
# Start your Electron app with CDP enabled
# e.g. electron-vite dev -- --remote-debugging-port=9333

# Connect proofshot to the running app
proofshot start --cdp http://localhost:9333 --description "verify feature"

# Same exec commands — but now inside the real Electron process (IPC works)
proofshot exec snapshot -i
proofshot exec click @e2
proofshot exec screenshot dialog.png

# Stop — video is recorded via Playwright screencast daemon
proofshot stop
```

### Key differences: `--url` vs `--cdp`

| | `--url` | `--cdp` |
|---|---|---|
| Browser | ProofShot's headless Chromium | Your running Electron/Chrome |
| IPC/native APIs | Not available | Works (real Electron process) |
| Recording | agent-browser Playwright | Screencast daemon (VP8) |
| Video trim | ffmpeg auto-trim | No trim (VP8 from screencast) |
| App state | Fresh (no persisted data) | Real (your actual app data) |

### Artifacts

After `proofshot stop`, find everything in `proofshot-artifacts/<session>/`:

- `viewer.html` — standalone HTML viewer with video + timeline + screenshots
- `session.webm` — full session video
- `*.png` — screenshots taken during session
- `SUMMARY.md` — markdown report with error counts
- `session-log.json` — timestamped action log

### Tips

- Always `proofshot exec snapshot -i` before clicking — refs change between snapshots
- Use `--force` to override a stale session if a previous run crashed
- `proofshot clean` removes all artifacts
- `proofshot doctor` inspects environment and active session state

## Development

### Quick reference

```bash
npm run build          # Build with tsup (must run after changes)
npm test               # Run vitest once
npm run dev            # Watch mode build
```

## Architecture

```
src/
├── cli.ts                  # Commander.js command registration
├── commands/               # One file per CLI command (install, start, stop, exec, diff, pr, clean)
├── browser/                # agent-browser CLI wrappers (session, capture, interact, navigate)
├── server/                 # Dev server detection, startup, port waiting
├── session/state.ts        # .session.json lifecycle (save/load/clear)
├── session/metadata.ts     # Persistent per-session metadata (branch, commit) for PR matching
├── artifacts/              # Output generation (viewer.html, SUMMARY.md, PR format)
└── utils/                  # Config, exec helpers, port utils, error patterns, GitHub API
```

**Entry point:** `bin/proofshot.ts` → `src/cli.ts` → `src/commands/*.ts`

## Key conventions

- **ESM only** — all imports MUST use `.js` extensions: `import { foo } from '../utils/config.js'`
- **Build before test** — CLI runs from `dist/`, always `npm run build` after code changes
- **agent-browser** — external peer dependency (Rust CLI + Node daemon). All browser commands go through `ab()` in `utils/exec.ts` which calls `agent-browser <command>` via `execSync`
- **Session state** — `start` writes `.session.json`, `exec` and `stop` read it. `stop` clears it. Don't assume session exists without checking
- **Session metadata** — `start` writes `metadata.json` inside each session folder with git branch/commit. This persists after `stop` and is used by `pr` to match sessions to branches
- **Per-session subfolders** — artifacts go in `proofshot-artifacts/YYYY-MM-DD_HH-mm-ss_slug/`

## Command lifecycle

1. `proofshot start` — spawns dev server, opens browser, starts recording, saves session state + writes `metadata.json` with git branch/commit
2. `proofshot exec <args>` — logs action to `session-log.json`, forwards to `agent-browser`
3. `proofshot stop` — collects errors, stops recording, trims video, generates SUMMARY.md + viewer.html, clears session
4. `proofshot pr [number]` — finds sessions for current branch, uploads artifacts to GitHub, posts PR comment

## Adding a new command

1. Create `src/commands/mycommand.ts` with `export async function mycommandCommand(options): Promise<void>`
2. Register in `src/cli.ts` with `program.command('mycommand')...`
3. Export from `src/index.ts` if it should be part of the public API

## Adding error patterns for a new language

Edit `src/utils/error-patterns.ts` — add a new entry to the `PATTERNS` array:

```typescript
{
  name: 'Swift',
  patterns: [
    /Fatal error:/,
    /Thread \d+: signal SIGABRT/,
  ],
},
```

## Session artifacts

| File | Created by | Contains |
|---|---|---|
| `metadata.json` | `start` | Git branch, commit SHA, timestamp (persists after stop) |
| `session.webm` | `start` | Video recording (Playwright screencast) |
| `session-log.json` | `exec` (appended each call) | Action timeline with relative timestamps |
| `server.log` | `start` (piped stdout+stderr) | All dev server output |
| `console-output.log` | `stop` | Browser console output |
| `step-*.png` | `exec screenshot` | Screenshots at key moments |
| `SUMMARY.md` | `stop` | Markdown report with errors and screenshots |
| `viewer.html` | `stop` | Standalone HTML viewer with video + timeline |

## Versioning & releases

- **Automatic** — merging to `main` triggers semantic-release via GitHub Actions
- **Never manually edit `version` in package.json** — semantic-release handles it
- **Conventional Commits** determine the version bump:
  - `feat:` → minor (0.1.0 → 0.2.0)
  - `fix:`, `perf:`, `refactor:` → patch (0.2.0 → 0.2.1)
  - `feat!:` or `BREAKING CHANGE:` footer → major (0.2.1 → 1.0.0)
  - `docs:`, `style:`, `chore:`, `test:`, `ci:` → no release
- **Commit format:** `type(scope): description` — e.g. `feat(cli): add diff command`, `fix(viewer): correct timestamp offset`
- **Branch naming:** `AmElmo/<descriptive-name>`

## Gotchas

- `proofshot exec` has special shell quoting logic (`buildShellCommand` in exec.ts) — `eval` commands get single-quoted, args with special chars get auto-quoted
- Video trimming adjusts session-log.json timestamps to match the trimmed video (see `trimOffsetSec` in stop.ts)
- Server log capture only works when proofshot starts the server itself — if the port is already occupied, we skip spawning and get no server logs
- The `consoleErrors`/`consoleOutput` from agent-browser are point-in-time snapshots collected at stop time
