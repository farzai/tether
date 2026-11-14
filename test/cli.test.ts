import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.ts";
import { type FakeApp, type FakeAppOptions, startFakeApp } from "./fake-app/server.ts";

const FAKE_CLAUDE = new URL("./fake-claude/claude.mjs", import.meta.url).pathname;
chmodSync(FAKE_CLAUDE, 0o755);

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

/** One Tether home, one fake app, and every byte Tether printed or sent. */
class Harness {
  readonly home = mkdtempSync(join(tmpdir(), "tether-test-home-"));
  readonly scratch = mkdtempSync(join(tmpdir(), "tether-test-scratch-"));
  readonly sent: Sent[] = [];
  out = "";
  err = "";
  app!: FakeApp;
  extraEnv: Record<string, string> = {};
  /** Rewrites a response body before Tether sees it, keyed by endpoint path suffix. */
  rewrite: Record<string, (body: Record<string, unknown>) => unknown> = {};

  async start(options: Partial<FakeAppOptions> = {}): Promise<this> {
    this.app = await startFakeApp(options);
    return this;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.sent.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const res = await fetch(input, init);
    const rule = Object.entries(this.rewrite).find(([suffix]) => url.pathname.endsWith(suffix));
    if (!rule || res.status !== 200) return res;
    const json = (await res.json()) as Record<string, unknown>;
    return new Response(JSON.stringify(rule[1](json)), { status: 200, headers: res.headers });
  };

  run(argv: string[], signal?: AbortSignal): Promise<number> {
    return main(argv, {
      env: {
        TETHER_HOME: this.home,
        TETHER_CLAUDE_PATH: FAKE_CLAUDE,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GH_TOKEN: "must-not-reach-the-agent",
        ...this.extraEnv,
      },
      stdout: { write: (text: string) => (this.out += text) },
      stderr: { write: (text: string) => (this.err += text) },
      fetch: this.fetch as typeof fetch,
      ...(signal ? { signal } : {}),
    });
  }

  /** Runs `connect` and approves the code it prints, as the user would on the web page. */
  async connect(): Promise<number> {
    const done = this.run(["connect", this.app.url]);
    const code = await until(() => /([B-Z]{4}-[B-Z]{4})/.exec(this.out)?.[1]);
    expect(this.app.approvePairing(code)).toBe(true);
    return done;
  }

  credential(): string {
    const file = JSON.parse(readFileSync(join(this.home, "credentials.json"), "utf8"));
    return file.apps[0].credential;
  }

  policy(policy: unknown): void {
    writeFileSync(join(this.home, "policy.json"), JSON.stringify(policy));
  }

  enqueue(overrides: Record<string, unknown>, fake: Record<string, unknown> = {}, leaseS?: number) {
    const record = join(this.scratch, `record-${this.sent.length}-${Math.random()}.json`);
    const input = { note: "hello", fake: { fixture: "success", record, ...fake } };
    const task = this.app.enqueueFor(this.credential(), { input, ...overrides }, leaseS);
    return { id: task.id, record };
  }

  async status(id: string): Promise<{ status: string; attempts: number }> {
    const res = await fetch(`${this.app.url}/tether/v1/tasks/${id}`, {
      headers: { authorization: `Bearer ${this.credential()}` },
    });
    return (await res.json()) as { status: string; attempts: number };
  }

  reports(id: string): Sent[] {
    return this.sent.filter((s) => s.path.includes(`/tasks/${id}/`));
  }

  failOf(id: string): { reason: string; message?: string } | undefined {
    return this.reports(id).find((s) => s.path.endsWith("/fail"))?.body as
      | { reason: string }
      | undefined;
  }

  /**
   * Every secret the app issued is absent from all output and from every request body except
   * pair_poll, which carries the device code by design.
   */
  expectNoSecrets(): void {
    const bodies = this.sent.filter((s) => !s.path.endsWith("/pair/poll"));
    const everything = `${this.out}\n${this.err}\n${JSON.stringify(bodies)}`;
    for (const secret of this.app.issuedSecrets()) expect(everything).not.toContain(secret);
  }
}

async function until<T>(probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(25);
  }
}

async function untilAsync<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(50);
  }
}

const record = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let harnesses: Harness[] = [];
let stops: AbortController[] = [];

afterEach(async () => {
  for (const stop of stops) stop.abort();
  for (const h of harnesses) await h.app.close();
  harnesses = [];
  stops = [];
});

async function harness(options: Partial<FakeAppOptions> = {}): Promise<Harness> {
  const h = await new Harness().start(options);
  harnesses.push(h);
  return h;
}

async function paired(options: Partial<FakeAppOptions> = {}): Promise<Harness> {
  const h = await harness(options);
  expect(await h.connect()).toBe(0);
  return h;
}

/** Starts `tether start` in the background; returns its exit promise and the stop switch. */
function startTether(h: Harness, args: string[] = []) {
  const stop = new AbortController();
  stops.push(stop);
  const exit = h.run(["start", ...args], stop.signal);
  return { exit, stop };
}

describe("tether connect", () => {
  it("pairs, stores the credential readable only by the user, and names the account", async () => {
    const h = await paired();
    expect(h.out).toContain("127.0.0.1");
    expect(h.out).toMatch(/connected as "Test user \d+"/);
    const file = join(h.home, "credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(h.home).mode & 0o777).toBe(0o700);
    expect(h.credential()).toMatch(/^tdc_/);
    h.expectNoSecrets();
  });

  it("stops when the user denies the device", async () => {
    const h = await harness();
    const done = h.run(["connect", h.app.url]);
    const code = await until(() => /([B-Z]{4}-[B-Z]{4})/.exec(h.out)?.[1]);
    h.app.denyPairing(code);
    expect(await done).toBe(1);
    expect(h.err).toMatch(/denied/);
    expect(existsSync(join(h.home, "credentials.json"))).toBe(false);
  });

  it("refuses an app whose discovery names an endpoint on another site", async () => {
    const h = await harness({ misbehave: { endpoints: { heartbeat: "https://evil.example/hb" } } });
    expect(await h.run(["connect", h.app.url])).toBe(1);
    expect(h.err).toMatch(/another site/);
    expect(h.sent.map((s) => s.path)).toEqual(["/.well-known/tether"]);
  });

  it("refuses a verification URI that is not https", async () => {
    const h = await harness();
    h.rewrite["/pair/start"] = (body) => ({
      ...body,
      verification_uri: "javascript:alert(1)",
      verification_uri_complete: undefined,
    });
    expect(await h.run(["connect", h.app.url])).toBe(1);
    expect(h.out).not.toContain("javascript");
  });

  it("refuses a plain http app that is not on this machine", async () => {
    const h = await harness();
    expect(await h.run(["connect", "http://paper.example"])).toBe(2);
    expect(h.sent).toEqual([]);
  });
});

describe("tether apps, status and disconnect", () => {
  it("lists the connected app and today's usage", async () => {
    const h = await paired();
    h.out = "";
    expect(await h.run(["apps"])).toBe(0);
    expect(h.out).toContain("Fake App");
    expect(h.out).toContain(h.app.url);
    h.out = "";
    expect(await h.run(["status"])).toBe(0);
    expect(h.out).toMatch(/not running/);
    expect(h.out).toMatch(/0 of 100 tasks/);
    h.expectNoSecrets();
  });

  it("revokes the device before forgetting it", async () => {
    const h = await paired();
    const credential = h.credential();
    expect(await h.run(["disconnect", h.app.url])).toBe(0);
    const res = await fetch(`${h.app.url}/tether/v1/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({
        client: { name: "t", version: "0" },
        adapters: [],
        capacity: { max: 1, available: 1 },
        tasks: [],
      }),
    });
    expect(res.status).toBe(401);
    h.out = "";
    await h.run(["apps"]);
    expect(h.out).toMatch(/No apps connected/);
  });
});

describe("tether start", () => {
  it("claims a task, runs it in an isolated session and reports it complete with usage", async () => {
    const h = await paired();
    const task = h.enqueue({ tools: { requested: ["WebSearch"] } });
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "completed");

    const run = record(task.record);
    expect(run.argv).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--restricted"]));
    expect(run.argv).toEqual(expect.arrayContaining(["--no-session-persistence"]));
    expect(run.argv[run.argv.indexOf("--tools") + 1]).toBe("WebSearch");
    expect(run.mcpConfig.mcpServers).toEqual({
      app: {
        type: "http",
        url: `${h.app.url}/mcp`,
        headers: { Authorization: expect.stringMatching(/^Bearer mcp_/) },
      },
    });
    expect(run.env).not.toContain("GH_TOKEN");
    expect(run.stdin).toContain('"note": "hello"');
    expect(run.systemPrompt).toContain("Reply with OK.");
    expect(run.systemPrompt).not.toContain("hello");
    expect(existsSync(run.cwd)).toBe(false);

    const events = h.reports(task.id).filter((s) => s.path.endsWith("/events"));
    const stages = events.flatMap((e) => (e.body as { events: { stage: string }[] }).events);
    expect(stages.map((e) => e.stage)).toEqual(expect.arrayContaining(["started", "tool"]));
    const complete = h.reports(task.id).find((s) => s.path.endsWith("/complete"))?.body as {
      exit_code: number;
      usage: { cost_usd: number; output_tokens: number };
      summary: string;
    };
    expect(complete.exit_code).toBe(0);
    expect(complete.summary).toBe("OK");
    expect(complete.usage.cost_usd).toBeGreaterThan(0);
    expect(complete.usage.output_tokens).toBe(44);
    h.expectNoSecrets();
  });

  it("grants only the intersection with local policy: Bash is never granted", async () => {
    const h = await paired();
    const task = h.enqueue({ tools: { requested: ["Bash", "WebSearch"] } });
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "completed");
    const { argv } = record(task.record);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("WebSearch");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("WebSearch,mcp__app");
    expect(argv[argv.indexOf("--disallowedTools") + 1].split(",")).toContain("Bash");
    expect(h.out).toMatch(/not granted by local policy: Bash/);
  });

  it("refuses a task whose MCP server is not the app's own, without running it", async () => {
    const h = await paired();
    const task = h.enqueue({ mcp: { url: "https://evil.example/mcp", token: "x".repeat(32) } });
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "failed");
    expect(h.failOf(task.id)?.reason).toBe("policy");
    expect(existsSync(task.record)).toBe(false);
  });

  it("refuses a session that loaded a plugin the user installed", async () => {
    const h = await paired();
    const task = h.enqueue({}, { fixture: "foreign-plugin", hang: true });
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "failed");
    expect(h.failOf(task.id)?.reason).toBe("policy");
    await until(() => !alive(record(task.record).pid));
  });

  it("renews the lease while a slow agent runs", async () => {
    const h = await paired();
    const task = h.enqueue({}, { delay_ms: 900 }, 3);
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "completed", 15_000);
    expect((await h.status(task.id)).attempts).toBe(1);
    const renewals = h.reports(task.id).filter((s) => s.path.endsWith("/events"));
    expect(renewals.length).toBeGreaterThanOrEqual(3);
  });

  it("kills the agent when the user cancels mid-task", async () => {
    const h = await paired();
    const task = h.enqueue({}, { fixture: "hang", hang: true });
    startTether(h);
    await until(() => existsSync(task.record));
    h.app.cancel(task.id);
    await until(() => h.failOf(task.id));
    expect(h.failOf(task.id)?.reason).toBe("cancelled_by_user");
    await until(() => !alive(record(task.record).pid));
  });

  it("kills the agent on timeout", async () => {
    const h = await paired();
    const task = h.enqueue({ limits: { timeout_s: 1, max_budget_usd: 0.1 } }, { hang: true });
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "failed");
    expect(h.failOf(task.id)?.reason).toBe("timeout");
    await until(() => !alive(record(task.record).pid));
    expect(existsSync(record(task.record).cwd)).toBe(false);
  });

  it("reports budget when the agent stops at its budget, which is the lower of app and local", async () => {
    const h = await paired();
    h.policy({ max_task_usd: 0.05 });
    const task = h.enqueue(
      { limits: { timeout_s: 60, max_budget_usd: 0.5 } },
      { fixture: "budget" },
    );
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "failed");
    expect(h.failOf(task.id)?.reason).toBe("budget");
    const { argv } = record(task.record);
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.05");
  });

  it("stops claiming once the daily task cap is reached", async () => {
    const h = await paired();
    h.policy({ daily: { tasks: 1, usd: 10 } });
    const first = h.enqueue({});
    const second = h.enqueue({});
    startTether(h);
    await untilAsync(async () => (await h.status(first.id)).status === "completed");
    await until(() => /daily task cap reached/.test(h.out));
    await sleep(500);
    expect(await h.status(second.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("does not fail running tasks when it stops: the lease is left to expire", async () => {
    const h = await paired();
    const task = h.enqueue({}, { hang: true });
    const { exit, stop } = startTether(h);
    await until(() => existsSync(task.record));
    stop.abort();
    expect(await exit).toBe(0);
    expect(alive(record(task.record).pid)).toBe(false);
    expect(h.reports(task.id).some((s) => /\/(fail|complete)$/.test(s.path))).toBe(false);
    expect(await h.status(task.id)).toMatchObject({ status: "leased", attempts: 1 });
  });

  it("refuses a second start while one is running", async () => {
    const h = await paired();
    startTether(h);
    await until(() => /online/.test(h.out));
    expect(await h.run(["start"])).toBe(1);
    expect(h.err).toMatch(/already running/);
  });

  it("stops using a revoked credential and asks to pair again", async () => {
    const h = await paired();
    await fetch(`${h.app.url}/tether/v1/devices/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.credential()}` },
    });
    const { exit } = startTether(h);
    expect(await exit).toBe(1);
    expect(h.err).toMatch(/tether connect/);
    const heartbeats = h.sent.filter((s) => s.path.endsWith("/heartbeat"));
    expect(heartbeats.length).toBe(1);
  });
});
