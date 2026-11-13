import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeApp, startFakeApp } from "./fake-app/server.ts";

let now = Date.parse("2026-11-13T02:00:00Z");
let app: FakeApp;

beforeEach(async () => {
  now = Date.parse("2026-11-13T02:00:00Z");
  app = await startFakeApp({ clock: () => now, pairIntervalS: 5, pairExpiresS: 60, leaseS: 600 });
});

afterEach(async () => {
  await app.close();
});

async function call(method: string, path: string, body?: unknown, credential?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credential) headers.authorization = `Bearer ${credential}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(new URL(path, app.url), init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}

const client = { name: "tether", version: "0.0.0" };

async function startPairing() {
  const res = await call("POST", "/tether/v1/pair/start", { client, device_name: "Test" });
  return res.body as { device_code: string; user_code: string };
}

async function pairDevice(): Promise<string> {
  const { device_code, user_code } = await startPairing();
  expect(app.approvePairing(user_code)).toBe(true);
  const res = await call("POST", "/tether/v1/pair/poll", { device_code });
  return res.body.credential;
}

async function claimOne(credential: string) {
  const res = await call("POST", "/tether/v1/tasks/claim", { wait_s: 0 }, credential);
  return res.body as { task: { id: string }; lease: { id: string; expires_at: string } };
}

describe("pairing", () => {
  it("expires an unanswered pairing after expires_in", async () => {
    const { device_code, user_code } = await startPairing();
    now += 60_000;
    const res = await call("POST", "/tether/v1/pair/poll", { device_code });
    expect(res.body).toEqual({ status: "expired" });
    expect(app.approvePairing(user_code)).toBe(false);
  });

  it("answers polling sooner than the interval with slow_down and Retry-After", async () => {
    const { device_code } = await startPairing();
    await call("POST", "/tether/v1/pair/poll", { device_code });
    now += 4_000;
    const res = await call("POST", "/tether/v1/pair/poll", { device_code });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("slow_down");
    expect(res.headers.get("retry-after")).toBe("1");
    now += 1_000;
    expect((await call("POST", "/tether/v1/pair/poll", { device_code })).status).toBe(200);
  });

  it("returns the same credential again after approval, until the codes expire", async () => {
    const { device_code, user_code } = await startPairing();
    app.approvePairing(user_code);
    const first = await call("POST", "/tether/v1/pair/poll", { device_code });
    now += 5_000;
    const second = await call("POST", "/tether/v1/pair/poll", { device_code });
    expect(second.body).toEqual(first.body);
    now += 60_000;
    expect((await call("POST", "/tether/v1/pair/poll", { device_code })).body).toEqual({
      status: "expired",
    });
  });

  it("denies a pairing", async () => {
    const { device_code, user_code } = await startPairing();
    expect(app.denyPairing(user_code)).toBe(true);
    expect((await call("POST", "/tether/v1/pair/poll", { device_code })).body).toEqual({
      status: "denied",
    });
    expect(app.denyPairing("NO-SUCH")).toBe(false);
  });
});

describe("requests", () => {
  it("accepts unknown fields, as the versioning rules require", async () => {
    const res = await call("POST", "/tether/v1/pair/start", {
      client: { ...client, build: "x" },
      device_name: "Test",
      future_field: true,
    });
    expect(res.status).toBe(200);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await call("POST", "/tether/v1/pair/start", "{nope");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("answers an unknown path with a bare 404", async () => {
    const res = await fetch(new URL("/nope", app.url));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("does not advertise or answer hooks without a hook secret", async () => {
    const discovery = await call("GET", "/.well-known/tether");
    expect(discovery.body.conformance).toBeUndefined();
    const res = await fetch(new URL("/tether/v1/conformance/pair/approve", app.url), {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("leases (state table)", () => {
  it("makes a task claimable again when its lease expires, and counts attempts", async () => {
    const credential = await pairDevice();
    const task = app.enqueueFor(credential, { title: "T" });
    const first = await claimOne(credential);
    expect(first.task.id).toBe(task.id);
    now += 600_000;
    const status = await call("GET", `/tether/v1/tasks/${task.id}`, undefined, credential);
    expect(status.body).toEqual({ id: task.id, status: "queued", attempts: 1 });
    const second = await call("POST", "/tether/v1/tasks/claim", { wait_s: 0 }, credential);
    expect(second.body.attempt).toBe(2);
    const late = await call(
      "POST",
      `/tether/v1/tasks/${task.id}/complete`,
      { lease_id: first.lease.id, exit_code: 0, duration_ms: 1 },
      credential,
    );
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("lease_lost");
  });

  it("accepts a slow report on an expired lease nobody else claimed", async () => {
    const credential = await pairDevice();
    const task = app.enqueueFor(credential, {});
    const { lease } = await claimOne(credential);
    now += 700_000;
    const events = await call(
      "POST",
      `/tether/v1/tasks/${task.id}/events`,
      { lease_id: lease.id, events: [] },
      credential,
    );
    expect(events.body.status).toBe("leased");
    expect(Date.parse(events.body.lease.expires_at)).toBe(now + 600_000);
  });

  it("never re-queues a cancelled task", async () => {
    const credential = await pairDevice();
    const task = app.enqueueFor(credential, {});
    await claimOne(credential);
    app.cancel(task.id);
    now += 700_000;
    const res = await call("POST", "/tether/v1/tasks/claim", { wait_s: 0 }, credential);
    expect(res.status).toBe(204);
  });

  it("answers a report on a cancelled, never-leased task with lease_lost", async () => {
    const credential = await pairDevice();
    const task = app.enqueueFor(credential, {});
    app.cancel(task.id);
    const res = await call(
      "POST",
      `/tether/v1/tasks/${task.id}/fail`,
      { lease_id: "lse_none", reason: "cancelled_by_user" },
      credential,
    );
    expect(res.body.error.code).toBe("lease_lost");
  });

  it("does not cancel a task that already finished", async () => {
    const credential = await pairDevice();
    const task = app.enqueueFor(credential, {});
    const { lease } = await claimOne(credential);
    await call(
      "POST",
      `/tether/v1/tasks/${task.id}/complete`,
      { lease_id: lease.id, exit_code: 0, duration_ms: 5 },
      credential,
    );
    expect(app.cancel(task.id)).toEqual({ id: task.id, status: "completed", attempts: 1 });
  });

  it("rejects an enqueue that would make an invalid task", async () => {
    const credential = await pairDevice();
    expect(() => app.enqueueFor(credential, { limits: { timeout_s: 0 } })).toThrow(/invalid task/);
    expect(() => app.enqueueFor("tdc_unknown", {})).toThrow(/unknown credential/);
  });
});
