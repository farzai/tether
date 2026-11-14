# Claude Code flags and stream-json

What the Claude Code adapter (`src/client/claude-code.ts`) passes to `claude` and what it reads
back. Everything here was checked against **Claude Code 2.1.325**, the version named by
`CLAUDE_CODE_VERSION` in the adapter. A test keeps this page current: every flag the adapter
passes must appear in the table, and the version above must match the adapter's.

When a new Claude Code version changes a flag or a line, update the adapter, this page, the
fixtures in `test/fixtures/claude-code/` and `CLAUDE_CODE_VERSION` in the same pull request. Check
flags with `claude --help`. The adapter does not trust the flags alone: it reads the session's
init line and kills a session that is wider than it asked for.

## Flags

| Flag | Value | Why | Checked on |
|---|---|---|---|
| `-p` | | Print mode: one prompt, no interactive session. | 2.1.325 |
| `--output-format` | `stream-json` | One JSON message per line, read as the task runs. | 2.1.325 |
| `--verbose` | | Required by `stream-json` in print mode. | 2.1.325 |
| `--mcp-config` | a 0600 file in the task's temporary directory | The app's MCP server only, with the task token. | 2.1.325 |
| `--strict-mcp-config` | | Ignore every other MCP configuration. | 2.1.325 |
| `--restricted` | | Remove the built-in features the task does not need. | 2.1.325 |
| `--tools` | the granted built-in tools | The only built-in tools the session has. | 2.1.325 |
| `--allowedTools` | the granted tools and `mcp__app` | Run them without asking. | 2.1.325 |
| `--disallowedTools` | every built-in tool not granted | A second wall behind `--tools`. | 2.1.325 |
| `--permission-mode` | `dontAsk` | Refuse anything not allowed instead of asking. | 2.1.325 |
| `--max-budget-usd` | the lower of the app's and the user's budget | Claude Code stops itself at the budget. | 2.1.325 |
| `--no-session-persistence` | | No session file is left behind. | 2.1.325 |
| `--setting-sources` | empty | No user, project or local settings, hooks or plugins. | 2.1.325 |
| `--disable-slash-commands` | | No skills or slash commands. | 2.1.325 |
| `--append-system-prompt-file` | a 0600 file | Tether's base prompt, the app's instructions and skill. | 2.1.325 |

The task input goes on stdin as a fenced data block. stdout carries stream-json; stderr is read
into a small buffer and only its end is written to the local log, redacted. It never goes to the
app.

## stream-json lines the adapter reads

| Line | Fields read | Use | Checked on |
|---|---|---|---|
| `system` / `init` | `tools`, `mcp_servers`, `plugins`, `skills`, `slash_commands` | Must come first and match the isolated session asked for; otherwise the session is killed and the task fails with `policy`. | 2.1.325 |
| `assistant` | `message.id`, `message.usage`, `message.content` (`text`, `tool_use`) | Progress events and token usage, counted once per message id. | 2.1.325 |
| `assistant` | `error` (`authentication_failed`, `rate_limit`, `billing_error`, `server_error`, and others) | The last one names the cause of a session that ended on an API error. | 2.1.325 |
| `rate_limit_event` | `rate_limit_info.status`, `resetsAt`, `isUsingOverage`, `overageStatus`, `overageResetsAt` | The reset time of a rejected limit (the overage's when the overage was rejected), sent as `retry_at`. | 2.1.325 |
| `result` | `subtype`, `is_error`, `result`, `total_cost_usd`, `api_error_status`, `terminal_reason` | The outcome, the summary, the cost, and whether the session ended on an API error. | 2.1.325 |
| `system` / `api_retry` | not read | Claude Code retries on its own; only the final error counts. | 2.1.325 |

## Outcomes

| Session | Report |
|---|---|
| `result` success, not `is_error`, exit 0 | `complete` |
| `result` subtype `error_max_budget_usd` | `fail`, reason `budget` |
| Ended on an API error: the result has `api_error_status` or `terminal_reason: "api_error"` | `fail`, reason `agent_error`, with a `cause`: the last assistant `error` (`authentication_failed` is `auth_failed`, `rate_limit` is `rate_limit`, `billing_error` is `billing`, `server_error` is `provider_error`), else the status (401 or 403 `auth_failed`, 402 `billing`, 429 `rate_limit`, 5xx `provider_error`) |
| Any other error, or no result line | `fail`, reason `agent_error`, no cause |

An expired login was recorded from Claude Code 2.1.325: it ends with an `assistant` line whose
`error` is `authentication_failed` and `api_error_status` 401, then a `result` with subtype
`success`, `is_error: true` and exit code 1. The rate limit, billing and provider fixtures follow
the same shape, built from Claude Code's SDK message types (`SDKAssistantMessageError`,
`SDKRateLimitEvent`), since those cannot be recorded on demand.

## Known limits

- On Windows a process the agent started can keep running after the agent exits: once the agent
  is gone its pid may belong to another process, so Tether does not run `taskkill` then. Tether
  still stops waiting for its pipes after a short grace.
