import { setTimeout as sleep } from "node:timers/promises";
import { isAllowedUrl } from "../protocol/urls.ts";
import {
  CheckFailure,
  type Discovery,
  expectBody,
  expectEqual,
  expectError,
  expectStatus,
  expectThat,
  type Http,
  type Reply,
} from "./http.ts";

/** What a check needs from earlier checks; the runner skips the check when one is missing. */
export type Need =
  | "discovery"
  | "hooks"
  | "pairing"
  | "device"
  | "deviceB"
  | "claimed"
  | "completed";

export interface Context {
  http: Http;
  hookSecret?: string;
  pairing?: { deviceCode: string; userCode: string; intervalS: number };
  device?: string;
  deviceB?: string;
  claimed?: { taskId: string; lease: Lease };
  completed?: boolean;
}

export interface Check {
  name: string;
  needs: Need[];
  run(ctx: Context): Promise<void>;
}

interface Lease {
  id: string;
  expires_at: string;
  duration_s: number;
}

interface Claimed {
  task: { id: string; mcp: { url: string; token: string } };
  lease: Lease;
  attempt: number;
}

const CLIENT = { name: "tether-conformance", version: "1" };
const UNKNOWN_TASK = "tsk_conformance_unknown";
const LONG_POLL_S = 10;
/** Long enough that a renewal lands on a later second than the claim, even on second precision. */
const RENEW_GAP_MS = 1_100;

// Helpers

const hook = (ctx: Context, key: string, body?: unknown, id?: string) =>
  ctx.http.call("POST", key, {
    body,
    hookSecret: ctx.hookSecret as string,
    credential: ctx.device as string,
    ...(id === undefined ? {} : { id }),
  });

async function startPairing(ctx: Context) {
  const reply = await ctx.http.call("POST", "pair_start", {
    body: { client: CLIENT, device_name: "Conformance" },
  });
  return expectBody<{
    device_code: string;
    user_code: string;
    interval: number;
    verification_uri: string;
    verification_uri_complete?: string;
  }>(reply, 200, "pair-start.response");
}

async function poll(ctx: Context, deviceCode: string) {
  const reply = await ctx.http.call("POST", "pair_poll", { body: { device_code: deviceCode } });
  return expectBody<{ status: string; credential?: string }>(reply, 200, "pair-poll.response");
}

async function answer(ctx: Context, key: "pair_approve" | "pair_deny", userCode: string) {
  const reply = await ctx.http.call("POST", key, {
    body: { user_code: userCode },
    hookSecret: ctx.hookSecret as string,
  });
  expectStatus(reply, 204);
}

async function pairNewDevice(ctx: Context): Promise<string> {
  const started = await startPairing(ctx);
  await answer(ctx, "pair_approve", started.user_code);
  const result = await poll(ctx, started.device_code);
  expectEqual("pair_poll status after approval", result.status, "approved");
  return result.credential as string;
}

/** A context with a newly paired device of its own fresh user, so no earlier task leaks in. */
async function freshUser(ctx: Context): Promise<Context> {
  return { ...ctx, device: await pairNewDevice(ctx) };
}

async function enqueue(ctx: Context, leaseS?: number): Promise<string> {
  const body = leaseS === undefined ? {} : { lease_s: leaseS };
  const task = expectBody<{ id: string }>(await hook(ctx, "enqueue", body), 201, "task");
  return task.id;
}

const claimCall = (ctx: Context, waitS: number, credential = ctx.device) =>
  ctx.http.call("POST", "claim", { body: { wait_s: waitS }, credential: credential as string });

/**
 * Claims until a task arrives or `LONG_POLL_S` passes. Section 7 lets a server answer 204 before
 * `wait_s`, so a 204 only means "claim again".
 */
async function claim(ctx: Context): Promise<Claimed> {
  const deadline = Date.now() + LONG_POLL_S * 1000;
  for (;;) {
    const waitS = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const reply = await claimCall(ctx, waitS);
    if (reply.status !== 204 || Date.now() >= deadline) {
      return expectMcpUrl(ctx, expectBody<Claimed>(reply, 200, "claim.response"));
    }
    await sleep(50);
  }
}

/** Section 6: every claimed task's `mcp.url` is the discovery `mcp` endpoint, on every claim. */
function expectMcpUrl(ctx: Context, claimed: Claimed): Claimed {
  const expected = ctx.http.url("mcp").href;
  expectThat(
    claimed.task.mcp.url === expected,
    `claimed task ${claimed.task.id} (attempt ${claimed.attempt}): mcp.url is not the discovery mcp endpoint ${expected}`,
  );
  return claimed;
}

async function enqueueAndClaim(ctx: Context, leaseS?: number): Promise<Claimed> {
  const taskId = await enqueue(ctx, leaseS);
  const claimed = await claim(ctx);
  expectEqual("claimed task id", claimed.task.id, taskId);
  return claimed;
}

/** Calls a task endpoint; `task` is the only GET and carries no body. */
const taskCall = (
  ctx: Context,
  key: string,
  id: string,
  body?: unknown,
  credential = ctx.device,
) =>
  key === "task"
    ? ctx.http.call("GET", key, { id, credential: credential as string })
    : ctx.http.call("POST", key, { id, body, credential: credential as string });

const events = (ctx: Context, id: string, leaseId: string, list: unknown[] = []) =>
  taskCall(ctx, "task_events", id, { lease_id: leaseId, events: list });

const complete = (ctx: Context, id: string, leaseId: string) =>
  taskCall(ctx, "task_complete", id, { lease_id: leaseId, exit_code: 0, duration_ms: 10 });

const fail = (ctx: Context, id: string, leaseId: string, reason = "agent_error") =>
  taskCall(ctx, "task_fail", id, { lease_id: leaseId, reason });

async function expectTaskStatus(ctx: Context, id: string, status: string) {
  const body = expectBody<{ status: string }>(
    await taskCall(ctx, "task", id),
    200,
    "task-status.response",
  );
  expectEqual(`task status of ${id}`, body.status, status);
  return body;
}

async function expectReport(reply: Promise<Reply>, schema: string, status: string) {
  const body = expectBody<{ status: string }>(await reply, 200, schema);
  expectEqual(`${schema} status`, body.status, status);
}

/** HTTPS, or plain HTTP only when the app itself is on loopback. */
function expectSafeUrl(ctx: Context, label: string, value: string) {
  expectThat(isAllowedUrl(ctx.http.origin, value), `${label} must be an HTTPS URL`);
}

/** Settles both, then reports the first failure, so no request is left running into later checks. */
async function both<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [ra, rb] = await Promise.allSettled([a, b]);
  if (ra.status === "rejected") throw ra.reason;
  if (rb.status === "rejected") throw rb.reason;
  return [ra.value, rb.value];
}

// Discovery and pairing

const discoveryChecks: Check[] = [
  {
    name: "discovery document",
    needs: [],
    async run(ctx) {
      const url = new URL("/.well-known/tether", ctx.http.origin);
      const doc = expectBody<Discovery>(await ctx.http.request("GET", url), 200, "discovery");
      const all = { ...doc.endpoints, ...doc.conformance };
      for (const [key, value] of Object.entries(all)) {
        const resolved = URL.parse(value, ctx.http.origin);
        if (!resolved) throw new CheckFailure(`endpoint ${key} is not a valid URL`);
        expectThat(resolved.origin === ctx.http.origin, `endpoint ${key} is on another origin`);
        expectSafeUrl(ctx, `endpoint ${key}`, resolved.href);
      }
      for (const key of ["icon", "url"] as const) {
        const link = doc.app[key];
        if (link !== undefined) expectSafeUrl(ctx, `app.${key}`, link);
      }
      ctx.http.discovery = doc;
    },
  },
  {
    name: "pair_start returns codes",
    needs: ["discovery"],
    async run(ctx) {
      const started = await startPairing(ctx);
      expectSafeUrl(ctx, "verification_uri", started.verification_uri);
      if (started.verification_uri_complete !== undefined) {
        expectSafeUrl(ctx, "verification_uri_complete", started.verification_uri_complete);
      }
      ctx.pairing = {
        deviceCode: started.device_code,
        userCode: started.user_code,
        intervalS: started.interval,
      };
    },
  },
  {
    name: "pair_start rejects an invalid body",
    needs: ["discovery"],
    async run(ctx) {
      expectError(await ctx.http.call("POST", "pair_start", { body: {} }), 400, "invalid_request");
    },
  },
  {
    name: "pair_poll answers pending",
    needs: ["pairing"],
    async run(ctx) {
      const result = await poll(ctx, ctx.pairing?.deviceCode as string);
      expectEqual("pair_poll status", result.status, "pending");
    },
  },
  {
    name: "pair_poll answers polling too fast with slow_down",
    needs: ["pairing"],
    async run(ctx) {
      const body = { device_code: ctx.pairing?.deviceCode };
      const reply = await ctx.http.call("POST", "pair_poll", { body });
      expectError(reply, 429, "slow_down");
      expectThat(reply.headers.has("retry-after"), `${reply.label}: 429 without Retry-After`);
    },
  },
  {
    name: "pair_poll rejects an unknown device code",
    needs: ["discovery"],
    async run(ctx) {
      const body = { device_code: "dc_conformance_unknown" };
      expectError(await ctx.http.call("POST", "pair_poll", { body }), 404, "not_found");
    },
  },
  {
    name: "conformance hooks require the secret",
    needs: ["hooks"],
    async run(ctx) {
      const reply = await ctx.http.call("POST", "pair_approve", { body: { user_code: "NONE" } });
      expectError(reply, 401, "unauthorized");
    },
  },
  {
    name: "approved pairing returns a credential",
    needs: ["pairing", "hooks"],
    async run(ctx) {
      const pairing = ctx.pairing as NonNullable<Context["pairing"]>;
      await answer(ctx, "pair_approve", pairing.userCode);
      await sleep(pairing.intervalS * 1000);
      const result = await poll(ctx, pairing.deviceCode);
      expectEqual("pair_poll status after approval", result.status, "approved");
      ctx.device = result.credential as string;
    },
  },
  {
    name: "a delivered credential is not delivered again",
    needs: ["pairing", "device"],
    async run(ctx) {
      const pairing = ctx.pairing as NonNullable<Context["pairing"]>;
      await sleep(pairing.intervalS * 1000);
      const again = await poll(ctx, pairing.deviceCode);
      expectEqual("pair_poll status after the credential was delivered", again.status, "expired");
    },
  },
  {
    name: "a user code approves only one pairing",
    needs: ["pairing", "device"],
    async run(ctx) {
      const reply = await ctx.http.call("POST", "pair_approve", {
        body: { user_code: ctx.pairing?.userCode },
        hookSecret: ctx.hookSecret as string,
      });
      expectError(reply, 404, "not_found");
    },
  },
  {
    name: "denied pairing",
    needs: ["hooks"],
    async run(ctx) {
      const started = await startPairing(ctx);
      await answer(ctx, "pair_deny", started.user_code);
      expectEqual(
        "pair_poll status after deny",
        (await poll(ctx, started.device_code)).status,
        "denied",
      );
    },
  },
  {
    name: "pairs a second device",
    needs: ["hooks"],
    async run(ctx) {
      ctx.deviceB = await pairNewDevice(ctx);
      expectThat(ctx.deviceB !== ctx.device, "two pairings returned the same credential");
    },
  },
];

// Authentication

const AUTHENTICATED: [string, unknown][] = [
  ["heartbeat", { client: CLIENT, adapters: [], capacity: { max: 1, available: 1 }, tasks: [] }],
  ["claim", { wait_s: 0 }],
  ["task", undefined],
  ["task_events", { lease_id: "lse_x", events: [] }],
  ["task_complete", { lease_id: "lse_x", exit_code: 0, duration_ms: 1 }],
  ["task_fail", { lease_id: "lse_x", reason: "agent_error" }],
];

const authChecks: Check[] = [
  {
    name: "authenticated endpoints reject a missing credential",
    needs: ["discovery"],
    async run(ctx) {
      for (const [key, body] of AUTHENTICATED) {
        const method = key === "task" ? "GET" : "POST";
        const reply = await ctx.http.call(method, key, { body, id: UNKNOWN_TASK });
        expectError(reply, 401, "unauthorized");
      }
    },
  },
  {
    name: "an unknown credential is rejected",
    needs: ["discovery"],
    async run(ctx) {
      const [key, body] = AUTHENTICATED[0] as [string, unknown];
      const reply = await ctx.http.call("POST", key, {
        body,
        credential: "tdc_conformance_unknown",
      });
      expectError(reply, 401, "unauthorized");
    },
  },
  {
    name: "heartbeat",
    needs: ["device"],
    async run(ctx) {
      const [, body] = AUTHENTICATED[0] as [string, unknown];
      const reply = await ctx.http.call("POST", "heartbeat", {
        body,
        credential: ctx.device as string,
      });
      const result = expectBody<{ cancelled: string[] }>(reply, 200, "heartbeat.response");
      expectEqual("heartbeat cancelled", result.cancelled, []);
    },
  },
  {
    name: "an unknown task is not_found",
    needs: ["device"],
    async run(ctx) {
      expectError(await taskCall(ctx, "task", UNKNOWN_TASK), 404, "not_found");
    },
  },
  {
    name: "revoke ends the device credential",
    needs: ["hooks"],
    async run(ctx) {
      const credential = await pairNewDevice(ctx);
      expectStatus(await ctx.http.call("POST", "revoke", { credential }), 204);
      const [, body] = AUTHENTICATED[0] as [string, unknown];
      const after = await ctx.http.call("POST", "heartbeat", { body, credential });
      expectError(after, 401, "unauthorized");
    },
  },
];

// Claim and the lifecycle of one task

const lifecycleChecks: Check[] = [
  {
    name: "claim answers 204 when there is nothing to do",
    needs: ["device"],
    async run(ctx) {
      const reply = await ctx.http.call("POST", "claim", {
        body: { wait_s: 1 },
        credential: ctx.device as string,
      });
      expectStatus(reply, 204);
    },
  },
  {
    name: "claim returns a task enqueued while it waits",
    needs: ["device", "hooks"],
    async run(ctx) {
      const started = Date.now();
      const [claimed, taskId] = await both(
        claim(ctx),
        sleep(300).then(() => enqueue(ctx)),
      );
      expectEqual("claimed task id", claimed.task.id, taskId);
      expectEqual("attempt", claimed.attempt, 1);
      expectThat(
        Date.now() - started < (LONG_POLL_S - 1) * 1000,
        "claim did not answer when the task arrived",
      );
      ctx.claimed = { taskId, lease: claimed.lease };
    },
  },
  {
    name: "task status shows the lease",
    needs: ["claimed"],
    async run(ctx) {
      const body = await expectTaskStatus(ctx, ctx.claimed?.taskId as string, "leased");
      expectEqual("attempts", (body as { attempts?: number }).attempts, 1);
    },
  },
  {
    name: "another device cannot see the task",
    needs: ["claimed", "deviceB"],
    async run(ctx) {
      const { taskId, lease } = ctx.claimed as NonNullable<Context["claimed"]>;
      const bodies: [string, unknown][] = [
        ["task", undefined],
        ["task_events", { lease_id: lease.id, events: [] }],
        ["task_complete", { lease_id: lease.id, exit_code: 0, duration_ms: 1 }],
        ["task_fail", { lease_id: lease.id, reason: "agent_error" }],
      ];
      for (const [key, body] of bodies) {
        expectError(await taskCall(ctx, key, taskId, body, ctx.deviceB), 404, "not_found");
      }
    },
  },
  {
    name: "events renew the lease",
    needs: ["claimed"],
    async run(ctx) {
      const { taskId, lease } = ctx.claimed as NonNullable<Context["claimed"]>;
      const list = [{ at: new Date().toISOString(), stage: "started", message: "conformance" }];
      await sleep(RENEW_GAP_MS);
      for (const batch of [list, []]) {
        const reply = await events(ctx, taskId, lease.id, batch);
        const body = expectBody<{ status: string; lease: Lease }>(
          reply,
          200,
          "task-events.response",
        );
        expectEqual("events status", body.status, "leased");
        expectEqual("renewed lease id", body.lease.id, lease.id);
        expectThat(
          Date.parse(body.lease.expires_at) > Date.parse(lease.expires_at),
          "events did not move the lease expiry forward",
        );
      }
    },
  },
  {
    name: "events with a wrong lease are lease_lost",
    needs: ["claimed"],
    async run(ctx) {
      const reply = await events(ctx, ctx.claimed?.taskId as string, "lse_conformance_wrong");
      expectError(reply, 409, "lease_lost");
    },
  },
  {
    name: "complete is idempotent per lease",
    needs: ["claimed"],
    async run(ctx) {
      const { taskId, lease } = ctx.claimed as NonNullable<Context["claimed"]>;
      await expectReport(complete(ctx, taskId, lease.id), "task-complete.response", "completed");
      await expectReport(complete(ctx, taskId, lease.id), "task-complete.response", "completed");
      await expectTaskStatus(ctx, taskId, "completed");
      ctx.completed = true;
    },
  },
  {
    name: "a completed task refuses fail and events",
    needs: ["completed"],
    async run(ctx) {
      const { taskId, lease } = ctx.claimed as NonNullable<Context["claimed"]>;
      expectError(await fail(ctx, taskId, lease.id), 409, "invalid_state");
      expectError(await events(ctx, taskId, lease.id), 409, "invalid_state");
    },
  },
];

// Fail, cancel, isolation and lease expiry, each for its own fresh user

/** An outcome check: runs `body` with a fresh user, so a task left by an earlier check cannot leak in. */
const outcome = (
  name: string,
  body: (ctx: Context) => Promise<void>,
  extra: Need[] = [],
): Check => ({
  name,
  needs: ["device", "hooks", ...extra],
  run: async (ctx) => body(await freshUser(ctx)),
});

const outcomeChecks: Check[] = [
  outcome("fail is idempotent per lease", async (ctx) => {
    const { task, lease } = await enqueueAndClaim(ctx);
    await expectReport(fail(ctx, task.id, lease.id), "task-fail.response", "failed");
    await expectReport(fail(ctx, task.id, lease.id), "task-fail.response", "failed");
    expectError(await complete(ctx, task.id, lease.id), 409, "invalid_state");
    await expectTaskStatus(ctx, task.id, "failed");
  }),
  outcome("fail rejects an unknown reason", async (ctx) => {
    const { task, lease } = await enqueueAndClaim(ctx);
    expectError(await fail(ctx, task.id, lease.id, "bogus"), 400, "invalid_request");
    await expectReport(fail(ctx, task.id, lease.id), "task-fail.response", "failed");
  }),
  outcome("cancel reaches the client", async (ctx) => {
    const { task, lease } = await enqueueAndClaim(ctx);
    await cancelTask(ctx, task.id);
    await expectTaskStatus(ctx, task.id, "cancelled");
    expectEqual("heartbeat cancelled", await heartbeatCancelled(ctx, task.id), [task.id]);
    await expectReport(events(ctx, task.id, lease.id), "task-events.response", "cancelled");
    const reason = "cancelled_by_user";
    await expectReport(fail(ctx, task.id, lease.id, reason), "task-fail.response", "cancelled");
    await expectReport(complete(ctx, task.id, lease.id), "task-complete.response", "cancelled");
  }),
  outcome(
    "a cancel reaches only the task's own user",
    async (ctx) => {
      const { task } = await enqueueAndClaim(ctx);
      await cancelTask(ctx, task.id);
      const seen = await heartbeatCancelled(ctx, task.id, ctx.deviceB);
      expectEqual("another user's heartbeat cancelled", seen, []);
    },
    ["deviceB"],
  ),
  outcome(
    "another user's device cannot claim the task",
    async (ctx) => {
      const taskId = await enqueue(ctx);
      expectStatus(await claimCall(ctx, 0, ctx.deviceB), 204);
      const claimed = await claim(ctx);
      expectEqual("claimed task id", claimed.task.id, taskId);
    },
    ["deviceB"],
  ),
  outcome("an expired lease makes the task claimable again", async (ctx) => {
    const first = await enqueueAndClaim(ctx, 1);
    await sleep(1_200);
    await expectTaskStatus(ctx, first.task.id, "queued");
    const second = await claim(ctx);
    expectEqual("re-claimed task id", second.task.id, first.task.id);
    expectEqual("attempt", second.attempt, 2);
    expectThat(second.lease.id !== first.lease.id, "a new claim reused the old lease id");
    expectThat(
      second.task.mcp.token !== first.task.mcp.token,
      "a new claim reused the old task token",
    );
    expectError(await events(ctx, first.task.id, first.lease.id), 409, "lease_lost");
    await expectReport(
      complete(ctx, second.task.id, second.lease.id),
      "task-complete.response",
      "completed",
    );
  }),
  outcome("a report on an expired lease nobody claimed is accepted", async (ctx) => {
    const { task, lease } = await enqueueAndClaim(ctx, 1);
    await sleep(1_200);
    await expectReport(events(ctx, task.id, lease.id), "task-events.response", "leased");
    await expectReport(complete(ctx, task.id, lease.id), "task-complete.response", "completed");
  }),
];

async function cancelTask(ctx: Context, taskId: string) {
  const cancelled = await hook(ctx, "cancel", undefined, taskId);
  expectEqual(
    "cancel hook status",
    expectBody<{ status: string }>(cancelled, 200, "task-status.response").status,
    "cancelled",
  );
}

/** Sends a heartbeat that lists `taskId` and returns the ids the server says were cancelled. */
async function heartbeatCancelled(ctx: Context, taskId: string, credential = ctx.device) {
  const body = {
    client: CLIENT,
    adapters: [],
    capacity: { max: 1, available: 0 },
    tasks: [taskId],
  };
  const reply = await ctx.http.call("POST", "heartbeat", {
    body,
    credential: credential as string,
  });
  return expectBody<{ cancelled: string[] }>(reply, 200, "heartbeat.response").cancelled;
}

export const CHECKS: Check[] = [
  ...discoveryChecks,
  ...authChecks,
  ...lifecycleChecks,
  ...outcomeChecks,
];
