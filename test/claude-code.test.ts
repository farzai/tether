import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  type AgentTask,
  killAgentsNow,
  type Outcome,
  runClaudeCode,
} from "../src/client/claude-code.ts";

const FAKE_CLAUDE = new URL("./fake-claude/claude.mjs", import.meta.url).pathname;
chmodSync(FAKE_CLAUDE, 0o755);
const scratch = mkdtempSync(join(tmpdir(), "tether-adapter-"));

async function run(fake: Record<string, unknown>, command = FAKE_CLAUDE, signal?: AbortSignal) {
  const record = (fake.record as string | undefined) ?? join(scratch, `${Math.random()}.json`);
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

  it("disallows every built-in tool it did not grant", async () => {
    const { seen } = await run({ fixture: "success" });
    const disallowed = seen.argv[seen.argv.indexOf("--disallowedTools") + 1].split(",");
    expect(disallowed).toContain("Bash");
    expect(disallowed).toContain("Write");
    expect(disallowed).not.toContain("WebSearch");
  });

  it("reads sparse lines: bad lines, missing ids, fields and text count as nothing", async () => {
    const { outcome, events } = await run({ fixture: "sparse" });
    expect(outcome).toMatchObject({ kind: "success", summary: "Done." });
    expect(outcome.usage).toEqual({
      input_tokens: 0,
      output_tokens: 3,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(events).toContainEqual({ stage: "tool", message: "tool" });
    expect(events.filter((e) => e.stage === "message")).toEqual([]);
  });

  it("does not call a run a success when the result is flagged or the exit code is not 0", async () => {
    expect((await run({ fixture: "success-flagged", exit_code: 0 })).outcome.kind).toBe("error");
    expect((await run({ fixture: "success", exit_code: 3 })).outcome).toMatchObject({
      kind: "error",
      exitCode: 3,
    });
  });

  it("kills the whole process group, so a process the agent started dies too", async () => {
    const stop = new AbortController();
    const record = join(scratch, `group-${Math.random()}.json`);
    const fake = { fixture: "hang", hang: true, grandchild: true, record };
    const done = run(fake, FAKE_CLAUDE, stop.signal);
    // Abort only once the agent has started its child, however slow the machine is.
    while (!existsSync(record)) await new Promise((r) => setTimeout(r, 25));
    stop.abort();
    const { seen } = await done;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(seen.grandchildPid); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive(seen.grandchildPid)).toBe(false);
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

  it("kills a session at once when its first line is not the init line", async () => {
    const started = Date.now();
    const { outcome } = await run({ fixture: "no-init", hang: true });
    expect(outcome).toMatchObject({
      kind: "refused",
      message: "Claude Code did not describe its session first",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports an error when the binary cannot be started", async () => {
    const { outcome } = await run({}, join(scratch, "no-such-claude"));
    expect(outcome).toMatchObject({
      kind: "error",
      message: "Claude Code could not be started",
    });
  });

  it("killAgentsNow kills every running agent's tree and removes its files at once", async () => {
    const record = join(scratch, `exit-${Math.random()}.json`);
    const done = run({ fixture: "hang", hang: true, ignore_term: true, grandchild: true, record });
    while (!existsSync(record)) await new Promise((r) => setTimeout(r, 25));
    const seen = JSON.parse(readFileSync(record, "utf8"));
    killAgentsNow();
    expect(existsSync(dirname(seen.cwd))).toBe(false);
    expect((await done).outcome.kind).not.toBe("success");
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    for (let i = 0; i < 40 && !gone(seen.grandchildPid); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(gone(seen.pid) && gone(seen.grandchildPid)).toBe(true);
  });

  it("is killed when its signal aborts", async () => {
    const stop = new AbortController();
    const done = run({ fixture: "hang", hang: true }, FAKE_CLAUDE, stop.signal);
    setTimeout(() => stop.abort(), 300);
    expect((await done).outcome.kind).toBe("killed");
  });
});
