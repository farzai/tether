import { randomBytes } from "node:crypto";

/**
 * In-memory app-side state for Tether Protocol v1. Every method returns the HTTP reply the
 * protocol prescribes; transport, auth and schema checks live in server.ts.
 */

export type Clock = () => number;

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface StateOptions {
  clock: Clock;
  leaseS: number;
  pairIntervalS: number;
  pairExpiresS: number;
  origin: string;
  /** Misbehaviour toggle for conformance tests: answer reports on cancelled tasks with 409. */
  rejectReportOnCancelled: boolean;
}

export type TaskPayload = Record<string, unknown> & { id: string };
export type FinishKind = "completed" | "failed";

export interface Device {
  id: string;
  name: string;
  userId: string;
  credential: string;
}

type PairingState = "pending" | "denied" | Device;

interface Pairing {
  deviceCode: string;
  userCode: string;
  deviceName: string;
  expiresAt: number;
  lastPollAt?: number;
  state: PairingState;
}

interface Lease {
  id: string;
  expiresAt: number;
  durationS: number;
}

interface Task {
  payload: TaskPayload;
  userId: string;
  leaseS: number;
  attempts: number;
  lease?: Lease;
  finished?: FinishKind;
  cancelled: boolean;
}

export function errorReply(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Reply {
  const reply: Reply = { status, body: { error: { code, message } } };
  if (headers) reply.headers = headers;
  return reply;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const secret = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const iso = (ms: number) => new Date(ms).toISOString();

export class FakeState {
  readonly #options: StateOptions;
  readonly #pairings = new Map<string, Pairing>();
  readonly #devices = new Map<string, Device>();
  readonly #tasks = new Map<string, Task>();
  readonly #issued: string[] = [];
  #counter = 0;

  constructor(options: StateOptions) {
    this.#options = options;
  }

  get #now(): number {
    return this.#options.clock();
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `${prefix}_${this.#counter}`;
  }

  #secret(prefix: string): string {
    const value = secret(prefix);
    this.#issued.push(value);
    return value;
  }

  /** Every credential, device code and task token handed out, for no-secrets-in-output tests. */
  issuedSecrets(): string[] {
    return [...this.#issued];
  }

  // Pairing

  pairStart(deviceName: string): Reply {
    const userCode = `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`;
    const pairing: Pairing = {
      deviceCode: this.#secret("dc"),
      userCode: userCode.toUpperCase(),
      deviceName,
      expiresAt: this.#now + this.#options.pairExpiresS * 1000,
      state: "pending",
    };
    this.#pairings.set(pairing.deviceCode, pairing);
    const verificationUri = `${this.#options.origin}/tether/pair`;
    return ok({
      device_code: pairing.deviceCode,
      user_code: pairing.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${pairing.userCode}`,
      interval: this.#options.pairIntervalS,
      expires_in: this.#options.pairExpiresS,
    });
  }

  pairPoll(deviceCode: string): Reply {
    const pairing = this.#pairings.get(deviceCode);
    if (!pairing) return errorReply(404, "not_found", "Unknown device code.");
    if (this.#now >= pairing.expiresAt) return ok({ status: "expired" });
    const waitMs =
      (pairing.lastPollAt ?? -Infinity) + this.#options.pairIntervalS * 1000 - this.#now;
    if (waitMs > 0) {
      const retryAfter = String(Math.ceil(waitMs / 1000));
      return errorReply(429, "slow_down", "Polling faster than the interval.", {
        "retry-after": retryAfter,
      });
    }
    pairing.lastPollAt = this.#now;
    return ok(pollBody(pairing.state));
  }

  /** Answers a pending, unexpired pairing; approval binds the device to a fresh user. */
  answerPairing(userCode: string, approve: boolean): boolean {
    const pairing = [...this.#pairings.values()].find(
      (p) => p.userCode === userCode && p.state === "pending" && this.#now < p.expiresAt,
    );
    if (!pairing) return false;
    pairing.state = approve ? this.#createDevice(pairing.deviceName) : "denied";
    return true;
  }

  #createDevice(name: string): Device {
    const device = { id: this.#id("dev"), name, userId: this.#id("usr"), credential: "" };
    device.credential = this.#secret("tdc");
    this.#devices.set(device.credential, device);
    return device;
  }

  authenticate(credential: string | undefined): Device | undefined {
    return credential === undefined ? undefined : this.#devices.get(credential);
  }

  // Heartbeat

  heartbeat(device: Device, taskIds: string[]): Reply {
    const cancelled = taskIds.filter((id) => this.#taskOf(device, id)?.cancelled === true);
    return ok({ server_time: iso(this.#now), heartbeat_interval_s: 15, cancelled });
  }

  // Tasks

  enqueue(device: Device, payload: TaskPayload, leaseS = this.#options.leaseS): void {
    this.#tasks.set(payload.id, {
      payload,
      userId: device.userId,
      leaseS,
      attempts: 0,
      cancelled: false,
    });
  }

  defaultTask(): TaskPayload {
    return {
      id: this.#id("tsk"),
      type: "conformance.echo",
      title: "Conformance task",
      created_at: iso(this.#now),
      instructions: "Reply with OK.",
      input: {},
      mcp: { url: `${this.#options.origin}/mcp`, token: this.#secret("mcp") },
      tools: { requested: ["WebSearch"] },
      limits: { timeout_s: 60, max_budget_usd: 0.1 },
    };
  }

  /** The task if it belongs to the device's user; `shareAll` is the cross-device misbehaviour. */
  taskOf(device: Device, id: string, shareAll = false): Task | undefined {
    return shareAll ? this.#tasks.get(id) : this.#taskOf(device, id);
  }

  #taskOf(device: Device, id: string): Task | undefined {
    const task = this.#tasks.get(id);
    return task?.userId === device.userId ? task : undefined;
  }

  /** Leases the oldest claimable task of the device's user, or returns undefined. */
  claim(device: Device): Reply | undefined {
    const task = [...this.#tasks.values()].find(
      (t) => t.userId === device.userId && this.status(t) === "queued",
    );
    if (!task) return undefined;
    task.attempts += 1;
    task.lease = { id: this.#id("lse"), expiresAt: 0, durationS: task.leaseS };
    return ok({ task: task.payload, lease: this.#renew(task.lease), attempt: task.attempts });
  }

  #renew(lease: Lease): Record<string, unknown> {
    lease.expiresAt = this.#now + lease.durationS * 1000;
    return { id: lease.id, expires_at: iso(lease.expiresAt), duration_s: lease.durationS };
  }

  status(task: Task): string {
    if (task.cancelled) return "cancelled";
    if (task.finished) return task.finished;
    return task.lease && task.lease.expiresAt > this.#now ? "leased" : "queued";
  }

  taskStatus(task: Task): Reply {
    const body: Record<string, unknown> = {
      id: task.payload.id,
      status: this.status(task),
      attempts: task.attempts,
    };
    if (body.status === "leased" && task.lease) body.lease_expires_at = iso(task.lease.expiresAt);
    return ok(body);
  }

  events(task: Task, leaseId: string): Reply {
    const blocked = this.#checkReport(task, leaseId);
    if (blocked) return blocked;
    if (task.finished) return errorReply(409, "invalid_state", `The task is ${task.finished}.`);
    return ok({ status: "leased", lease: this.#renew(task.lease as Lease) });
  }

  finish(task: Task, leaseId: string, kind: FinishKind): Reply {
    const blocked = this.#checkReport(task, leaseId);
    if (blocked) return blocked;
    if (task.finished && task.finished !== kind) {
      return errorReply(409, "invalid_state", `The task is already ${task.finished}.`);
    }
    task.finished = kind;
    return ok({ status: kind });
  }

  /** Lease and cancel rows of the state table, shared by events, complete and fail. */
  #checkReport(task: Task, leaseId: string): Reply | undefined {
    if (task.lease?.id !== leaseId) {
      return errorReply(409, "lease_lost", "The lease is no longer current.");
    }
    if (!task.cancelled) return undefined;
    if (this.#options.rejectReportOnCancelled) {
      return errorReply(409, "invalid_state", "The task is cancelled.");
    }
    return ok({ status: "cancelled" });
  }

  /** The user cancels the task in the app; a finished task does not change. */
  cancel(task: Task): Reply {
    if (!task.finished) task.cancelled = true;
    return this.taskStatus(task);
  }

  findTask(id: string): Task | undefined {
    return this.#tasks.get(id);
  }
}

function pollBody(state: PairingState): Record<string, unknown> {
  if (typeof state === "string") return { status: state };
  return {
    status: "approved",
    device: { id: state.id, name: state.name },
    credential: state.credential,
  };
}
