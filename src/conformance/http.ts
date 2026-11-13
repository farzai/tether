import { validate } from "../protocol/schemas.ts";

export const HOOK_HEADER = "Tether-Conformance-Secret";
const TIMEOUT_MS = 45_000;

/** A failed expectation inside a check; its message is printed in the report and holds no secrets. */
export class CheckFailure extends Error {}

export interface Discovery {
  protocol: string;
  endpoints: Record<string, string>;
  conformance?: Record<string, string>;
}

export interface Reply {
  /** `METHOD /path` of the request, for messages. */
  label: string;
  status: number;
  headers: Headers;
  body: unknown;
}

export interface RequestOptions {
  body?: unknown;
  credential?: string;
  hookSecret?: string;
  id?: string;
}

export class Http {
  readonly origin: string;
  discovery?: Discovery;

  constructor(baseUrl: URL) {
    this.origin = baseUrl.origin;
  }

  /** Resolves an endpoint key from discovery (protocol or conformance) to a URL. */
  url(key: string, id?: string): URL {
    const template = this.discovery?.endpoints[key] ?? this.discovery?.conformance?.[key];
    if (template === undefined) throw new CheckFailure(`discovery has no endpoint "${key}"`);
    return new URL(template.replace("{id}", encodeURIComponent(id ?? "")), this.origin);
  }

  async request(method: "GET" | "POST", url: URL, options: RequestOptions = {}): Promise<Reply> {
    const label = `${method} ${url.pathname}`;
    const headers: Record<string, string> = { "user-agent": "tether-conformance/1" };
    if (options.credential !== undefined) headers.authorization = `Bearer ${options.credential}`;
    if (options.hookSecret !== undefined) headers[HOOK_HEADER] = options.hookSecret;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, init).catch((error: unknown) => {
      throw new CheckFailure(`${label}: could not reach the server (${describeError(error)})`);
    });
    return { label, status: res.status, headers: res.headers, body: parseJson(await res.text()) };
  }

  call(method: "GET" | "POST", key: string, options: RequestOptions = {}): Promise<Reply> {
    return this.request(method, this.url(key, options.id), options);
  }
}

function describeError(error: unknown): string {
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code ?? (error instanceof Error ? error.message : String(error));
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Expectations

function errorOf(reply: Reply): { code: string; message: string } | undefined {
  return validate("error", reply.body).ok
    ? (reply.body as { error: { code: string; message: string } }).error
    : undefined;
}

export function expectStatus(reply: Reply, expected: number): void {
  if (reply.status === expected) return;
  const error = errorOf(reply);
  let detail = "";
  if (error) detail = ` Error code: ${error.code}.`;
  else if (reply.status === 404) detail = " The endpoint looks missing.";
  throw new CheckFailure(`${reply.label} -> ${reply.status} (expected ${expected}).${detail}`);
}

/** Expects a status and a body matching the named schema; returns the typed body. */
export function expectBody<T>(reply: Reply, status: number, schema: string): T {
  expectStatus(reply, status);
  const check = validate(schema, reply.body);
  if (!check.ok) {
    throw new CheckFailure(
      `${reply.label}: response does not match ${schema}.json: ${check.errors.join("; ")}`,
    );
  }
  return reply.body as T;
}

export function expectError(reply: Reply, status: number, code: string): void {
  expectStatus(reply, status);
  const error = errorOf(reply);
  if (!error) throw new CheckFailure(`${reply.label}: ${status} body does not match error.json`);
  if (error.code !== code) {
    throw new CheckFailure(`${reply.label}: error code ${error.code} (expected ${code})`);
  }
}

/** Compares non-secret values only: the values appear in the message. */
export function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CheckFailure(
      `${label}: got ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`,
    );
  }
}

export function expectThat(condition: boolean, message: string): void {
  if (!condition) throw new CheckFailure(message);
}
