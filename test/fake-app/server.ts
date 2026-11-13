import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { validate } from "../../src/protocol/schemas.ts";
import {
  type Clock,
  type Device,
  errorReply,
  FakeState,
  MCP_PATH,
  type Reply,
  type StateMisbehaviour,
  type TaskPayload,
} from "./state.ts";

export type RouteKey =
  | "discovery"
  | "pair_start"
  | "pair_poll"
  | "heartbeat"
  | "claim"
  | "task"
  | "task_events"
  | "task_complete"
  | "task_fail"
  | "revoke"
  | "pair_approve"
  | "pair_deny"
  | "enqueue"
  | "cancel";

export interface FakeAppOptions {
  /** Enables the conformance hooks, guarded by this secret. Without it they do not exist. */
  hookSecret?: string;
  clock: Clock;
  leaseS: number;
  pairIntervalS: number;
  pairExpiresS: number;
  /** Routes the server lacks: they answer a bare 404 though discovery still lists them. */
  removeRoutes: RouteKey[];
  misbehave: Misbehaviour;
}

/** Routes whose ownership check a misbehaving fake can skip. */
export type OwnedRoute =
  | "task"
  | "task_events"
  | "task_complete"
  | "task_fail"
  | "heartbeat"
  | "claim";

export interface Misbehaviour extends Omit<StateMisbehaviour, "claimAnyUser"> {
  skipAuth?: boolean;
  /** Routes that serve any user's task, as if the ownership check were missing. */
  shareTasks?: OwnedRoute[];
  /** Answer every claim at once instead of holding it, which section 7 allows. */
  noLongPoll?: boolean;
  /** Advertise these `app.icon` / `app.url` values in discovery. */
  appLinks?: { icon?: string; url?: string };
  /** Advertise these values in discovery's `endpoints` instead of the real paths. */
  endpoints?: Partial<Record<RouteKey, string>>;
}

type Auth = "none" | "device" | "hook" | "hook+device";

interface Context {
  body: Record<string, unknown>;
  device: Device;
  id: string;
  signal: AbortSignal;
}

interface Route {
  key: RouteKey;
  method: "GET" | "POST";
  path: string;
  auth: Auth;
  schema?: string;
  handle(ctx: Context): Reply | Promise<Reply>;
}

const HOOK_HEADER = "tether-conformance-secret";
const PROTOCOL_KEYS: RouteKey[] = [
  "pair_start",
  "pair_poll",
  "heartbeat",
  "claim",
  "task",
  "task_events",
  "task_complete",
  "task_fail",
  "revoke",
];
const HOOK_KEYS: RouteKey[] = ["pair_approve", "pair_deny", "enqueue", "cancel"];

export interface FakeApp {
  readonly url: string;
  close(): Promise<void>;
  approvePairing(userCode: string): boolean;
  denyPairing(userCode: string): boolean;
  /** Queues a task for the user of the device holding `credential`; throws on bad input. */
  enqueueFor(credential: string, overrides: Record<string, unknown>, leaseS?: number): TaskPayload;
  cancel(taskId: string): unknown;
  issuedSecrets(): string[];
}

export async function startFakeApp(
  options: Partial<FakeAppOptions> = {},
  port = 0,
): Promise<FakeApp> {
  const opts: FakeAppOptions = {
    clock: Date.now,
    leaseS: 600,
    pairIntervalS: 1,
    pairExpiresS: 600,
    removeRoutes: [],
    misbehave: {},
    ...options,
  };
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const state = new FakeState({
    clock: opts.clock,
    leaseS: opts.leaseS,
    pairIntervalS: opts.pairIntervalS,
    pairExpiresS: opts.pairExpiresS,
    origin: url,
    misbehave: { ...opts.misbehave, claimAnyUser: shares(opts, "claim") },
  });
  const routes = buildRoutes(state, opts);
  server.on("request", (req, res) => {
    handle(routes, opts, state, req, res).catch((error: unknown) => {
      console.error("fake app error", error);
      send(res, errorReply(500, "server_error", "The fake app failed."));
    });
  });

  const enqueueFor = (credential: string, overrides: Record<string, unknown>, leaseS?: number) => {
    const device = state.authenticate(credential);
    if (!device) throw new Error("unknown credential");
    const reply = enqueue(state, device, {
      task: overrides,
      ...(leaseS ? { lease_s: leaseS } : {}),
    });
    if (reply.status !== 201) throw new Error(`invalid task: ${JSON.stringify(reply.body)}`);
    return reply.body as TaskPayload;
  };

  return {
    url,
    close: () => closeServer(server),
    approvePairing: (code) => state.answerPairing(code, true),
    denyPairing: (code) => state.answerPairing(code, false),
    enqueueFor,
    cancel: (taskId) => {
      const task = state.findTask(taskId);
      return task ? state.cancel(task).body : undefined;
    },
    issuedSecrets: () => state.issuedSecrets(),
  };
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

const shares = (opts: FakeAppOptions, key: OwnedRoute) =>
  opts.misbehave.shareTasks?.includes(key) === true;

function buildRoutes(state: FakeState, opts: FakeAppOptions): Route[] {
  type Found = NonNullable<ReturnType<FakeState["taskOf"]>>;
  const withTask = (key: OwnedRoute | "cancel", fn: (t: Found, ctx: Context) => Reply) => {
    return (ctx: Context) => {
      const shareAll = key !== "cancel" && shares(opts, key);
      const found = state.taskOf(ctx.device, ctx.id, shareAll);
      return found ? fn(found, ctx) : errorReply(404, "not_found", "Unknown task.");
    };
  };
  const leaseId = (ctx: Context) => ctx.body.lease_id as string;
  const all: Route[] = [
    route("discovery", "GET", "none", undefined, () => ({
      status: 200,
      body: discovery(opts),
    })),
    route("pair_start", "POST", "none", "pair-start.request", (ctx) =>
      state.pairStart(ctx.body.device_name as string),
    ),
    route("pair_poll", "POST", "none", "pair-poll.request", (ctx) =>
      state.pairPoll(ctx.body.device_code as string),
    ),
    route("heartbeat", "POST", "device", "heartbeat.request", (ctx) =>
      state.heartbeat(ctx.device, ctx.body.tasks as string[], shares(opts, "heartbeat")),
    ),
    route("claim", "POST", "device", "claim.request", (ctx) =>
      claim(state, ctx, opts.misbehave.noLongPoll === true),
    ),
    route(
      "task",
      "GET",
      "device",
      undefined,
      withTask("task", (t) => state.taskStatus(t)),
    ),
    route(
      "task_events",
      "POST",
      "device",
      "task-events.request",
      withTask("task_events", (t, ctx) => state.events(t, leaseId(ctx))),
    ),
    route(
      "task_complete",
      "POST",
      "device",
      "task-complete.request",
      withTask("task_complete", (t, ctx) => state.finish(t, leaseId(ctx), "completed")),
    ),
    route(
      "task_fail",
      "POST",
      "device",
      "task-fail.request",
      withTask("task_fail", (t, ctx) => state.finish(t, leaseId(ctx), "failed")),
    ),
    route("revoke", "POST", "device", undefined, (ctx) => state.revoke(ctx.device)),
    route("pair_approve", "POST", "hook", "conformance-pair.request", (ctx) =>
      hookAnswer(state.answerPairing(ctx.body.user_code as string, true)),
    ),
    route("pair_deny", "POST", "hook", "conformance-pair.request", (ctx) =>
      hookAnswer(state.answerPairing(ctx.body.user_code as string, false)),
    ),
    route("enqueue", "POST", "hook+device", "conformance-enqueue.request", (ctx) =>
      enqueue(state, ctx.device, ctx.body),
    ),
    route(
      "cancel",
      "POST",
      "hook+device",
      undefined,
      withTask("cancel", (t) => state.cancel(t)),
    ),
  ];
  const hooksOn = opts.hookSecret !== undefined;
  return all.filter(
    (r) => !opts.removeRoutes.includes(r.key) && (hooksOn || !HOOK_KEYS.includes(r.key)),
  );
}

function route(
  key: RouteKey,
  method: Route["method"],
  auth: Auth,
  schema: string | undefined,
  handle: Route["handle"],
): Route {
  const path = PATHS[key];
  return schema === undefined
    ? { key, method, path, auth, handle }
    : { key, method, path, auth, schema, handle };
}

const PATHS: Record<RouteKey, string> = {
  discovery: "/.well-known/tether",
  pair_start: "/tether/v1/pair/start",
  pair_poll: "/tether/v1/pair/poll",
  heartbeat: "/tether/v1/heartbeat",
  claim: "/tether/v1/tasks/claim",
  task: "/tether/v1/tasks/{id}",
  task_events: "/tether/v1/tasks/{id}/events",
  task_complete: "/tether/v1/tasks/{id}/complete",
  task_fail: "/tether/v1/tasks/{id}/fail",
  revoke: "/tether/v1/devices/revoke",
  pair_approve: "/tether/v1/conformance/pair/approve",
  pair_deny: "/tether/v1/conformance/pair/deny",
  enqueue: "/tether/v1/conformance/tasks",
  cancel: "/tether/v1/conformance/tasks/{id}/cancel",
};

function discovery(opts: FakeAppOptions): Record<string, unknown> {
  const pick = (keys: RouteKey[]) => Object.fromEntries(keys.map((k) => [k, PATHS[k]]));
  const doc: Record<string, unknown> = {
    protocol: "tether/1",
    app: { name: "Fake App", ...opts.misbehave.appLinks },
    endpoints: { ...pick(PROTOCOL_KEYS), mcp: MCP_PATH, ...opts.misbehave.endpoints },
  };
  if (opts.hookSecret !== undefined) doc.conformance = pick(HOOK_KEYS);
  return doc;
}

const hookAnswer = (done: boolean): Reply =>
  done ? { status: 204 } : errorReply(404, "not_found", "No pending pairing with that user code.");

function enqueue(state: FakeState, device: Device, body: Record<string, unknown>): Reply {
  const defaults = state.defaultTask();
  const payload = { ...defaults, ...(body.task as object | undefined), id: defaults.id };
  const check = validate("task", payload);
  if (!check.ok)
    return errorReply(400, "invalid_request", `Invalid task: ${check.errors.join("; ")}`);
  state.enqueue(device, payload, body.lease_s as number | undefined);
  return { status: 201, body: payload };
}

async function claim(state: FakeState, ctx: Context, noLongPoll: boolean): Promise<Reply> {
  const deadline = noLongPoll ? 0 : Date.now() + (ctx.body.wait_s as number) * 1000;
  for (;;) {
    const reply = state.claim(ctx.device);
    if (reply) return reply;
    if (Date.now() >= deadline || ctx.signal.aborted) return { status: 204 };
    await sleep(20);
  }
}

// Transport

async function handle(
  routes: Route[],
  opts: FakeAppOptions,
  state: FakeState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://fake").pathname;
  const match = matchRoute(routes, req.method ?? "GET", path);
  if (!match) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
    return;
  }
  const raw = await readBody(req);
  const reply = prepare(match.route, opts, state, req, raw);
  if ("status" in reply) {
    send(res, reply);
    return;
  }
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const ctx: Context = { ...reply, id: match.id, signal: controller.signal };
  send(res, await match.route.handle(ctx));
}

/** Auth and body checks shared by every route: returns an error reply or the parsed context. */
function prepare(
  route: Route,
  opts: FakeAppOptions,
  state: FakeState,
  req: IncomingMessage,
  raw: string,
): Reply | Pick<Context, "body" | "device"> {
  if (route.auth.startsWith("hook") && req.headers[HOOK_HEADER] !== opts.hookSecret) {
    return errorReply(401, "unauthorized", "Missing or wrong conformance secret.");
  }
  const device = authenticate(route, opts, state, req);
  if (!device) return errorReply(401, "unauthorized", "Missing or unknown device credential.");
  const body = parseBody(raw);
  if (body === undefined)
    return errorReply(400, "invalid_request", "The body is not a JSON object.");
  if (route.schema) {
    const check = validate(route.schema, body);
    if (!check.ok) return errorReply(400, "invalid_request", check.errors.join("; "));
  }
  return { body, device };
}

const ANONYMOUS: Device = {
  id: "anonymous",
  name: "anonymous",
  userId: "anonymous",
  accountName: "anonymous",
  credential: "",
};

function authenticate(route: Route, opts: FakeAppOptions, state: FakeState, req: IncomingMessage) {
  if (!route.auth.endsWith("device")) return ANONYMOUS;
  const header = req.headers.authorization;
  const credential = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  return state.authenticate(credential) ?? (opts.misbehave.skipAuth ? ANONYMOUS : undefined);
}

function parseBody(raw: string): Record<string, unknown> | undefined {
  if (raw === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function matchRoute(routes: Route[], method: string, path: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = new RegExp(`^${route.path.replace("{id}", "([^/]+)")}$`);
    const found = pattern.exec(path);
    if (found) return { route, id: decodeURIComponent(found[1] ?? "") };
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, reply: Reply): void {
  if (res.headersSent || res.destroyed) return;
  const headers: Record<string, string> = { ...reply.headers };
  if (reply.body === undefined) {
    res.writeHead(reply.status, headers).end();
    return;
  }
  headers["content-type"] = "application/json";
  res.writeHead(reply.status, headers).end(JSON.stringify(reply.body));
}
