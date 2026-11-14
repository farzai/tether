import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.ts";
import type { Keychain } from "../src/client/keychain.ts";
import { type AppRecord, Store } from "../src/client/store.ts";
import { type FakeApp, type FakeAppOptions, startFakeApp } from "./fake-app/server.ts";

const FAKE_CLAUDE = new URL("./fake-claude/claude.mjs", import.meta.url).pathname;
const BIN = new URL("../src/cli/bin.ts", import.meta.url).pathname;
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
  /** A keychain for credentials; without one, credentials stay in credentials.json. */
  keychain: Keychain | undefined;
  /** Rewrites a response body before Tether sees it, keyed by endpoint path suffix. */
  rewrite: Record<string, (body: Record<string, unknown>) => unknown> = {};

  async start(options: Partial<FakeAppOptions> = {}): Promise<this> {
    this.app = await startFakeApp(options);
    return this;
  }

  /** Answers a request instead of the app, keyed by endpoint path suffix; undefined passes it on. */
  intercept: Record<string, () => Response | undefined> = {};

  readonly fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.sent.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const hook = Object.entries(this.intercept).find(([suffix]) => url.pathname.endsWith(suffix));
    const answer = hook?.[1]();
    if (answer) return answer;
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
        TETHER_KEYCHAIN: "off",
        ...this.extraEnv,
      },
      stdout: { write: (text: string) => (this.out += text) },
      stderr: { write: (text: string) => (this.err += text) },
      fetch: this.fetch as typeof fetch,
      ...(signal ? { signal } : {}),
      ...(this.keychain ? { keychain: this.keychain } : {}),
    });
  }

  /** Runs `connect` and approves the code it prints, as the user would on the web page. */
  async connect(): Promise<number> {
    const done = this.run(["connect", this.app.url]);
    const code = await until(() => /([B-Z]{4}-[B-Z]{4})/.exec(this.out)?.[1]);
    expect(this.app.approvePairing(code)).toBe(true);
    return done;
  }

  store(): Store {
    return new Store(this.home);
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

const errorBody = (code: string) => ({ error: { code, message: "test" } });
const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const record = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Tests run concurrently, each with its own app and home; everything they start is stopped here.
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

async function harness(options: Partial<FakeAppOptions> = {}): Promise<Harness> {
  const h = await new Harness().start(options);
  cleanups.push(() => h.app.close());
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
  const exit = h.run(["start", ...args], stop.signal);
  cleanups.push(() => {
    stop.abort();
    return exit;
  });
  return { exit, stop };
}

describe.concurrent("tether connect", () => {
  it("pairs, stores the credential readable only by the user, and names the account", async () => {
    const h = await paired();
    expect(h.out).toContain("127.0.0.1");
    expect(h.out).toMatch(/Connected to Fake App as "Test user \d+"/);
    expect(h.out).toMatch(/a page on 127\.0\.0\.1:\d+/);
    const file = join(h.home, "credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(h.home).mode & 0o777).toBe(0o700);
    expect(h.credential()).toMatch(/^tdc_/);
    h.expectNoSecrets();
  });

  it("keeps the credential in the keychain when there is one, and runs tasks with it", async () => {
    const h = await harness();
    const items = new Map<string, string>();
    h.keychain = {
      name: "the test keychain",
      get: (origin) => items.get(origin),
      set: (origin, secret) => items.set(origin, secret) !== undefined,
      delete: (origin) => items.delete(origin),
    };
    expect(await h.connect()).toBe(0);
    expect(h.out).toContain("The device credential is in the test keychain.");
    const [credential] = items.values();
    expect(credential).toMatch(/^tdc_/);
    expect(readFileSync(join(h.home, "credentials.json"), "utf8")).not.toContain(credential);
    expect(await h.run(["disconnect", h.app.url])).toBe(0);
    expect(items.size).toBe(0);
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

  it("stops when the code expires before anyone answers", async () => {
    const h = await harness({ pairExpiresS: 1 });
    expect(await h.run(["connect", h.app.url])).toBe(1);
    expect(h.err).toMatch(/code expired/);
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

describe.concurrent("tether apps, status and disconnect", () => {
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

  it("adds 5 seconds to the poll interval after slow_down", async () => {
    const h = await harness({ pairIntervalS: 2 });
    h.rewrite["/pair/start"] = (body) => ({ ...body, interval: 1 });
    const done = h.run(["connect", h.app.url]);
    const polls = () => h.sent.filter((s) => s.path.endsWith("/pair/poll"));
    await until(() => polls().length >= 2, 5_000);
    const second = Date.now();
    const code = /([B-Z]{4}-[B-Z]{4})/.exec(h.out)?.[1] as string;
    h.app.approvePairing(code);
    expect(await done).toBe(0);
    expect(Date.now() - second).toBeGreaterThanOrEqual(5_500);
  });

  it("disconnects an app named by its name", async () => {
    const h = await paired();
    expect(await h.run(["disconnect", "Fake App"])).toBe(0);
    expect(await h.run(["disconnect", "Fake App"])).toBe(1);
    expect(h.err).toMatch(/No connected app matches/);
  });

  it("forgets the app even when it cannot be reached, and says to revoke it there", async () => {
    const h = await paired();
    await h.app.close();
    expect(await h.run(["disconnect", h.app.url])).toBe(0);
    expect(h.err).toMatch(/Revoke it on the app's device page/);
    expect(h.store().apps()).toEqual([]);
    h.app = await startFakeApp();
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

describe.concurrent("tether start", () => {
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
    expect(h.out).toMatch(/completed: OK/);
    const { argv } = record(task.record);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("WebSearch");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("WebSearch,mcp__app");
    expect(argv[argv.indexOf("--disallowedTools") + 1].split(",")).toContain("Bash");
    expect(h.out).toMatch(/not granted by local policy: Bash/);
  });

  it("does not grant WebFetch by default", async () => {
    const h = await paired();
    const task = h.enqueue({ tools: { requested: ["WebFetch"] } });
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "completed");
    expect(h.out).toMatch(/not granted by local policy: WebFetch/);
    const { argv } = record(task.record);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(h.err).not.toMatch(/Your policy lets tasks use/);
  });

  it("grants WebFetch when local policy allows it, and warns at start", async () => {
    const h = await paired();
    h.policy({ tools: ["WebSearch", "WebFetch"] });
    const task = h.enqueue({ tools: { requested: ["WebFetch"] } });
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "completed");
    const { argv } = record(task.record);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("WebFetch");
    expect(h.err).toMatch(/Your policy lets tasks use WebFetch, which can reach/);
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

  it("reports a hit limit as an agent error with its cause and reset time", async () => {
    const h = await paired();
    const task = h.enqueue({}, { fixture: "rate-limit" });
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "failed");
    const fail = h.failOf(task.id) as Record<string, unknown>;
    expect(fail).toMatchObject({
      reason: "agent_error",
      cause: "rate_limit",
      retry_at: "2026-11-14T15:00:00Z",
    });
    expect(fail.message).toMatch(/usage limit/);
    expect(h.out).toMatch(/failed: agent_error \(rate_limit\): Claude Code hit its usage limit/);
  });

  it("logs what the agent wrote to stderr, redacted, and never sends it to the app", async () => {
    const h = await paired();
    const key = "sk-ant-api03-fake-key-for-the-test-0123456789";
    h.extraEnv.ANTHROPIC_API_KEY = key;
    const task = h.enqueue({}, { fixture: "hang", leak: true });
    startTether(h);
    await until(() => h.failOf(task.id));
    await until(() => /Claude Code wrote/.test(h.out));
    expect(JSON.stringify(h.failOf(task.id))).not.toContain("mcpServers");
    expect(h.out).toContain("mcpServers");
    expect(h.out).toContain("[redacted]");
    expect(`${h.out}${h.err}`).not.toContain(key);
    h.expectNoSecrets();
  });

  it("reserves each running task's budget so concurrent tasks cannot pass the spend cap", async () => {
    const h = await paired();
    h.policy({ daily: { tasks: 10, usd: 0.15 } });
    const limits = { timeout_s: 60, max_budget_usd: 0.1 };
    const first = h.enqueue({ limits }, { hang: true });
    const second = h.enqueue({ limits }, { hang: true });
    startTether(h, ["--concurrency", "2"]);
    await until(() => existsSync(first.record));
    await sleep(1_000);
    expect(existsSync(second.record)).toBe(true);
    const { argv } = record(second.record);
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.0499");
  });

  it("refuses a concurrency that is not a whole number from 1 to 16", async () => {
    const h = await paired();
    for (const bad of ["0", "17", "1.5", "two"]) {
      expect(await h.run(["start", "--concurrency", bad])).toBe(2);
    }
    expect(await h.run(["start", "extra"])).toBe(2);
    expect(await h.run(["status", "extra"])).toBe(2);
    expect(await h.run(["nope"])).toBe(2);
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

  it("still runs a task when exactly one cent of today's spend cap is left", async () => {
    const h = await paired();
    h.policy({ daily: { tasks: 10, usd: 0.01 } });
    const task = h.enqueue({});
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "completed");
    const { argv } = record(task.record);
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.01");
  });

  it("rechecks the daily cap when a claim lands, so two apps cannot both pass it", async () => {
    const h = await paired();
    const other = await paired();
    h.store().saveApp(other.store().apps()[0] as AppRecord);
    h.policy({ daily: { tasks: 1, usd: 10 } });
    startTether(h, ["--concurrency", "2"]);
    // Both apps are waiting in a long-poll claim, so both passed the cap check before either lands.
    await until(() => h.sent.filter((s) => s.path.endsWith("/claim")).length >= 2);
    const tasks = [h.enqueue({}, { hang: true }), other.enqueue({}, { hang: true })];
    await until(() => tasks.some((t) => existsSync(t.record)));
    await until(() => /daily task cap reached/.test(h.out));
    await sleep(500);
    expect(tasks.filter((t) => existsSync(t.record))).toHaveLength(1);
    const dropped = tasks.find((t) => !existsSync(t.record)) as { id: string };
    const owner = tasks.indexOf(dropped as (typeof tasks)[number]) === 0 ? h : other;
    expect(await owner.status(dropped.id)).toMatchObject({ status: "leased", attempts: 1 });
    expect(h.reports(dropped.id).some((s) => /\/(fail|complete)$/.test(s.path))).toBe(false);
    expect(h.out).toMatch(/left for the app to offer again/);
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

  it("drops the task without a report when the lease is lost", async () => {
    const h = await paired();
    const task = h.enqueue({}, { hang: true });
    startTether(h);
    await until(() => existsSync(task.record));
    h.intercept["/events"] = () => jsonResponse(409, errorBody("lease_lost"));
    await until(() => !alive(record(task.record).pid), 8_000);
    await until(() => /no longer this device's/.test(h.out));
    expect(h.reports(task.id).some((s) => /\/(fail|complete)$/.test(s.path))).toBe(false);
  });

  it("stops the app's running task when the device is revoked mid-task", async () => {
    const h = await paired();
    h.rewrite["/heartbeat"] = (body) => ({ ...body, heartbeat_interval_s: 1 });
    const task = h.enqueue({}, { hang: true });
    const { exit } = startTether(h);
    await until(() => existsSync(task.record));
    await fetch(`${h.app.url}/tether/v1/devices/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.credential()}` },
    });
    expect(await exit).toBe(1);
    expect(h.err).toMatch(/Pair again: tether connect/);
    expect(alive(record(task.record).pid)).toBe(false);
    expect(h.reports(task.id).some((s) => /\/(fail|complete)$/.test(s.path))).toBe(false);
  });

  it("drops events the app refuses and still completes the task", async () => {
    const h = await paired();
    let refusals = 1;
    h.intercept["/events"] = () =>
      refusals-- > 0 ? jsonResponse(400, errorBody("invalid_request")) : undefined;
    const task = h.enqueue({}, { delay_ms: 700 });
    startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "completed", 15_000);
    expect(refusals).toBeLessThan(0);
  });

  it("keeps trying an app that is down at start and stops cleanly", async () => {
    const h = await paired();
    await h.app.close();
    const { exit, stop } = startTether(h);
    await until(() => /retrying/.test(h.out));
    stop.abort();
    expect(await exit).toBe(0);
    h.app = await startFakeApp();
  });

  it("refuses a second start while one is running", async () => {
    const h = await paired();
    startTether(h);
    await until(() => /online/.test(h.out));
    h.out = "";
    expect(await h.run(["status"])).toBe(0);
    expect(h.out).toMatch(/Tether is running/);
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

/** Runs `tether start` as its own process through the real entry point, as a user's shell would. */
function startBin(h: Harness) {
  const child = spawn("bun", [BIN, "start"], {
    env: {
      TETHER_HOME: h.home,
      TETHER_CLAUDE_PATH: FAKE_CLAUDE,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  child.stdout.resume();
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  cleanups.push(() => {
    child.kill("SIGKILL");
    return exit;
  });
  return { child, exit, stderr: () => err };
}

/** The fake claude under another name, which picks a broken installation (see claude.mjs). */
function fakeClaudeAs(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tether-test-claude-"));
  symlinkSync(FAKE_CLAUDE, join(dir, name));
  return join(dir, name);
}

describe.concurrent("tether doctor", () => {
  it("passes a signed-in Claude Code of the checked version and a reachable app", async () => {
    const h = await paired();
    h.out = "";
    expect(await h.run(["doctor"])).toBe(0);
    expect(h.out).toMatch(/^ok {4}Claude Code 2\.1\.325/m);
    expect(h.out).toMatch(/^ok {4}Claude Code is signed in/m);
    expect(h.out).toMatch(/^ok {4}Flags: .*2\.1\.325/m);
    expect(h.out).toMatch(/^ok {4}Fake App .*accepts this device/m);
    expect(h.out).not.toMatch(/^FAIL/m);
    expect(h.sent.at(-1)?.path).toMatch(/\/tasks\//);
    h.expectNoSecrets();
  });

  it("reports a missing agent CLI clearly and fails", async () => {
    const h = await harness();
    h.extraEnv.TETHER_CLAUDE_PATH = join(h.scratch, "no-such-claude");
    expect(await h.run(["doctor"])).toBe(1);
    expect(h.out).toMatch(/^FAIL {2}Claude Code was not found at .*no-such-claude\. Install it/m);
    expect(h.out).not.toMatch(/signed in/);
  });

  it("reports a signed-out agent CLI clearly and fails", async () => {
    const h = await harness();
    h.extraEnv.TETHER_CLAUDE_PATH = fakeClaudeAs("claude-signed-out");
    expect(await h.run(["doctor"])).toBe(1);
    expect(h.out).toMatch(/^FAIL {2}Claude Code is not signed in\. Run: claude auth login/m);
  });

  it("fails a flag the installed version does not list, and only warns about a hidden one", async () => {
    const h = await harness();
    h.extraEnv.TETHER_CLAUDE_PATH = fakeClaudeAs("claude-old");
    expect(await h.run(["doctor"])).toBe(1);
    expect(h.out).toMatch(/^FAIL {2}Flags: --restricted is not in `claude --help` of 2\.0\.9/m);
    expect(h.out).toMatch(
      /^warn {2}Flags: --append-system-prompt-file is hidden from `claude --help`/m,
    );
    expect(h.out).not.toMatch(/--strict-mcp-config is not/);
  });

  it("tells the user to pair again when the app no longer accepts the device", async () => {
    const h = await paired();
    await fetch(`${h.app.url}/tether/v1/devices/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.credential()}` },
    });
    expect(await h.run(["doctor"])).toBe(1);
    expect(h.out).toMatch(/^FAIL {2}Fake App .*Pair again: tether connect/m);
    h.expectNoSecrets();
  });

  it("reports an app it cannot reach", async () => {
    const h = await paired();
    h.intercept["/.well-known/tether"] = () => new Response("down", { status: 503 });
    expect(await h.run(["doctor"])).toBe(1);
    expect(h.out).toMatch(/^FAIL {2}Fake App .*could not be reached/m);
  });

  it("says when no app is connected, without failing", async () => {
    const h = await harness();
    expect(await h.run(["doctor"])).toBe(0);
    expect(h.out).toMatch(/^warn {2}No apps connected/m);
  });
});

describe.concurrent("tether logs", () => {
  it("lists each finished task with app, type, duration, cost and how it ended", async () => {
    const h = await paired();
    const done = h.enqueue({ type: "paper.summarise", title: "Summarise the notes" });
    const failed = h.enqueue(
      { type: "paper.big", limits: { timeout_s: 60, max_budget_usd: 0.5 } },
      { fixture: "budget" },
    );
    const { exit, stop } = startTether(h);
    await untilAsync(async () => (await h.status(done.id)).status === "completed");
    await untilAsync(async () => (await h.status(failed.id)).status === "failed");
    stop.abort();
    await exit;
    h.out = "";
    expect(await h.run(["logs"])).toBe(0);
    const lines = h.out.trim().split("\n");
    const of = (id: string) => lines.find((line) => line.includes(id)) ?? "";
    expect(of(done.id)).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}Fake App {2}paper\.summarise {2}\S+ {2}\d+\.\d s {2}\$\d+\.\d{4} {2}complete {2}Summarise the notes$/,
    );
    expect(of(failed.id)).toMatch(/paper\.big .*fail: budget/);
    expect(statSync(join(h.home, "tasks.jsonl")).mode & 0o777).toBe(0o600);
    h.expectNoSecrets();
  });

  it("logs a task left to the app on shutdown as left", async () => {
    const h = await paired();
    const task = h.enqueue({}, { hang: true });
    const { exit, stop } = startTether(h);
    await until(() => existsSync(task.record));
    stop.abort();
    await exit;
    h.out = "";
    expect(await h.run(["logs", "--limit", "1"])).toBe(0);
    expect(h.out).toMatch(
      new RegExp(`${task.id} {2}\\d+\\.\\d s {2}(\\$\\d+\\.\\d{4}|-) {2}left {2}`),
    );
  });

  it("cleans what the app wrote before printing it", async () => {
    const h = await paired();
    const task = h.enqueue({ title: "evil\u001b[2Jtitle" });
    const { exit, stop } = startTether(h);
    await untilAsync(async () => (await h.status(task.id)).status === "completed");
    stop.abort();
    await exit;
    h.out = "";
    await h.run(["logs"]);
    expect(h.out).not.toContain("\u001b");
  });

  it("says when there is nothing to show, and refuses a bad limit", async () => {
    const h = await harness();
    expect(await h.run(["logs"])).toBe(0);
    expect(h.out).toContain("No tasks have run yet.");
    expect(await h.run(["logs", "--limit", "0"])).toBe(2);
  });
});

describe.concurrent("tether start, stopped by a signal", () => {
  it("stops on SIGHUP as on Ctrl-C: the agent is stopped and the lease is left to expire", async () => {
    const h = await paired();
    const task = h.enqueue({}, { hang: true });
    const { child, exit, stderr } = startBin(h);
    await until(() => existsSync(task.record), 15_000);
    child.kill("SIGHUP");
    expect(await exit).toBe(0);
    expect(stderr()).toMatch(/Stopping: running tasks are left/);
    expect(alive(record(task.record).pid)).toBe(false);
    expect(h.reports(task.id).some((s) => /\/(fail|complete)$/.test(s.path))).toBe(false);
  });

  it("kills every agent and removes its files before exiting on a second signal", async () => {
    const h = await paired();
    const task = h.enqueue({}, { hang: true, ignore_term: true, grandchild: true });
    const { child, exit } = startBin(h);
    await until(() => existsSync(task.record), 15_000);
    const run = record(task.record);
    child.kill("SIGINT");
    await sleep(200);
    child.kill("SIGINT");
    const started = Date.now();
    expect(await exit).toBe(130);
    expect(Date.now() - started).toBeLessThan(3_000);
    await until(() => !alive(run.pid) && !alive(run.grandchildPid), 2_000);
    expect(existsSync(dirname(run.cwd))).toBe(false);
  });
});
