/**
 * The user's local policy: which built-in tools a task may get, the most one task may spend or
 * run, and daily caps per app and overall. Every function here only narrows what an app asks for;
 * nothing a task carries can widen it.
 */

export interface Cap {
  tasks: number;
  usd: number;
}

export interface Policy {
  /** Built-in tools a task may be granted. The app's own MCP server is always allowed. */
  tools: string[];
  maxTaskUsd: number;
  maxTimeoutS: number;
  daily: Cap;
  /** Per-app daily caps, keyed by the app's origin. */
  apps: Record<string, Cap>;
}

/** What has been spent today (local date), overall and per app origin. */
export interface Usage {
  date: string;
  total: Cap;
  apps: Record<string, Cap>;
}

export const DEFAULT_POLICY: Policy = {
  tools: ["WebSearch", "WebFetch"],
  maxTaskUsd: 1,
  maxTimeoutS: 1800,
  daily: { tasks: 100, usd: 10 },
  apps: {},
};

/** A built-in tool name; `mcp__` names are refused so policy cannot name another MCP server. */
const TOOL_NAME = /^(?!mcp__)[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface Grant {
  granted: string[];
  refused: string[];
}

export function grantTools(requested: readonly string[], policy: Policy): Grant {
  const granted = requested.filter((tool) => policy.tools.includes(tool));
  const refused = requested.filter((tool) => !policy.tools.includes(tool));
  return { granted, refused };
}

export interface TaskLimits {
  timeoutS: number;
  budgetUsd: number;
}

/** The task's limits lowered to the local ones and to what is left of today's spend caps. */
export function taskLimits(
  limits: { timeout_s: number; max_budget_usd: number },
  policy: Policy,
  usage: Usage,
  origin: string,
): TaskLimits {
  const appCap = capFor(policy, origin);
  const appSpent = usage.apps[origin] ?? { tasks: 0, usd: 0 };
  return {
    timeoutS: Math.min(limits.timeout_s, policy.maxTimeoutS),
    budgetUsd: Math.min(
      limits.max_budget_usd,
      policy.maxTaskUsd,
      policy.daily.usd - usage.total.usd,
      appCap.usd - appSpent.usd,
    ),
  };
}

/** Why no task may start for this app now, or undefined when every cap has room. */
export function capReached(policy: Policy, usage: Usage, origin: string): string | undefined {
  const appSpent = usage.apps[origin] ?? { tasks: 0, usd: 0 };
  return (
    exhausted("daily", policy.daily, usage.total) ??
    exhausted("daily", capFor(policy, origin), appSpent, " for this app")
  );
}

function exhausted(label: string, cap: Cap, spent: Cap, scope = ""): string | undefined {
  if (spent.tasks >= cap.tasks) return `${label} task cap${scope} reached (${cap.tasks})`;
  if (spent.usd >= cap.usd) return `${label} spend cap${scope} reached ($${cap.usd})`;
  return undefined;
}

/** An app without its own cap falls back to the overall daily cap. */
function capFor(policy: Policy, origin: string): Cap {
  return policy.apps[origin] ?? policy.daily;
}

// Parsing the policy file

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string, rule: string): never {
  throw new Error(`policy file: ${field} must be ${rule}`);
}

function number(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(field, "a number of 0 or more");
  }
  return value;
}

function tools(value: unknown): string[] {
  if (value === undefined) return DEFAULT_POLICY.tools;
  if (!Array.isArray(value) || !value.every((t) => typeof t === "string" && TOOL_NAME.test(t))) {
    fail("tools", "a list of built-in tool names");
  }
  return value as string[];
}

function cap(value: unknown, field: string, fallback: Cap): Cap {
  if (value === undefined) return fallback;
  if (!isObject(value)) fail(field, "an object");
  return {
    tasks: number(value.tasks, `${field}.tasks`, fallback.tasks),
    usd: number(value.usd, `${field}.usd`, fallback.usd),
  };
}

/** Parses the policy file's JSON; a field it leaves out takes the default, a bad one throws. */
export function parsePolicy(raw: unknown): Policy {
  if (!isObject(raw)) fail("the file", "a JSON object");
  const daily = cap(raw.daily, "daily", DEFAULT_POLICY.daily);
  if (raw.apps !== undefined && !isObject(raw.apps)) fail("apps", "an object");
  const apps = Object.fromEntries(
    Object.entries(raw.apps ?? {}).map(([origin, value]) => [
      origin,
      cap(value, `apps.${origin}`, daily),
    ]),
  );
  return {
    tools: tools(raw.tools),
    maxTaskUsd: number(raw.max_task_usd, "max_task_usd", DEFAULT_POLICY.maxTaskUsd),
    maxTimeoutS: number(raw.max_timeout_s, "max_timeout_s", DEFAULT_POLICY.maxTimeoutS),
    daily,
    apps,
  };
}
