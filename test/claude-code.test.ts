import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  type AgentTask,
  type Outcome,
  runClaudeCode,
} from "../src/client/claude-code.ts";

const FAKE_CLAUDE = new URL("./fake-claude/claude.mjs", import.meta.url).pathname;
chmodSync(FAKE_CLAUDE, 0o755);
const scratch = mkdtempSync(join(tmpdir(), "tether-adapter-"));

async function run(fake: Record<string, unknown>, command = FAKE_CLAUDE, signal?: AbortSignal) {
  const record = join(scratch, `${Math.random()}.json`);
  const task: AgentTask = {
    appName: "Paper",
    instructions: "Reply with OK.",
    skill: { name: "paper", version: "3", markdown: "# Paper skill" },
    input: { fake: { record, ...fake } },
    mcp: { url: "http://127.0.0.1:1/mcp", token: "mcp_0123456789abcdef0123456789" },
    tools: ["WebSearch"],
    budgetUsd: 0.25,
  };
  const events: AgentEvent[] = [];
  const outcome: Outcome = await runClaudeCode(task, {
    command,
    env: { PATH: process.env.PATH },
    onEvent: (event) => events.push(event),
    signal: signal ?? new AbortController().signal,
  });
  const seen = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : undefined;
  return { outcome, events, seen };
}

describe("runClaudeCode", () => {
  it("reports success with the result text, summed tokens and the reported cost", async () => {
    const { outcome, events, seen } = await run({ fixture: "success" });
    expect(outcome).toMatchObject({ kind: "success", exitCode: 0, summary: "OK" });
    expect(outcome.usage.output_tokens).toBe(44);
    expect(outcome.usage.cost_usd).toBeCloseTo(0.0157772, 6);
    expect(events).toContainEqual({ stage: "tool", message: "WebSearch: why is the sky blue" });
    expect(events).toContainEqual({ stage: "message", message: "Searching." });
    expect(seen.systemPrompt).toContain("## Skill: paper (version 3)");
    expect(seen.argv[seen.argv.indexOf("--max-budget-usd") + 1]).toBe("0.25");
    expect(existsSync(seen.cwd)).toBe(false);
  });

  it("reports a session that ended in error as an agent error", async () => {
    const { outcome } = await run({ fixture: "error" });
    expect(outcome).toMatchObject({
      kind: "error",
      exitCode: 1,
      message: "Claude Code exited with code 1 (error_during_execution)",
    });
  });

  it("reports a session that ended without a result line as an agent error", async () => {
    const { outcome } = await run({ fixture: "hang" });
    expect(outcome).toMatchObject({
      kind: "error",
      exitCode: 0,
      message: "Claude Code exited with code 0 (no result)",
    });
  });

  it("refuses a session that never described itself", async () => {
    const { outcome } = await run({ fixture: "no-init" });
    expect(outcome.kind).toBe("refused");
  });

  it("reports an error when the binary cannot be started", async () => {
    const { outcome } = await run({}, join(scratch, "no-such-claude"));
    expect(outcome).toMatchObject({
      kind: "error",
      message: "Claude Code could not be started",
    });
  });

  it("is killed when its signal aborts", async () => {
    const stop = new AbortController();
    const done = run({ fixture: "hang", hang: true }, FAKE_CLAUDE, stop.signal);
    setTimeout(() => stop.abort(), 300);
    expect((await done).outcome.kind).toBe("killed");
  });
});
