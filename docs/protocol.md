# Tether Protocol v1

Status: v1, `tether/1`. Product context: [spec.md](spec.md).

The Tether Protocol is the HTTP + JSON contract between an **app server** (a web app that queues AI
tasks for its users, such as paper.farzai.com) and the **Tether client** (the program a user runs on
their own computer). The client discovers the app, pairs a device, sends heartbeats, claims tasks,
reports progress, and reports the outcome. The app never runs a model.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

Every message has a JSON Schema (draft 2020-12) in [`schemas/v1/`](../schemas/v1/). The schemas are
the normative definition of each message; the examples here are checked against them by the test
suite. Shared definitions (timestamps, ids, usage, lease) live in
[`schemas/v1/common.json`](../schemas/v1/common.json).

## Contents

1. [Conventions](#1-conventions)
2. [Discovery](#2-discovery)
3. [Authentication](#3-authentication)
4. [Device pairing](#4-device-pairing)
5. [Heartbeat](#5-heartbeat)
6. [Tasks and leases](#6-tasks-and-leases)
7. [Claim](#7-claim)
8. [Events](#8-events)
9. [Complete](#9-complete)
10. [Fail](#10-fail)
11. [Task status and cancel](#11-task-status-and-cancel)
12. [State table](#12-state-table)
13. [Errors](#13-errors)
14. [Versioning](#14-versioning)
15. [Security](#15-security)
16. [Conformance testing](#16-conformance-testing)
17. [Schema index](#17-schema-index)

## 1. Conventions

- Requests and responses are JSON (`Content-Type: application/json`, UTF-8). A response with no body
  uses `204 No Content`.
- Timestamps are RFC 3339 strings in UTC, for example `2026-11-13T02:00:00Z`.
- Ids are opaque strings of 1 to 200 characters. Clients MUST NOT parse them.
- Durations carry their unit in the field name: `_s` for seconds, `_ms` for milliseconds.
- **Unknown fields are ignored.** A receiver MUST ignore fields it does not know, in requests and in
  responses. The schemas therefore leave objects open (no `additionalProperties: false`).
- Clients send `User-Agent: tether/<version>`.
- Servers MUST use HTTPS, except on `localhost`, `127.0.0.1` and `::1` for development and tests.

## 2. Discovery

`GET /.well-known/tether` on the app's origin returns the discovery document
([`schemas/v1/discovery.json`](../schemas/v1/discovery.json)). The client fetches it when the user
connects an app and again on each start; it MUST NOT hard-code endpoint paths.

<!-- example: discovery -->
```json
{
  "protocol": "tether/1",
  "app": { "name": "Paper", "icon": "https://paper.example/icon.png", "url": "https://paper.example" },
  "endpoints": {
    "pair_start": "/tether/v1/pair/start",
    "pair_poll": "/tether/v1/pair/poll",
    "heartbeat": "/tether/v1/heartbeat",
    "claim": "/tether/v1/tasks/claim",
    "task": "/tether/v1/tasks/{id}",
    "task_events": "/tether/v1/tasks/{id}/events",
    "task_complete": "/tether/v1/tasks/{id}/complete",
    "task_fail": "/tether/v1/tasks/{id}/fail"
  }
}
```

- `protocol` is `tether/1`. A v1 client MUST refuse any other value.
- Each endpoint is either an absolute path (starting with `/`), resolved against the app's origin,
  or an absolute URL on the **same origin** as the discovery document. A client MUST refuse an
  endpoint on another origin, so the device credential is never sent to a third party.
- `{id}` is replaced with the URL-encoded task id.
- `conformance` is present only on a server in test mode (see
  [Conformance testing](#16-conformance-testing)).

| Key | Method | Purpose | Auth |
|---|---|---|---|
| `pair_start` | POST | Start device pairing | none |
| `pair_poll` | POST | Poll pairing result | none |
| `heartbeat` | POST | Presence, capacity, cancel notices | device |
| `claim` | POST | Long-poll for one task | device |
| `task` | GET | Task status (notice a cancel) | device |
| `task_events` | POST | Progress events, lease renewal | device |
| `task_complete` | POST | Report success | device |
| `task_fail` | POST | Report failure | device |

## 3. Authentication

Every endpoint except discovery and pairing requires the device credential from pairing:

```
Authorization: Bearer <device credential>
```

- A missing, unknown or revoked credential gets `401 unauthorized`. The client MUST stop using that
  credential and ask the user to pair again; it MUST NOT retry with the same credential in a loop.
- The credential only lets the client claim and report the tasks of the user who approved the
  device. It never grants access to the user's data in the app; results go through the app's MCP
  server with the task's own token (see [Security](#15-security)).
- A task that does not belong to the credential's user is answered exactly like a task that does
  not exist: `404 not_found`. Task ids cannot be probed.

## 4. Device pairing

Pairing follows the shape of the OAuth 2.0 Device Authorization Grant (RFC 8628) without its form
encoding or token endpoint: it is JSON-first, and every known pairing state is a `200` with a
`status`, so a client needs one code path for polling. The user approves the device on the app's web
page while signed in; no credential is ever typed or copied by hand.

### pair/start

`POST pair_start` with [`schemas/v1/pair-start.request.json`](../schemas/v1/pair-start.request.json):

<!-- example: pair-start.request -->
```json
{ "client": { "name": "tether", "version": "0.1.0" }, "device_name": "MacBook (Tether)" }
```

Response `200` with [`schemas/v1/pair-start.response.json`](../schemas/v1/pair-start.response.json):

<!-- example: pair-start.response -->
```json
{
  "device_code": "dc_7f3a9b2c4d5e6f708192a3b4",
  "user_code": "KQ7M-3XPD",
  "verification_uri": "https://paper.example/tether/pair",
  "verification_uri_complete": "https://paper.example/tether/pair?code=KQ7M-3XPD",
  "interval": 5,
  "expires_in": 600
}
```

- `device_code` is a secret known only to the client. `user_code` is short, easy to read aloud and
  type, and shown to the user with `verification_uri`.
- `interval` is the minimum number of seconds between polls; `expires_in` is how long the codes live.

### pair/poll

`POST pair_poll` with [`schemas/v1/pair-poll.request.json`](../schemas/v1/pair-poll.request.json):

<!-- example: pair-poll.request -->
```json
{ "device_code": "dc_7f3a9b2c4d5e6f708192a3b4" }
```

Response `200` with [`schemas/v1/pair-poll.response.json`](../schemas/v1/pair-poll.response.json),
one of:

<!-- example: pair-poll.response -->
```json
{ "status": "pending" }
```

<!-- example: pair-poll.response -->
```json
{
  "status": "approved",
  "device": { "id": "dev_01", "name": "MacBook (Tether)" },
  "credential": "tdc_9b1f0c2e7a4d4f1e8c3b6a5d2e1f0a9b"
}
```

| `status` | Meaning | Client action |
|---|---|---|
| `pending` | The user has not answered yet. | Poll again after `interval` seconds. |
| `denied` | The user refused this device. | Stop; tell the user. |
| `expired` | `expires_in` passed without an answer. | Stop; start pairing again. |
| `approved` | The device is paired. | Store `credential` securely; pairing is done. |

- Polling sooner than `interval` gets `429 slow_down` with `Retry-After`; the client MUST then add 5
  seconds to its interval, as in RFC 8628.
- An unknown `device_code` gets `404 not_found`.
- **A lost response is safe.** After approval, polling with the same `device_code` returns the same
  `approved` body (the same credential) until `expires_in` passes. After that it returns `expired`.

## 5. Heartbeat

The client sends a heartbeat every `heartbeat_interval_s` seconds (15 by default, before the first
response) while it runs. The app uses it to show the device as online or working.

`POST heartbeat` with [`schemas/v1/heartbeat.request.json`](../schemas/v1/heartbeat.request.json):

<!-- example: heartbeat.request -->
```json
{
  "client": { "name": "tether", "version": "0.1.0" },
  "adapters": [{ "name": "claude-code", "version": "2.1.0" }],
  "capacity": { "max": 1, "available": 0 },
  "tasks": ["tsk_42"]
}
```

- `adapters` lists the agent CLIs the client can run. `capacity` is how many tasks it runs at once
  and how many more it can take now. `tasks` lists the ids it is running for this app.

Response `200` with [`schemas/v1/heartbeat.response.json`](../schemas/v1/heartbeat.response.json):

<!-- example: heartbeat.response -->
```json
{ "server_time": "2026-11-13T02:00:00Z", "heartbeat_interval_s": 15, "cancelled": ["tsk_42"] }
```

- `cancelled` lists the ids from `tasks` that the user has cancelled. The client MUST stop those
  tasks (see [Task status and cancel](#11-task-status-and-cancel)).
- `heartbeat_interval_s` lets the app slow heartbeats down; the client uses the latest value.

## 6. Tasks and leases

A **task** is one unit of AI work the app has queued for a user
([`schemas/v1/task.json`](../schemas/v1/task.json)):

<!-- example: task -->
```json
{
  "id": "tsk_42",
  "type": "paper.create_child",
  "title": "Create card: why is the sky blue",
  "created_at": "2026-11-13T01:59:00Z",
  "instructions": "Write a child card for the selected note. Use the paper MCP tools to save it.",
  "skill": { "name": "paper", "version": "3", "markdown": "# Paper skill\n..." },
  "input": { "parent_id": "note_7" },
  "mcp": { "url": "https://paper.example/mcp", "token": "mcp_task_token_example" },
  "tools": { "requested": ["WebSearch", "WebFetch"] },
  "limits": { "timeout_s": 900, "max_budget_usd": 1.0 }
}
```

- `instructions`, `skill.markdown` and `input` are written by the app and are **untrusted data** to
  the client.
- `mcp.token` is a **task-scoped token**: it only touches this task in the app, and it stops working
  when the task's lease ends or the task reaches a terminal state.
- `tools.requested` is a request, not a grant. The client grants only the intersection with the
  user's local policy (see [Security](#15-security)).
- `limits` are the app's limits; the client MAY apply lower local limits and never higher ones.

A **lease** gives one device the right to run one attempt of a task. A claim creates a lease:

```json
{ "id": "lse_8", "expires_at": "2026-11-13T02:10:00Z", "duration_s": 600 }
```

- The default lease is 600 seconds. The client renews it with [events](#8-events), at least every
  `duration_s / 3` seconds, even when nothing happened (an empty `events` list). A renewal also
  extends the task's MCP token.
- **A lease stays current until another claim takes the task.** When a lease expires the task becomes
  claimable again, but a slow report on the expired lease is still accepted as long as nobody has
  claimed the task since. Once a new claim takes the task, every call with the old lease gets
  `409 lease_lost`.
- **Delivery is at least once.** A lost claim response or an expired lease can run a task twice. Apps
  MUST make the writes a task does through MCP safe to repeat, and MAY fail a task after a number of
  attempts (`attempt` in the claim response counts them).

Task statuses ([`common.json`](../schemas/v1/common.json) `task_status`):

| Status | Meaning |
|---|---|
| `queued` | Waiting for a claim. Includes a task whose lease expired. |
| `leased` | A device holds a live lease. |
| `completed` | Terminal. The client reported success. |
| `failed` | Terminal. The client reported failure (or the app gave up after N attempts). |
| `cancelled` | Terminal. The user cancelled it in the app. |

Terminal statuses never return to `queued`.

## 7. Claim

`POST claim` with [`schemas/v1/claim.request.json`](../schemas/v1/claim.request.json):

<!-- example: claim.request -->
```json
{ "wait_s": 30 }
```

- This is a **long poll**: if no task is claimable, the server holds the request up to `wait_s`
  seconds (0 to 30) and answers as soon as a task becomes claimable. The server MAY answer `204`
  earlier (for example behind a proxy with a shorter timeout); the client simply claims again.
- The client claims only when it has free capacity.

Response `204` when there is nothing to do, or `200` with
[`schemas/v1/claim.response.json`](../schemas/v1/claim.response.json):

<!-- example: claim.response -->
```json
{
  "task": {
    "id": "tsk_42",
    "type": "paper.create_child",
    "title": "Create card: why is the sky blue",
    "instructions": "Write a child card for the selected note.",
    "mcp": { "url": "https://paper.example/mcp", "token": "mcp_task_token_example" },
    "tools": { "requested": ["WebSearch"] },
    "limits": { "timeout_s": 900, "max_budget_usd": 1.0 }
  },
  "lease": { "id": "lse_8", "expires_at": "2026-11-13T02:10:00Z", "duration_s": 600 },
  "attempt": 1
}
```

- The server hands out the oldest claimable task of the credential's user and leases it to this
  device. One claim returns at most one task.

## 8. Events

`POST task_events` with [`schemas/v1/task-events.request.json`](../schemas/v1/task-events.request.json):

<!-- example: task-events.request -->
```json
{
  "lease_id": "lse_8",
  "events": [
    { "at": "2026-11-13T02:00:05Z", "stage": "started", "message": "Running claude-code" },
    { "at": "2026-11-13T02:00:20Z", "stage": "tool", "message": "WebSearch: why is the sky blue" },
    {
      "at": "2026-11-13T02:00:40Z",
      "stage": "usage",
      "usage": { "input_tokens": 5120, "output_tokens": 830, "cost_usd": 0.04 }
    }
  ]
}
```

- `stage` is a short label; v1 clients send `started`, `tool`, `message` and `usage`. Apps MUST
  accept other values. `message` is a short line for the user, at most 2000 characters. `usage` is
  the running total so far.
- An empty `events` list only renews the lease. At most 100 events per call.
- Events MUST NOT contain secrets (credentials, tokens, environment values).

Response `200` with [`schemas/v1/task-events.response.json`](../schemas/v1/task-events.response.json):

<!-- example: task-events.response -->
```json
{ "status": "leased", "lease": { "id": "lse_8", "expires_at": "2026-11-13T02:10:40Z", "duration_s": 600 } }
```

<!-- example: task-events.response -->
```json
{ "status": "cancelled" }
```

- `leased` carries the renewed lease. `cancelled` means the user cancelled the task: the client MUST
  stop the agent and report it (see [Task status and cancel](#11-task-status-and-cancel)).

## 9. Complete

`POST task_complete` with
[`schemas/v1/task-complete.request.json`](../schemas/v1/task-complete.request.json):

<!-- example: task-complete.request -->
```json
{
  "lease_id": "lse_8",
  "exit_code": 0,
  "duration_ms": 41250,
  "usage": { "input_tokens": 9800, "output_tokens": 1600, "cost_usd": 0.07 },
  "summary": "Created 1 card."
}
```

Response `200` with [`schemas/v1/task-complete.response.json`](../schemas/v1/task-complete.response.json):

<!-- example: task-complete.response -->
```json
{ "status": "completed" }
```

- **Idempotent per lease.** Repeating `complete` with the same `lease_id` after it succeeded returns
  `200` with the same body, so a client that lost the response can retry safely.
- `complete` on a task that was cancelled returns `200 {"status": "cancelled"}`: the app keeps the
  cancel, and the client has nothing more to do.
- `complete` on a task this lease already failed returns `409 invalid_state`.

## 10. Fail

`POST task_fail` with [`schemas/v1/task-fail.request.json`](../schemas/v1/task-fail.request.json):

<!-- example: task-fail.request -->
```json
{
  "lease_id": "lse_8",
  "reason": "timeout",
  "message": "Stopped after 900 s",
  "duration_ms": 900000,
  "usage": { "input_tokens": 20000, "output_tokens": 3000, "cost_usd": 0.31 }
}
```

| `reason` | Meaning |
|---|---|
| `agent_error` | The agent exited with an error or produced no result. |
| `timeout` | The task ran past its time limit and was stopped. |
| `cancelled_by_user` | The client stopped the task because the user cancelled it. |
| `budget` | The task reached its budget limit (the app's or the user's local cap). |
| `policy` | The user's local policy refused the task (for example a tool it cannot run without). |

Response `200` with [`schemas/v1/task-fail.response.json`](../schemas/v1/task-fail.response.json):

<!-- example: task-fail.response -->
```json
{ "status": "failed" }
```

- Idempotent per lease, like `complete`. `fail` on a cancelled task returns
  `200 {"status": "cancelled"}`. `fail` on a task this lease already completed returns
  `409 invalid_state`.
- `message` MUST NOT contain secrets.

## 11. Task status and cancel

`GET task` returns [`schemas/v1/task-status.response.json`](../schemas/v1/task-status.response.json):

<!-- example: task-status.response -->
```json
{ "id": "tsk_42", "status": "leased", "attempts": 1, "lease_expires_at": "2026-11-13T02:10:40Z" }
```

- `attempts` counts claims so far. `lease_expires_at` is present while the task is `leased`.

**Cancel** is a user action in the app's web page, not a client call. The app marks the task
`cancelled`. The client learns about it from whichever comes first:

1. the heartbeat response's `cancelled` list,
2. an events response with `status: "cancelled"`,
3. `GET task` showing `cancelled`.

The client then MUST stop the agent process and SHOULD report `fail` with `cancelled_by_user`; the
app answers `200 {"status": "cancelled"}`. The task's MCP token stops working when the task is
cancelled, so a still-running agent cannot write more results.

## 12. State table

How each call changes a task. `L` is the lease named in the request. "Current" means `L` is the
task's latest lease (it may have expired, see [Tasks and leases](#6-tasks-and-leases)).

| Task state | claim | events (L current) | complete (L current) | fail (L current) | any report, L not current | user cancels |
|---|---|---|---|---|---|---|
| `queued`, never leased | leases it, `attempt` 1 | n/a | n/a | n/a | `409 lease_lost` | `cancelled` |
| `queued`, lease expired | new lease, `attempt` + 1 | renews, back to `leased` | `completed` | `failed` | `409 lease_lost` | `cancelled` |
| `leased` | not offered | renews, `200 leased` | `completed` | `failed` | `409 lease_lost` | `cancelled` |
| `completed` by L | not offered | `409 invalid_state` | `200` same body | `409 invalid_state` | `409 lease_lost` | no change |
| `failed` by L | not offered | `409 invalid_state` | `409 invalid_state` | `200` same body | `409 lease_lost` | no change |
| `cancelled` | not offered | `200 cancelled` | `200 cancelled` | `200 cancelled` | `409 lease_lost` | no change |

- A cancelled task that was never leased answers every report with `409 lease_lost`, because no lease
  of it exists.
- A task of another user, or an unknown id, is `404 not_found` before any of the above.

## 13. Errors

An error response has a 4xx or 5xx status and the body
[`schemas/v1/error.json`](../schemas/v1/error.json):

<!-- example: error -->
```json
{ "error": { "code": "lease_lost", "message": "The task was claimed again after this lease expired." } }
```

| Code | HTTP | Meaning | Client action |
|---|---|---|---|
| `invalid_request` | 400 | The body is not valid JSON or does not match the schema. | Do not retry the same request; log it (without secrets). |
| `unauthorized` | 401 | Credential missing, unknown or revoked. | Stop; ask the user to pair again. |
| `not_found` | 404 | Unknown task, unknown device code, or not yours. | Drop the task. |
| `invalid_state` | 409 | The call conflicts with the task's terminal state. | Drop the task. |
| `lease_lost` | 409 | The lease is no longer current. | Stop the agent; drop the task. |
| `slow_down` | 429 | Too many requests. | Wait `Retry-After` seconds (or `retry_after_s`). |
| `server_error` | 500 | The app failed. | Retry with back-off. |

- `message` is for humans and MUST NOT contain secrets. `retry_after_s` MAY accompany `429` and
  `503` responses, next to the `Retry-After` header.
- Clients MUST handle an unknown `code` by its HTTP status class: retry 5xx and 429 with back-off,
  drop the request on other 4xx.
- Network errors and 5xx: the client retries with exponential back-off (starting at 1 s, capped at
  60 s, with jitter). Because complete and fail are idempotent per lease, retrying them is safe.

## 14. Versioning

- The discovery document names the protocol: `tether/1`. Paths come from discovery, so an app can
  move or version its endpoints without breaking clients.
- **Within `tether/1`, changes are additive only:** new optional request or response fields, new
  endpoints, new `stage` values, new error codes. Both sides ignore what they do not know
  ([Conventions](#1-conventions)), so older clients and servers keep working.
- New enum values in a response field that clients must act on (such as `status`) are breaking.
- Anything breaking (removing or renaming a field, changing a type or meaning, making an optional
  field required, a new required request field) is a new major version, `tether/2`, with its schemas
  in `schemas/v2/`. The schemas of a published version never change incompatibly.
- Schema `$id`s carry the major version in their path.

## 15. Security

- **Two credentials, two scopes.** The device credential only claims and reports tasks. Results are
  written through the app's MCP server with the task-scoped `mcp.token`, which only touches that task
  and stops working when the lease ends or the task reaches a terminal state.
- **Local policy beats the app.** The app requests tools; the client grants only the intersection
  with the user's local allow-list. Defaults: allow `WebSearch`, `WebFetch` and the app's MCP tools;
  deny `Bash`, file writes outside the task's temporary directory, and every other MCP server. No
  field in this protocol can widen the local policy, and `limits` can only lower local limits.
- **Untrusted content.** Instructions, skills, inputs and anything fetched from the web are data for
  the agent, never instructions to the client. The client's own base prompt says so.
- **Same origin.** Endpoints stay on the discovery document's origin (see [Discovery](#2-discovery)).
- **No secrets in logs.** Device credentials, device codes and task tokens never appear in logs,
  events, error messages or reports, on either side.
- **Credential storage.** The client keeps the device credential in the OS keychain where
  available, otherwise in a file readable only by the user (mode 0600).

## 16. Conformance testing

This repository ships a conformance suite that any app server can run against itself:

```
git clone https://github.com/farzai/tether && cd tether && bun install
bun run conformance https://your-app.example --hook-secret "$TETHER_CONFORMANCE_SECRET"
```

The suite pairs a device, claims and reports tasks, checks every response against the schemas in
this document, and walks the [state table](#12-state-table). It prints `PASS`, `FAIL` or `SKIP` per
check and exits `0` only when every check passed (`1` on any failure or skip, `2` on a usage error).
It never prints credentials, device codes or task tokens.

To drive tasks without a human, a server in **test mode** exposes four hooks and lists them in the
discovery document under `conformance`:

```json
{
  "conformance": {
    "pair_approve": "/tether/v1/conformance/pair/approve",
    "pair_deny": "/tether/v1/conformance/pair/deny",
    "enqueue": "/tether/v1/conformance/tasks",
    "cancel": "/tether/v1/conformance/tasks/{id}/cancel"
  }
}
```

| Hook | Method | Body | Auth | Effect |
|---|---|---|---|---|
| `pair_approve` | POST | [`schemas/v1/conformance-pair.request.json`](../schemas/v1/conformance-pair.request.json) | secret | Approves the pairing as a fresh test user with no tasks. `204`. |
| `pair_deny` | POST | [`schemas/v1/conformance-pair.request.json`](../schemas/v1/conformance-pair.request.json) | secret | Denies the pairing. `204`. |
| `enqueue` | POST | [`schemas/v1/conformance-enqueue.request.json`](../schemas/v1/conformance-enqueue.request.json) | secret and device | Queues a task for the device's user; `201` with the task ([`task.json`](../schemas/v1/task.json)). |
| `cancel` | POST | none | secret and device | Cancels the task as the user would; `200` with the task status. |

<!-- example: conformance-pair.request -->
```json
{ "user_code": "KQ7M-3XPD" }
```

<!-- example: conformance-enqueue.request -->
```json
{ "task": { "title": "Conformance task" }, "lease_s": 2 }
```

- `lease_s` sets the lease length for that task, so the suite can test lease expiry quickly.
- Every hook call carries `Tether-Conformance-Secret: <secret>`. A wrong or missing secret gets
  `401 unauthorized`.
- **Hooks are for test deployments only.** A server MUST NOT advertise or answer them unless an
  operator has configured a conformance secret, and MUST NOT enable them in production: they let the
  secret holder create test users and tasks.

## 17. Schema index

| Schema | Message |
|---|---|
| [`schemas/v1/common.json`](../schemas/v1/common.json) | Shared definitions: timestamp, id, client, usage, lease, task status |
| [`schemas/v1/error.json`](../schemas/v1/error.json) | Error response |
| [`schemas/v1/discovery.json`](../schemas/v1/discovery.json) | `GET /.well-known/tether` response |
| [`schemas/v1/pair-start.request.json`](../schemas/v1/pair-start.request.json) | pair/start request |
| [`schemas/v1/pair-start.response.json`](../schemas/v1/pair-start.response.json) | pair/start response |
| [`schemas/v1/pair-poll.request.json`](../schemas/v1/pair-poll.request.json) | pair/poll request |
| [`schemas/v1/pair-poll.response.json`](../schemas/v1/pair-poll.response.json) | pair/poll response |
| [`schemas/v1/heartbeat.request.json`](../schemas/v1/heartbeat.request.json) | heartbeat request |
| [`schemas/v1/heartbeat.response.json`](../schemas/v1/heartbeat.response.json) | heartbeat response |
| [`schemas/v1/task.json`](../schemas/v1/task.json) | Task payload |
| [`schemas/v1/claim.request.json`](../schemas/v1/claim.request.json) | claim request |
| [`schemas/v1/claim.response.json`](../schemas/v1/claim.response.json) | claim response (200) |
| [`schemas/v1/task-events.request.json`](../schemas/v1/task-events.request.json) | events request |
| [`schemas/v1/task-events.response.json`](../schemas/v1/task-events.response.json) | events response |
| [`schemas/v1/task-complete.request.json`](../schemas/v1/task-complete.request.json) | complete request |
| [`schemas/v1/task-complete.response.json`](../schemas/v1/task-complete.response.json) | complete response |
| [`schemas/v1/task-fail.request.json`](../schemas/v1/task-fail.request.json) | fail request |
| [`schemas/v1/task-fail.response.json`](../schemas/v1/task-fail.response.json) | fail response |
| [`schemas/v1/task-status.response.json`](../schemas/v1/task-status.response.json) | task status response |
| [`schemas/v1/conformance-pair.request.json`](../schemas/v1/conformance-pair.request.json) | Conformance hook: approve or deny a pairing |
| [`schemas/v1/conformance-enqueue.request.json`](../schemas/v1/conformance-enqueue.request.json) | Conformance hook: enqueue a task |
