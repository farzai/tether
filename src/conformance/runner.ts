import { CHECKS, type Check, type Context, type Need } from "./checks.ts";
import { CheckFailure, type Fetch, Http } from "./http.ts";

export type Outcome = "pass" | "fail" | "skip";

export interface CheckResult {
  name: string;
  outcome: Outcome;
  /** Why it failed or was skipped. Never contains a credential, device code or token. */
  message?: string;
}

export interface ConformanceRun {
  results: CheckResult[];
  ok: boolean;
  report: string;
}

export interface ConformanceOptions {
  baseUrl: string;
  hookSecret?: string;
  /**
   * Replaces the global fetch. The tests use it to reach a loopback fake app as if it were served
   * over HTTPS, the only case where an app link can pass the schema yet break the URL rule.
   */
  fetch?: Fetch;
}

/** Runs every check in order against an app server and returns the results and a text report. */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceRun> {
  const ctx: Context = { http: new Http(new URL(options.baseUrl), options.fetch) };
  if (options.hookSecret) ctx.hookSecret = options.hookSecret;
  const results: CheckResult[] = [];
  for (const check of CHECKS) results.push(await runCheck(check, ctx));
  const ok = results.every((r) => r.outcome === "pass");
  return { results, ok, report: formatReport(options.baseUrl, results) };
}

async function runCheck(check: Check, ctx: Context): Promise<CheckResult> {
  const missing = check.needs.map((need) => missingReason(need, ctx)).find(Boolean);
  if (missing) return { name: check.name, outcome: "skip", message: missing };
  try {
    await check.run(ctx);
    return { name: check.name, outcome: "pass" };
  } catch (error) {
    if (!(error instanceof CheckFailure)) throw error;
    return { name: check.name, outcome: "fail", message: error.message };
  }
}

function missingReason(need: Need, ctx: Context): string | undefined {
  if (need === "hooks") return hooksReason(ctx);
  const present: Record<Exclude<Need, "hooks">, unknown> = {
    discovery: ctx.http.discovery,
    pairing: ctx.pairing,
    device: ctx.device,
    deviceB: ctx.deviceB,
    claimed: ctx.claimed,
    completed: ctx.completed,
  };
  return present[need] ? undefined : `needs ${NEED_LABELS[need]} (an earlier check failed)`;
}

const NEED_LABELS: Record<Exclude<Need, "hooks">, string> = {
  discovery: "the discovery document",
  pairing: "a started pairing",
  device: "a paired device",
  deviceB: "a second paired device",
  claimed: "a claimed task",
  completed: "a completed task",
};

function hooksReason(ctx: Context): string | undefined {
  if (!ctx.http.discovery) return `needs ${NEED_LABELS.discovery} (an earlier check failed)`;
  if (!ctx.hookSecret) {
    return "no conformance hook secret given (--hook-secret or TETHER_CONFORMANCE_SECRET)";
  }
  if (!ctx.http.discovery.conformance) return "the server does not advertise conformance hooks";
  return undefined;
}

const LABELS: Record<Outcome, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP" };

export function formatReport(baseUrl: string, results: CheckResult[]): string {
  const lines = [`Tether conformance (tether/1): ${baseUrl}`, ""];
  for (const result of results) {
    lines.push(`${LABELS[result.outcome]}  ${result.name}`);
    if (result.message) lines.push(`      ${result.message}`);
  }
  const count = (outcome: Outcome) => results.filter((r) => r.outcome === outcome).length;
  lines.push("", `${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped`);
  return `${lines.join("\n")}\n`;
}
