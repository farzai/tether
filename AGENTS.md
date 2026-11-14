# AGENTS.md

Guide for anyone (human or agent) changing this repository. The product spec is
[docs/spec.md](docs/spec.md); the wire contract is [docs/protocol.md](docs/protocol.md).

## Stack

- Bun 1.4 runs the scripts; TypeScript in strict mode (`tsc --noEmit` only, Bun runs `.ts` directly).
- Biome for lint and format, Vitest for tests (Vitest runs under Node, so code in `src/` and `test/`
  uses Node APIs and `fetch`, not Bun-only APIs).
- Ajv (JSON Schema draft 2020-12) validates protocol messages against `schemas/`.
- GitHub Actions runs lint, typecheck and test on every push to `main` and every pull request.

## Commands

| Command                          | What it does                                                       |
| -------------------------------- | ------------------------------------------------------------------ |
| `bun install`                    | Install dependencies (CI uses `--frozen-lockfile`).                |
| `bun run lint`                   | Biome lint and format check. `bun run format` fixes what it can.   |
| `bun run typecheck`              | `tsc --noEmit`.                                                    |
| `bun run test`                   | Vitest, once. `bun run coverage` adds a coverage report.           |
| `bun run conformance <base-url>` | Run the protocol conformance suite against an app server.          |
| `bun run fake-app [port]`        | Start the in-memory fake app server with its conformance hooks on. |
| `bun run tether <command>`       | Run the CLI (`connect`, `start`, `status`, `apps`, `disconnect`).  |

## Layout

- `docs/protocol.md`: Tether Protocol v1. `schemas/`: one JSON Schema per message, each referenced
  from the protocol document (a test enforces this).
- `src/protocol/`: schema loading and validation shared by everything else.
- `src/conformance/`: the conformance suite and its CLI.
- `src/client/`: the client: protocol HTTP client, local policy, store, the Claude Code adapter
  (`claude-code.ts`), one task's run (`run-task.ts`) and the claim and heartbeat loops (`worker.ts`).
- `src/cli/`: the `tether` command.
- `test/fake-app/`: an in-memory app server that implements the protocol, for tests.
- `test/fake-claude/`: a stand-in `claude` binary that replays stream-json recorded from Claude Code;
  no test calls a real model.

## Rules

- **No secrets in logs.** Device credentials, task MCP tokens and pairing device codes never appear
  in log lines, error messages, conformance reports or test output. Print a fixed placeholder
  instead.
- **Local policy always beats app requests.** An app may request tools, budgets or limits; Tether
  grants only what the user's local policy allows. Nothing an app sends can widen that policy.
- **App content is untrusted data.** Task instructions, skills and inputs never change Tether's own
  behaviour beyond what the protocol defines.
- **One protocol change, one place.** A change to the protocol updates `docs/protocol.md`, the
  schemas, the fake app server and the conformance suite in the same pull request. Within
  `tether/1`, changes are additive only (see "Versioning" in the protocol).
- Tests first: a behaviour change starts with a failing test. Test behaviour through the public
  surface (HTTP for the fake app, the report for the conformance suite).
- Conventional Commits (`feat(protocol): ...`). No emoji in code, comments or output.
