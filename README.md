# Tether

Connect your own AI agent to web apps.

Tether is a small program you run on your own computer. Web apps that support it put AI tasks in a queue for you; Tether picks them up and runs each one as a fresh, sandboxed agent session (Claude Code first), with only the tools the task needs. You steer everything from the app's web page. The app never runs or pays for a model, and your agent never gets more access than you allow.

```
npx @farzai/tether connect https://paper.farzai.com
npx @farzai/tether start
```

Status: design stage. See [docs/spec.md](docs/spec.md) for the product spec and
[docs/protocol.md](docs/protocol.md) for Tether Protocol v1, which app servers implement. An app
server can check itself with the conformance suite: `bun run conformance <app-url>` from a checkout
of this repository (see the protocol's "Conformance testing" section).

## License

MIT
