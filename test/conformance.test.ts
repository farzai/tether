import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { type CheckResult, runConformance } from "../src/conformance/runner.ts";
import { type FakeAppOptions, type RouteKey, startFakeApp } from "./fake-app/server.ts";

const SECRET = "conformance-test-secret-0123456789";
const running: { close(): Promise<void> }[] = [];

async function fake(options: Partial<FakeAppOptions> = {}) {
  const app = await startFakeApp({ hookSecret: SECRET, ...options });
  running.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

const failures = (results: CheckResult[]) => results.filter((r) => r.outcome === "fail");
const skips = (results: CheckResult[]) => results.filter((r) => r.outcome === "skip");

describe("conformance suite against the fake app server", () => {
  it("passes every check", async () => {
    const app = await fake();
    const { results, ok } = await runConformance({ baseUrl: app.url, hookSecret: SECRET });
    expect(failures(results)).toEqual([]);
    expect(skips(results)).toEqual([]);
    expect(results.length).toBeGreaterThan(20);
    expect(ok).toBe(true);
  });

  it("never prints a credential, device code, task token or the hook secret", async () => {
    const app = await fake();
    const { report } = await runConformance({ baseUrl: app.url, hookSecret: SECRET });
    const secrets = [...app.issuedSecrets(), SECRET];
    expect(secrets.length).toBeGreaterThan(5);
    for (const secret of secrets) expect(report).not.toContain(secret);
  });
});

const ROUTES: [RouteKey, RegExp][] = [
  ["discovery", /GET \/\.well-known\/tether -> 404/],
  ["pair_start", /POST \/tether\/v1\/pair\/start -> 404/],
  ["pair_poll", /POST \/tether\/v1\/pair\/poll -> 404/],
  ["heartbeat", /POST \/tether\/v1\/heartbeat -> 404/],
  ["claim", /POST \/tether\/v1\/tasks\/claim -> 404/],
  ["task", /GET \/tether\/v1\/tasks\/[^/\s]+ -> 404/],
  ["task_events", /POST \/tether\/v1\/tasks\/[^/\s]+\/events -> 404/],
  ["task_complete", /POST \/tether\/v1\/tasks\/[^/\s]+\/complete -> 404/],
  ["task_fail", /POST \/tether\/v1\/tasks\/[^/\s]+\/fail -> 404/],
];

describe("conformance suite against a server missing an endpoint", () => {
  it.concurrent.each(ROUTES)("fails clearly without %s", async (route, line) => {
    const app = await fake({ removeRoutes: [route] });
    const { results, ok, report } = await runConformance({ baseUrl: app.url, hookSecret: SECRET });
    expect(ok).toBe(false);
    const named = failures(results).filter((r) => line.test(r.message ?? ""));
    expect(named.length).toBeGreaterThan(0);
    expect(named[0]?.message).toContain("looks missing");
    expect(report).toMatch(line);
  });

  it("keeps passing the checks that do not need the missing endpoint", async () => {
    const app = await fake({ removeRoutes: ["task_fail"] });
    const { results } = await runConformance({ baseUrl: app.url, hookSecret: SECRET });
    const passed = results.filter((r) => r.outcome === "pass").map((r) => r.name);
    expect(passed).toContain("discovery document");
    expect(passed).toContain("complete is idempotent per lease");
  });
});

describe("conformance suite against a misbehaving server", () => {
  it("fails the auth checks when the server skips authentication", async () => {
    const app = await fake({ misbehave: { skipAuth: true } });
    const { results } = await runConformance({ baseUrl: app.url, hookSecret: SECRET });
    const failed = failures(results).map((r) => r.name);
    expect(failed).toContain("authenticated endpoints reject a missing credential");
  });

  it("fails when the server lets another device see a task", async () => {
    const app = await fake({ misbehave: { shareTasks: true } });
    const { results } = await runConformance({ baseUrl: app.url, hookSecret: SECRET });
    expect(failures(results).map((r) => r.name)).toContain("another device cannot see the task");
  });

  it("fails when the server rejects a report on a cancelled task", async () => {
    const app = await fake({ misbehave: { rejectReportOnCancelled: true } });
    const { results } = await runConformance({ baseUrl: app.url, hookSecret: SECRET });
    expect(failures(results).map((r) => r.name)).toContain("cancel reaches the client");
  });
});

describe("conformance suite without hooks", () => {
  it("runs the public checks and skips the rest with the reason", async () => {
    const app = await fake();
    const { results, ok, report } = await runConformance({ baseUrl: app.url });
    expect(ok).toBe(false);
    expect(failures(results)).toEqual([]);
    expect(results.find((r) => r.name === "discovery document")?.outcome).toBe("pass");
    expect(skips(results).length).toBeGreaterThan(0);
    expect(report).toContain("no conformance hook secret");
  });

  it("skips the hook checks when the server does not advertise hooks", async () => {
    const app = await startFakeApp({});
    running.push(app);
    const { results } = await runConformance({ baseUrl: app.url, hookSecret: SECRET });
    expect(results.find((r) => r.name === "pair_start returns codes")?.outcome).toBe("pass");
    expect(skips(results)[0]?.message).toContain("does not advertise conformance hooks");
  });
});

describe("conformance CLI", () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bun", ["src/conformance/cli.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, TETHER_CONFORMANCE_SECRET: "", ...env },
    });

  it("exits 0 when every check passes", async () => {
    const app = await fake();
    const run = cli([app.url, "--hook-secret", SECRET]);
    expect(run.stdout).toContain("0 failed, 0 skipped");
    expect(run.status).toBe(0);
  });

  it("reads the hook secret from the environment", async () => {
    const app = await fake();
    const run = cli([app.url], { TETHER_CONFORMANCE_SECRET: SECRET });
    expect(run.status).toBe(0);
  });

  it("exits 1 when a check fails", async () => {
    const app = await fake({ removeRoutes: ["heartbeat"] });
    const run = cli([app.url, "--hook-secret", SECRET]);
    expect(run.stdout).toMatch(/FAIL/);
    expect(run.status).toBe(1);
  });

  it.each([[[]], [["not a url"]], [["http://127.0.0.1:1", "--hook-secret"]], [["--bogus"]]])(
    "exits 2 on a usage error (%j)",
    (args) => {
      const run = cli(args);
      expect(run.stderr).toContain("Usage: bun run conformance <base-url>");
      expect(run.status).toBe(2);
    },
  );

  it("exits 1 when the server cannot be reached", () => {
    const run = cli(["http://127.0.0.1:9", "--hook-secret", SECRET]);
    expect(run.stdout).toContain("could not reach");
    expect(run.status).toBe(1);
  });
});
