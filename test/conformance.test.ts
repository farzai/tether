import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { main, USAGE } from "../src/conformance/command.ts";
import { type CheckResult, runConformance } from "../src/conformance/runner.ts";
import { type FakeAppOptions, type RouteKey, startFakeApp } from "./fake-app/server.ts";

const SECRET = "conformance-test-secret-0123456789";

/** Runs `fn` against its own fake app, so tests can run concurrently. */
async function withFake<T>(
  options: Partial<FakeAppOptions>,
  fn: (app: Awaited<ReturnType<typeof startFakeApp>>) => Promise<T>,
): Promise<T> {
  const app = await startFakeApp(options);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

/** A URL where nothing listens: a fake app's address after it closed. */
const closedUrl = () => withFake({}, async (app) => app.url);

const runAgainst = (options: Partial<FakeAppOptions>, hookSecret: string | undefined = SECRET) =>
  withFake({ hookSecret: SECRET, ...options }, async (app) => ({
    app,
    run: await runConformance(hookSecret ? { baseUrl: app.url, hookSecret } : { baseUrl: app.url }),
  }));

const failures = (results: CheckResult[]) => results.filter((r) => r.outcome === "fail");
const skips = (results: CheckResult[]) => results.filter((r) => r.outcome === "skip");
const failedNames = (results: CheckResult[]) => failures(results).map((r) => r.name);

describe.concurrent("conformance suite against the fake app server", () => {
  it("passes every check and never prints a secret", async () => {
    const { app, run } = await runAgainst({});
    expect(failures(run.results)).toEqual([]);
    expect(skips(run.results)).toEqual([]);
    expect(run.results.length).toBeGreaterThan(20);
    expect(run.ok).toBe(true);
    const secrets = [...app.issuedSecrets(), SECRET];
    expect(secrets.length).toBeGreaterThan(5);
    for (const secret of secrets) expect(run.report).not.toContain(secret);
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

describe.concurrent("conformance suite against a server missing an endpoint", () => {
  it.each(ROUTES)("fails clearly without %s", async (route, line) => {
    const { run } = await runAgainst({ removeRoutes: [route] });
    expect(run.ok).toBe(false);
    const named = failures(run.results).filter((r) => line.test(r.message ?? ""));
    expect(named.length).toBeGreaterThan(0);
    expect(named[0]?.message).toContain("looks missing");
    expect(run.report).toMatch(line);
  });

  it("keeps passing the checks that do not need the missing endpoint", async () => {
    const { run } = await runAgainst({ removeRoutes: ["task_fail"] });
    const passed = run.results.filter((r) => r.outcome === "pass").map((r) => r.name);
    expect(passed).toContain("discovery document");
    expect(passed).toContain("complete is idempotent per lease");
  });
});

describe.concurrent("conformance suite against a misbehaving server", () => {
  it("fails the auth checks when the server skips authentication", async () => {
    const { run } = await runAgainst({ misbehave: { skipAuth: true } });
    expect(failedNames(run.results)).toContain(
      "authenticated endpoints reject a missing credential",
    );
  });

  it("fails when the server lets another device see a task", async () => {
    const { run } = await runAgainst({ misbehave: { shareTasks: true } });
    expect(failedNames(run.results)).toContain("another device cannot see the task");
  });

  it("fails when the server rejects a report on a cancelled task", async () => {
    const { run } = await runAgainst({ misbehave: { rejectReportOnCancelled: true } });
    expect(failedNames(run.results)).toContain("cancel reaches the client");
  });
});

describe.concurrent("conformance suite without hooks", () => {
  it("runs the public checks and skips the rest with the reason", async () => {
    const { run } = await runAgainst({}, "");
    expect(run.ok).toBe(false);
    expect(failures(run.results)).toEqual([]);
    expect(run.results.find((r) => r.name === "discovery document")?.outcome).toBe("pass");
    expect(skips(run.results).length).toBeGreaterThan(0);
    expect(run.report).toContain("no conformance hook secret");
  });

  it("skips the hook checks when the server does not advertise hooks", async () => {
    const run = await withFake({}, (app) =>
      runConformance({ baseUrl: app.url, hookSecret: SECRET }),
    );
    expect(run.results.find((r) => r.name === "pair_start returns codes")?.outcome).toBe("pass");
    expect(skips(run.results)[0]?.message).toContain("does not advertise conformance hooks");
  });
});

describe.concurrent("conformance command", () => {
  const run = async (args: string[], env: Record<string, string> = {}) => {
    let stdout = "";
    let stderr = "";
    const status = await main(
      args,
      env,
      { write: (text: string) => (stdout += text) },
      { write: (text: string) => (stderr += text) },
    );
    return { status, stdout, stderr };
  };
  const withHooks = <T>(options: Partial<FakeAppOptions>, fn: (url: string) => Promise<T>) =>
    withFake({ hookSecret: SECRET, ...options }, (app) => fn(app.url));

  it("exits 0 when every check passes, with the secret from the environment", async () => {
    const result = await withHooks({}, (url) => run([url], { TETHER_CONFORMANCE_SECRET: SECRET }));
    expect(result.stdout).toContain("28 passed, 0 failed, 0 skipped");
    expect(result.status).toBe(0);
  });

  it("exits 1 when a check fails, with the secret from the flag", async () => {
    const result = await withHooks({ removeRoutes: ["heartbeat"] }, (url) =>
      run([url, "--hook-secret", SECRET]),
    );
    expect(result.stdout).toMatch(/FAIL {2}heartbeat/);
    expect(result.stdout).not.toContain("no conformance hook secret");
    expect(result.status).toBe(1);
  });

  it("exits 1 when checks were skipped for want of a secret", async () => {
    const result = await withHooks({}, (url) => run([url], { TETHER_CONFORMANCE_SECRET: "" }));
    expect(result.stdout).toContain("no conformance hook secret");
    expect(result.status).toBe(1);
  });

  it.each([
    [[]],
    [["not a url"]],
    [["http://127.0.0.1:1", "--hook-secret"]],
    [["--bogus"]],
    [["http://a", "http://b"]],
  ])("exits 2 on a usage error (%j)", async (args) => {
    const result = await run(args);
    expect(result.stderr).toBe(USAGE);
    expect(result.stdout).toBe("");
    expect(result.status).toBe(2);
  });

  it("reports a server it cannot reach", async () => {
    const result = await run([await closedUrl(), "--hook-secret", SECRET]);
    expect(result.stdout).toMatch(
      /GET \/\.well-known\/tether: could not reach the server \(Error: connect ECONNREFUSED/,
    );
    expect(result.status).toBe(1);
  });
});

describe.concurrent("conformance CLI entry point", () => {
  const cli = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("bun", ["src/conformance/cli.ts", ...args]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  it("sets the exit status from the command", async () => {
    const usage = await cli([]);
    expect(usage.stderr).toBe(USAGE);
    expect(usage.status).toBe(2);
    const unreachable = await cli([await closedUrl(), "--hook-secret", SECRET]);
    expect(unreachable.stdout).toContain("could not reach");
    expect(unreachable.status).toBe(1);
  });
});
