import { randomBytes, randomInt } from "node:crypto";

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
  /** Misbehaviour toggles that prove each conformance check can fail. */
  misbehave: StateMisbehaviour;
}

export interface StateMisbehaviour {
  /** Answer reports on cancelled tasks with 409. */
  rejectReportOnCancelled?: boolean;
  /** Hand out tasks whose MCP URL is not the discovery mcp endpoint. */
  foreignMcpUrl?: boolean;
  /** Answer events without moving the lease expiry. */
  noRenew?: boolean;
  /** Return the credential on every poll after approval. */
  redeliverCredential?: boolean;
  /** Let a user code approve a pairing again. */
  reusableUserCode?: boolean;
  /** Answer revoke without revoking. */
  ignoreRevoke?: boolean;
  /** Let a claim lease another user's task. */
  claimAnyUser?: boolean;
}

export type TaskPayload = Record<string, unknown> & { id: string };
export type FinishKind = "completed" | "failed";

export interface Device {
  id: string;
  name: string;
  userId: string;
  accountName: string;
  credential: string;
}

/** `spent` is an approved pairing whose credential was delivered: it reads as expired. */
type PairingState = "pending" | "denied" | "spent" | Device;

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
/** RFC 8628 section 6.1: no vowels and no digits, so codes are easy to read and never spell words. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const userCodeGroup = () =>
  Array.from({ length: 4 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join(
    "",
  );

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
    const pairing: Pairing = {
      deviceCode: this.#secret("dc"),
      userCode: `${userCodeGroup()}-${userCodeGroup()}`,
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
    const body = pollBody(pairing.state);
    if (typeof pairing.state !== "string" && !this.#options.misbehave.redeliverCredential) {
      pairing.state = "spent";
    }
    return ok(body);
  }

  /** Answers a pending, unexpired pairing; approval binds the device to a fresh user. */
  answerPairing(userCode: string, approve: boolean): boolean {
    const pairing = [...this.#pairings.values()].find(
      (p) =>
        p.userCode === userCode &&
        (p.state === "pending" || this.#options.misbehave.reusableUserCode === true) &&
        this.#now < p.expiresAt,
    );
    if (!pairing) return false;
    pairing.state = approve ? this.#createDevice(pairing.deviceName) : "denied";
    return true;
  }

  #createDevice(name: string): Device {
    const userId = this.#id("usr");
    const device = {
      id: this.#id("dev"),
      name,
      userId,
      accountName: `Test user ${this.#counter}`,
      credential: "",
    };
    device.credential = this.#secret("tdc");
    this.#devices.set(device.credential, device);
    return device;
  }

  authenticate(credential: string | undefined): Device | undefined {
    return credential === undefined ? undefined : this.#devices.get(credential);
  }

  /** Ends the device's credential: every later call with it gets 401. */
  revoke(device: Device): Reply {
    if (!this.#options.misbehave.ignoreRevoke) this.#devices.delete(device.credential);
    return { status: 204 };
  }

  // Heartbeat

  heartbeat(device: Device, taskIds: string[], shareAll = false): Reply {
    const cancelled = taskIds.filter((id) => this.taskOf(device, id, shareAll)?.cancelled === true);
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
      mcp: { url: this.#mcpUrl(), token: this.#secret("mcp") },
      tools: { requested: ["WebSearch"] },
      limits: { timeout_s: 60, max_budget_usd: 0.1 },
    };
  }

  #mcpUrl(): string {
    return this.#options.misbehave.foreignMcpUrl
      ? "https://mcp.elsewhere.example/mcp"
      : `${this.#options.origin}${MCP_PATH}`;
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
    const anyUser = this.#options.misbehave.claimAnyUser === true;
    const task = [...this.#tasks.values()].find(
      (t) => (anyUser || t.userId === device.userId) && this.status(t) === "queued",
    );
    if (!task) return undefined;
    task.attempts += 1;
    task.lease = { id: this.#id("lse"), expiresAt: 0, durationS: task.leaseS };
    // Each lease gets its own MCP token, so a token never outlives the lease it was issued for.
    const mcp = { ...(task.payload.mcp as object), token: this.#secret("mcp") };
    task.payload = { ...task.payload, mcp };
    return ok({ task: task.payload, lease: this.#renew(task.lease), attempt: task.attempts });
  }

  #renew(lease: Lease): Record<string, unknown> {
    lease.expiresAt = this.#now + lease.durationS * 1000;
    return leaseBody(lease);
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
    const lease = task.lease as Lease;
    if (this.#options.misbehave.noRenew) return ok({ status: "leased", lease: leaseBody(lease) });
    return ok({ status: "leased", lease: this.#renew(lease) });
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
    if (this.#options.misbehave.rejectReportOnCancelled) {
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

export const MCP_PATH = "/mcp";

const leaseBody = (lease: Lease) => ({
  id: lease.id,
  expires_at: iso(lease.expiresAt),
  duration_s: lease.durationS,
});

function pollBody(state: PairingState): Record<string, unknown> {
  if (state === "spent") return { status: "expired" };
  if (typeof state === "string") return { status: state };
  return {
    status: "approved",
    device: { id: state.id, name: state.name },
    account: { name: state.accountName },
    credential: state.credential,
  };
}
