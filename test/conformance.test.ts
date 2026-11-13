import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  ["revoke", /POST \/tether\/v1\/devices\/revoke -> 404/],
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

  it.each([
    ["task", "another device cannot see the task"],
    ["task_events", "another device cannot see the task"],
    ["task_complete", "another device cannot see the task"],
    ["task_fail", "another device cannot see the task"],
    ["claim", "another user's device cannot claim the task"],
    ["heartbeat", "a cancel reaches only the task's own user"],
  ] as const)("fails when %s skips the ownership check", async (route, check) => {
    const { run } = await runAgainst({ misbehave: { shareTasks: [route] } });
    expect(failedNames(run.results)).toContain(check);
  });

  it.each([
    ["noRenew", "events renew the lease"],
    ["redeliverCredential", "a delivered credential is not delivered again"],
    ["reusableUserCode", "a user code approves only one pairing"],
    ["ignoreRevoke", "revoke ends the device credential"],
  ] as const)("fails when the server misbehaves with %s", async (flag, check) => {
    const { run } = await runAgainst({ misbehave: { [flag]: true } });
    expect(failedNames(run.results)).toContain(check);
  });

  it.each([
    ["always", "claim returns a task enqueued while it waits"],
    ["onRetry", "an expired lease makes the task claimable again"],
  ] as const)("fails when the server hands out a foreign MCP URL %s", async (when, check) => {
    const { run } = await runAgainst({ misbehave: { foreignMcpUrl: when } });
    const failed = failures(run.results).find((r) => r.name === check);
    expect(failed?.message).toContain("is not the discovery mcp endpoint");
  });

  it("passes a server that answers claim with 204 at once, as section 7 allows", async () => {
    const { run } = await runAgainst({ misbehave: { noLongPoll: true } });
    expect(failures(run.results)).toEqual([]);
    expect(run.ok).toBe(true);
  });

  it("fails when the server rejects a report on a cancelled task", async () => {
    const { run } = await runAgainst({ misbehave: { rejectReportOnCancelled: true } });
    expect(failedNames(run.results)).toContain("cancel reaches the client");
  });
});

/** The fake app as if it were served at `https://app.example`. */
const HTTPS_ORIGIN = "https://app.example";
const runAsHttps = (options: Partial<FakeAppOptions>) =>
  withFake({ hookSecret: SECRET, ...options }, (app) =>
    runConformance({
      baseUrl: HTTPS_ORIGIN,
      hookSecret: SECRET,
      fetch: (input, init) => fetch(String(input).replace(HTTPS_ORIGIN, app.url), init),
    }),
  );
const discoveryResult = (run: { results: CheckResult[] }) =>
  run.results.find((r) => r.name === "discovery document");

describe.concurrent("conformance suite against an HTTPS app", () => {
  it("passes the discovery check when the app links are HTTPS", async () => {
    const appLinks = { icon: `${HTTPS_ORIGIN}/icon.png`, url: HTTPS_ORIGIN };
    const run = await runAsHttps({ misbehave: { appLinks } });
    expect(discoveryResult(run)).toEqual({ name: "discovery document", outcome: "pass" });
  });

  it.each(["icon", "url"] as const)("fails when app.%s is plain HTTP on loopback", async (key) => {
    const run = await runAsHttps({ misbehave: { appLinks: { [key]: "http://127.0.0.1:9/x" } } });
    expect(discoveryResult(run)?.outcome).toBe("fail");
    expect(discoveryResult(run)?.message).toBe(`app.${key} must be an HTTPS URL`);
  });

  it.each(["https://app.example%40evil.example/i.png", "https://app.example:99999/i.png"])(
    "fails one check, not the run, when app.icon is %s",
    async (icon) => {
      const run = await runAsHttps({ misbehave: { appLinks: { icon } } });
      expect(failures(run.results).map((r) => r.name)).toEqual(["discovery document"]);
      expect(run.report).toContain("FAIL  discovery document");
    },
  );

  it("fails one check, not the run, when an endpoint has a port WHATWG cannot parse", async () => {
    const run = await runAsHttps({
      misbehave: { endpoints: { revoke: `${HTTPS_ORIGIN}:99999/r` } },
    });
    expect(failures(run.results).map((r) => r.name)).toEqual(["discovery document"]);
    expect(discoveryResult(run)?.message).toBe("endpoint revoke is not a valid URL");
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
    expect(result.stdout).toContain("32 passed, 0 failed, 0 skipped");
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

  it("reports a server that drops the connection in the middle of a body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      res.write('{"protocol":');
      setTimeout(() => res.destroy(), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const result = await run([url, "--hook-secret", SECRET]);
      expect(result.stdout).toMatch(/GET \/\.well-known\/tether: the response was cut off/);
      expect(result.status).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
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
