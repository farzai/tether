# Tether: spec (v1)

Status: approved 2026-11-13. Repository: `farzai/tether` (public, MIT). Package: `@farzai/tether`.

## 1. What it is

Tether connects a person's own AI agent to web apps that need AI work done, without the app ever
running or paying for a model.

- A web app (the first is paper.farzai.com) puts **tasks** in a queue for a user.
- **Tether**, a small program the user runs on their own computer, picks up those tasks and runs
  each one as a fresh, short, headless agent session (`claude -p` first), with only the tools the
  task needs.
- The agent sends its results back to the app through the app's MCP server, using a token that
  only works for that one task.
- The user sees and steers everything in the web app. They never type into the agent.

One Tether install can serve several apps at once (paper.farzai.com, later farzai.com and others).

## 2. Why not a long-running agent session

A single interactive session that loops "is there a task?" spends a model turn on every idle poll,
grows its context with each task until compaction blurs the instructions, stops on permission
prompts, and dies with the terminal. Tether polls over plain HTTP (no tokens spent while idle) and
gives each task a clean session with pre-approved tools.

## 3. User experience

```
$ npx @farzai/tether connect https://paper.farzai.com
  Open https://paper.farzai.com/tether/pair and enter code  KQ7M-3XPD
  Waiting for approval... connected as "MacBook (Tether)".
$ npx @farzai/tether start
  paper.farzai.com  online, waiting for tasks
```

- `tether connect <app-url>`: device pairing. The user approves the code on the web page while
  signed in; no token is copied by hand.
- `tether start`: runs in the foreground; `tether service install` installs it as a background
  service (launchd on macOS, systemd user unit on Linux, Task Scheduler on Windows).
- `tether status`, `tether apps`, `tether disconnect <app>`, `tether logs`, `tether doctor`
  (checks the agent CLI is installed and signed in).
- Single binaries for macOS, Linux and Windows from GitHub Releases (`bun build --compile`), plus
  `npx @farzai/tether`. A Homebrew tap later.

## 4. Tether Protocol (HTTP + JSON, versioned)

An app that supports Tether implements these endpoints. Path prefix and version come from
discovery, so the protocol can change without breaking older clients.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/tether` | `{ protocol: "tether/1", app: { name, icon }, endpoints: {...} }` |
| `POST pair/start` | Starts device pairing; returns `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in` (modelled on OAuth device flow, RFC 8628). |
| `POST pair/poll` | Returns `pending`, `denied`, `expired`, or a long-lived **device credential**. |
| `POST heartbeat` | Every 15 s while running: client version, agent adapters available, capacity, current task ids. Drives the app's online / working presence. |
| `POST tasks/claim` | Long poll (up to 30 s). Returns one task or `204`. The app leases it (default 10 min). |
| `POST tasks/{id}/events` | Progress events (stage, message, token usage so far). Renews the lease. |
| `POST tasks/{id}/complete` | Exit status, usage, duration. |
| `POST tasks/{id}/fail` | Reason (`agent_error`, `timeout`, `cancelled_by_user`, `budget`, `policy`). |
| `GET tasks/{id}` | Lets Tether notice a cancel from the web UI (also returned in heartbeat). |

### Task payload

```json
{
  "id": "…",
  "type": "paper.create_child",
  "title": "สร้างการ์ด: ทำไมท้องฟ้าเป็นสีฟ้า",
  "instructions": "markdown: what to do, written by the app",
  "skill": { "name": "paper", "version": "3", "markdown": "…" },
  "input": { "…": "…" },
  "mcp": { "url": "https://paper.farzai.com/mcp", "token": "task-scoped, expires with the lease" },
  "tools": { "requested": ["WebSearch", "WebFetch"] },
  "limits": { "timeout_s": 900, "max_budget_usd": 1.0 }
}
```

### Security model
- The device credential only lets Tether claim and report tasks. Results are written through the
  app's MCP with a **task-scoped token** that expires with the lease and only touches that task.
- **Local policy beats the app.** The app *requests* tools; Tether grants only the intersection with
  the user's local allow-list. Defaults: allow `WebSearch`, `WebFetch` and the app's MCP tools; deny
  `Bash`, every other MCP server, and every file read or write outside the task's temp directory.
  The app's MCP server is the one at the discovery `mcp` URL on the app's own origin; a task naming
  any other MCP URL is refused. An app can never widen this.
- Each task runs in a fresh empty temp directory with isolated settings (no user hooks, no user MCP
  servers, no project `CLAUDE.md`), and the directory is deleted afterwards.
- Only the app's own `instructions` and `skill` reach the agent as instructions. The task `input`
  (where any user-written or web content goes) and anything fetched from the web are passed as
  fenced data; the base prompt Tether adds says that data cannot give instructions.
- Credentials are stored in the OS keychain where available, otherwise in a 0600 file.
- Tether shows which apps are connected and what each task did (`tether logs`), so the user can
  audit what ran on their machine.

## 5. Running a task (Claude Code adapter)

1. Write the task's MCP config (only the app's server, with the task token) to the temp directory.
2. Run `claude -p` with: the instructions and the skill appended as system prompt, the task input
   as the prompt inside a fenced data block, `--output-format stream-json`, `--mcp-config` with `--strict-mcp-config`,
   `--allowedTools` set to the granted tools, `--disallowedTools` for the rest,
   `--max-budget-usd` from the task limit (capped by the user's local cap), and no session
   persistence. Exact flags are verified against the installed Claude Code version by
   `tether doctor`, because CLI flags change between versions.
3. Stream events: map tool calls and assistant messages to short progress lines and forward them;
   forward token usage and cost.
4. Kill the process on timeout, budget, or a cancel from the web UI.
5. Report `complete` or `fail`.

Only the Claude Code adapter ships in v1. Other agents (Codex CLI, Gemini CLI) can be added as
adapters later; the adapter boundary is a plain module, not a plugin system, until a second adapter
exists.

## 6. Concurrency and limits
- Default one task at a time across all apps; configurable (`--concurrency`).
- Local caps per day: number of tasks and total budget (USD), per app and overall.
- Back-off on network errors; resume cleanly after sleep or reboot (leases expire on the app side).

## 7. What lives where
- `farzai/tether`: the CLI, the protocol document (`docs/protocol.md`), and a conformance test
  suite that an app server can run against itself.
- Each app implements the server side itself for now. A shared server library (`@farzai/tether-server`)
  is extracted only when a second app (for example farzai.com) implements the protocol, so it is
  shaped by two real users rather than guessed.

## 8. Quality
- TypeScript on Bun, Biome, Vitest; a fake app server in tests drives claim, lease expiry, cancel,
  budget kill and policy intersection; a fake `claude` binary emits recorded stream-json.
- CI builds binaries for macOS (arm64, x64), Linux (x64, arm64) and Windows (x64) on every tag.
- Releases signed and checksummed; macOS binaries notarised when an Apple Developer account is
  available (until then, document the Gatekeeper prompt).

## 9. Phases
| Phase | Scope |
|---|---|
| T0 | Repo scaffold, protocol doc v1, fake app server, conformance tests |
| T1 | CLI: connect (device pairing), start, status, heartbeat, claim, Claude Code adapter, policy, temp-dir sandbox, cancel, timeout, budget |
| T2 | Background service install, keychain storage, logs, doctor, release pipeline with binaries |
| T3 | Second app and `@farzai/tether-server` extraction; more adapters on demand |

## 10. Open items
- npm scope `@farzai` must be created on npmjs.com by the owner before the first publish.
- Code signing for macOS and Windows binaries.
