# Tether

Connect your own AI agent to web apps.

Tether is a small program you run on your own computer. Web apps that support it put AI tasks in a queue for you; Tether picks them up and runs each one as a fresh, sandboxed agent session (Claude Code first), with only the tools the task needs. You steer everything from the app's web page. The app never runs or pays for a model, and your agent never gets more access than you allow.

```
npx @farzai/tether connect https://paper.farzai.com
npx @farzai/tether start
```

Status: early. From a checkout, `bun run tether <command>` runs the CLI: `connect <app-url>`,
`start [--concurrency <n>]`, `status`, `apps` and `disconnect <app>`. It needs Claude Code
(2.1.325 or later, signed in). See [docs/spec.md](docs/spec.md) for the product spec and
[docs/protocol.md](docs/protocol.md) for Tether Protocol v1, which app servers implement. An app
server can check itself with the conformance suite: `bun run conformance <app-url>` from a checkout
of this repository (see the protocol's "Conformance testing" section).

## What a task can do on your computer

Each task runs as a fresh `claude -p` session in an empty temporary directory that is deleted
afterwards. The session gets only the app's own MCP server, only the tools both the app asked for
and your policy allows (by default only `WebSearch`; never `WebFetch` or `Bash` unless you add
them), no user settings, hooks, plugins, skills or `CLAUDE.md`, and an environment without your
other variables. Tether checks the session Claude Code reports and stops it if it got more.

Your policy lives in `~/.tether/policy.json` (or `$TETHER_HOME`). Every field is optional:

```json
{
  "tools": ["WebSearch"],
  "max_task_usd": 1,
  "max_timeout_s": 1800,
  "daily": { "tasks": 100, "usd": 10 },
  "apps": { "https://paper.farzai.com": { "tasks": 20, "usd": 2 } }
}
```

An app can ask for less than this, never more. `WebFetch` is off by default because a page fetched
for an app can be on your own computer or network (`127.0.0.1`, your router, a cloud metadata
address); add it only for apps you trust. `tether start` warns while your policy allows `WebFetch`,
`Bash` or `PowerShell`. A task can spend up to one turn past its budget, since Claude Code checks
the budget between turns.

Device credentials are kept in `~/.tether/credentials.json`, readable only by you (keychain storage
comes later).

## License

MIT
