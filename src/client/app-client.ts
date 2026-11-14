import { parseJson } from "../protocol/json.ts";
import { validate } from "../protocol/schemas.ts";
import { isAllowedUrl } from "../protocol/urls.ts";

export const CLIENT = { name: "tether", version: "0.1.0" } as const;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How the caller must react to a failed call, from the protocol's error table (section 13).
 * - `unauthorized`: the credential is dead; stop using it and ask the user to pair again.
 * - `gone`: the task is no longer ours (404, 409); stop the agent and drop the task.
 * - `retry`: network error, 5xx or 429; retry after `retryAfterMs` or with back-off.
 * - `rejected`: any other 4xx; do not repeat the same request.
 * - `refused`: the app broke a rule the client enforces (redirect, wrong origin, bad body).
 */
export type FailureKind = "unauthorized" | "gone" | "retry" | "rejected" | "refused";

/** A failed protocol call. Its message never holds a secret and is safe to print. */
export class AppError extends Error {
  readonly kind: FailureKind;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: FailureKind, message: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export type Fetch = typeof fetch;

export const ENDPOINT_KEYS = [
  "pair_start",
  "pair_poll",
  "heartbeat",
  "claim",
  "task",
  "task_events",
  "task_complete",
  "task_fail",
  "revoke",
  "mcp",
] as const;
export type EndpointKey = (typeof ENDPOINT_KEYS)[number];

/** A discovery document that passed every check: every endpoint resolves on the app's origin. */
export interface App {
  origin: string;
  name: string;
  /** Endpoint values as discovery gave them; `url()` resolves and checks them again. */
  endpoints: Record<EndpointKey, string>;
  /** The discovery `mcp` endpoint, resolved: every task's `mcp.url` must equal it. */
  mcpUrl: string;
}

/** Parses what the user typed as an app URL; only its origin is kept. */
export function parseAppUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || !isAllowedUrl(url.origin, value) || url.username || url.password) {
    throw new AppError(
      "refused",
      "The app URL must be https://, or http:// on localhost for development.",
    );
  }
  return url.origin;
}

/** Resolves an endpoint against the origin; refuses one that does not parse or leaves the origin. */
function onOrigin(origin: string, value: string): string {
  const url = URL.parse(value, origin);
  if (!url || url.origin !== origin) {
    throw new AppError(
      "refused",
      "The app's discovery document names an endpoint on another site.",
    );
  }
  return url.href;
}

function retryAfterMs(res: Response, body: unknown): number | undefined {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const field = (body as { error?: { retry_after_s?: unknown } } | undefined)?.error?.retry_after_s;
  return typeof field === "number" && field > 0 ? field * 1000 : undefined;
}

function failureFor(res: Response, body: unknown, label: string): AppError {
  const error = validate("error", body).ok
    ? (body as { error: { code: string } }).error
    : undefined;
  const code = error?.code;
  const message = `${label}: the app answered ${res.status}${code ? ` (${code})` : ""}`;
  if (res.status === 401) return new AppError("unauthorized", message, code);
  if (res.status === 404 || res.status === 409) return new AppError("gone", message, code);
  if (res.status === 429 || res.status >= 500) {
    return new AppError("retry", message, code, retryAfterMs(res, body));
  }
  return new AppError("rejected", message, code);
}

export interface CallOptions {
  body?: unknown;
  credential?: string;
  id?: string;
  /** Schema the 200 body must match; a 204 is returned as undefined. */
  schema?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One app's protocol endpoints over HTTP. Redirects are refused on every request. */
export class AppClient {
  readonly app: App;
  readonly #fetch: Fetch;

  constructor(app: App, fetchFn: Fetch = fetch) {
    this.app = app;
    this.#fetch = fetchFn;
  }

  /** Fetches and checks the discovery document of the app at `origin`. */
  static async discover(origin: string, fetchFn: Fetch = fetch): Promise<AppClient> {
    const body = await send(fetchFn, "GET", `${origin}/.well-known/tether`, "discovery", {
      schema: "discovery",
    });
    const doc = body as {
      protocol: string;
      app: { name: string };
      endpoints: Record<string, string>;
    };
    if (doc.protocol !== "tether/1") {
      throw new AppError("refused", "The app speaks a protocol version this Tether does not know.");
    }
    const endpoints = {} as Record<EndpointKey, string>;
    for (const key of ENDPOINT_KEYS) {
      const value = doc.endpoints[key];
      if (value === undefined) {
        throw new AppError("refused", `The app's discovery document has no "${key}" endpoint.`);
      }
      onOrigin(origin, value.replace("{id}", "id"));
      endpoints[key] = value;
    }
    const mcpUrl = onOrigin(origin, endpoints.mcp);
    return new AppClient({ origin, name: doc.app.name, endpoints, mcpUrl }, fetchFn);
  }

  url(key: EndpointKey, id?: string): string {
    const template = this.app.endpoints[key];
    const path = id === undefined ? template : template.replace("{id}", encodeURIComponent(id));
    return onOrigin(this.app.origin, path);
  }

  call(method: "GET" | "POST", key: EndpointKey, options: CallOptions = {}): Promise<unknown> {
    return send(this.#fetch, method, this.url(key, options.id), key, options);
  }
}

async function send(
  fetchFn: Fetch,
  method: "GET" | "POST",
  url: string,
  label: string,
  options: CallOptions,
): Promise<unknown> {
  const { res, text } = await exchange(fetchFn, method, url, label, options);
  if (res.status >= 300 && res.status < 400) {
    throw new AppError(
      "refused",
      `${label}: the app answered with a redirect, which Tether refuses`,
    );
  }
  const body = parseJson(text);
  if (res.status === 204) return undefined;
  if (res.status !== 200 && res.status !== 201) throw failureFor(res, body, label);
  if (options.schema && !validate(options.schema, body).ok) {
    throw new AppError("retry", `${label}: the app's answer does not match the protocol`);
  }
  return body;
}

/** One HTTP round trip that never follows a redirect; a network failure becomes `retry`. */
async function exchange(
  fetchFn: Fetch,
  method: "GET" | "POST",
  url: string,
  label: string,
  options: CallOptions,
): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = { "user-agent": `tether/${CLIENT.version}` };
  if (options.credential !== undefined) headers.authorization = `Bearer ${options.credential}`;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
    signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  try {
    const res = await fetchFn(url, init);
    return { res, text: await res.text() };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AppError("retry", `${label}: could not reach the app (${networkCause(error)})`);
  }
}

/** Names a network failure without echoing anything the server sent. */
function networkCause(error: unknown): string {
  const { cause, name } = error as { cause?: { code?: unknown }; name?: string };
  if (name === "TimeoutError") return "timed out";
  return typeof cause?.code === "string" ? cause.code : "network error";
}
