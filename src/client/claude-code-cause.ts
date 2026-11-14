/**
 * Why a Claude Code session failed at the model provider, read from its stream-json: a hit usage
 * limit, a login or API key that no longer works, a billing problem, or a provider failure. The
 * names are the `cause` values of a `task_fail` report (see docs/protocol.md, "Fail").
 */
export type Cause = "rate_limit" | "auth_failed" | "billing" | "provider_error";

/** Claude Code's `error` on an assistant line (`SDKAssistantMessageError`) that names a cause. */
const CAUSE_BY_ERROR = new Map<string, Cause>([
  ["rate_limit", "rate_limit"],
  ["authentication_failed", "auth_failed"],
  ["billing_error", "billing"],
  ["server_error", "provider_error"],
]);

/** The cause each API status implies, for a result line that names no error; 5xx is the provider. */
const CAUSE_BY_STATUS = new Map<number, Cause>([
  [401, "auth_failed"],
  [402, "billing"],
  [403, "auth_failed"],
  [429, "rate_limit"],
]);

function causeOfStatus(status: number | undefined): Cause | undefined {
  if (status === undefined) return undefined;
  return status >= 500 ? "provider_error" : CAUSE_BY_STATUS.get(status);
}

/**
 * The cause of a session that ended on an API error: the last assistant `error`, else the result's
 * API status. Errors Claude Code does not tie to the provider (`invalid_request`, `unknown`,
 * `max_output_tokens`, values added later) give no cause unless the status does.
 */
export function causeOf(error: string | undefined, status: number | undefined): Cause | undefined {
  return CAUSE_BY_ERROR.get(error ?? "") ?? causeOfStatus(status);
}

/** The `rate_limit_info` of a `rate_limit_event` line (`SDKRateLimitInfo`), as far as it is read. */
export interface RateLimitInfo {
  status?: unknown;
  resetsAt?: unknown;
  isUsingOverage?: unknown;
  overageStatus?: unknown;
  overageResetsAt?: unknown;
}

/**
 * When a rejected limit resets, as an RFC 3339 time: the overage's reset when the overage was the
 * limit that was hit. Undefined for a limit that was not rejected or a time that is not valid.
 */
export function resetOf(info: RateLimitInfo | undefined): string | undefined {
  if (info?.status !== "rejected") return undefined;
  const overage = info.isUsingOverage === true && info.overageStatus === "rejected";
  const seconds = overage ? info.overageResetsAt : info.resetsAt;
  if (typeof seconds !== "number" || seconds <= 0) return undefined;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The report message for a cause: what happened and when or how retrying makes sense. */
export function causeMessage(cause: Cause, retryAt: string | undefined): string {
  switch (cause) {
    case "rate_limit":
      return retryAt
        ? `Claude Code hit its usage limit. Retry after ${retryAt}.`
        : "Claude Code hit its usage limit. Retry later.";
    case "auth_failed":
      return "Claude Code's login has expired or its API key was refused: sign in to Claude Code again on this device, then retry.";
    case "billing":
      return "Claude Code's account could not pay for the task: fix its billing or credit, then retry.";
    case "provider_error":
      return "The model provider failed (a server error or overload). Retry later.";
  }
}
