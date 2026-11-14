import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  type AgentTask,
  CLAUDE_CODE_VERSION,
  killAgentsNow,
  type Outcome,
  PIPE_GRACE_MS,
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

  it("names an expired login or a bad key and says to sign in again", async () => {
    const { outcome, events } = await run({ fixture: "auth-expired" });
    expect(outcome).toMatchObject({ kind: "error", exitCode: 1, cause: "auth_failed" });
    expect(outcome).not.toHaveProperty("retryAt");
    expect((outcome as { message: string }).message).toMatch(/sign in to Claude Code again/);
    expect(events).toContainEqual({
      stage: "message",
      message: "Invalid API key \u00b7 Fix external API key",
    });
  });

  it("names a hit limit with the time it resets", async () => {
    const { outcome } = await run({ fixture: "rate-limit" });
    expect(outcome).toMatchObject({
      kind: "error",
      cause: "rate_limit",
      retryAt: "2026-11-14T15:00:00Z",
    });
    expect((outcome as { message: string }).message).toMatch(/after 2026-11-14T15:00:00Z/);
  });

  it("names a billing problem and a provider failure", async () => {
    expect((await run({ fixture: "billing" })).outcome).toMatchObject({ cause: "billing" });
    const provider = (await run({ fixture: "provider-error" })).outcome;
    expect(provider).toMatchObject({ kind: "error", cause: "provider_error" });
    expect((provider as { message: string }).message).toMatch(/Retry later/);
  });

  it("falls back to the result's API status when no line names the error", async () => {
    const { outcome } = await run({ fixture: "status-only" });
    expect(outcome).toMatchObject({ kind: "error", cause: "rate_limit" });
    expect(outcome).not.toHaveProperty("retryAt");
  });

  it("takes the reset of the overage when the overage was the limit that was hit", async () => {
    const { outcome } = await run({ fixture: "overage-rejected" });
    expect(outcome).toMatchObject({ cause: "rate_limit", retryAt: "2026-11-14T16:00:00Z" });
  });

  it("gives a plain agent error no cause, even after a limit warning it ran past", async () => {
    expect((await run({ fixture: "error" })).outcome).not.toHaveProperty("cause");
    const overage = (await run({ fixture: "overage-then-error" })).outcome;
    expect(overage).toMatchObject({ kind: "error" });
    expect(overage).not.toHaveProperty("cause");
    expect(overage).not.toHaveProperty("retryAt");
  });

  it("keeps a session that recovered from an API error a success", async () => {
    const { outcome } = await run({ fixture: "recovered" });
    expect(outcome).toMatchObject({ kind: "success", summary: "OK" });
  });

  it("does not wait for a pipe a leftover process holds, and keeps the last lines", async () => {
    const record = join(scratch, `pipe-${Math.random()}.json`);
    const started = Date.now();
    const quick = Date.now();
    await run({ fixture: "success" });
    expect(Date.now() - quick).toBeLessThan(PIPE_GRACE_MS);
    const { outcome, seen } = await run({ fixture: "success", hold_pipe: true, record });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toMatchObject({ kind: "success", summary: "OK" });
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

  it("keeps the end of stderr for the local log, never in the message for the app", async () => {
    const noise = "x".repeat(100_000);
    const { outcome } = await run({ fixture: "hang", stderr: `${noise}error: unknown option\n` });
    expect(outcome).toMatchObject({
      kind: "error",
      message: "Claude Code exited with code 0 (no result)",
    });
    const { detail } = outcome as { detail: string };
    expect(detail.endsWith("error: unknown option\n")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(4000);
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

describe("Claude Code fixtures and flags doc", () => {
  const fixtures = new URL("./fixtures/claude-code/", import.meta.url).pathname;
  const flagsDoc = readFileSync(new URL("../docs/claude-code-flags.md", import.meta.url), "utf8");

  it("documents every flag the adapter passes", async () => {
    const { seen } = await run({ fixture: "success" });
    const flags = (seen.argv as string[]).filter((arg) => arg.startsWith("--"));
    expect(flags.length).toBeGreaterThan(10);
    for (const flag of flags) expect(flagsDoc).toContain(`\`${flag}\``);
  });

  it("names one Claude Code version in the adapter, the doc, the fake and the fixtures", () => {
    expect(flagsDoc).toContain(`Claude Code ${CLAUDE_CODE_VERSION}`);
    const fake = spawnSync(process.execPath, [FAKE_CLAUDE, "--version"], { encoding: "utf8" });
    expect(fake.stdout).toBe(`${CLAUDE_CODE_VERSION} (Claude Code)\n`);
    for (const name of readdirSync(fixtures)) {
      for (const version of readFileSync(join(fixtures, name), "utf8").matchAll(
        /"claude_code_version":"([^"]+)"/g,
      )) {
        expect(version[1], name).toBe(CLAUDE_CODE_VERSION);
      }
    }
  });

  it("keeps the fixtures scrubbed of session ids, request ids and home paths", () => {
    for (const name of readdirSync(fixtures)) {
      const text = readFileSync(join(fixtures, name), "utf8");
      for (const [uuid] of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) {
        expect(uuid, name).toMatch(/^00000000-0000-4000-8000-/);
      }
      expect(text, name).not.toMatch(/\/Users\/|\/home\/|C:\\\\Users/);
      for (const [id] of text.matchAll(/req_[A-Za-z0-9]+/g)) expect(id, name).toBe("req_fixture");
    }
  });
});
