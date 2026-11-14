import { describe, expect, it } from "vitest";
import { causeMessage, causeOf, resetOf } from "../src/client/claude-code-cause.ts";

describe("causeOf", () => {
  it.each([
    ["authentication_failed", 400, "auth_failed"],
    ["rate_limit", undefined, "rate_limit"],
    ["billing_error", 400, "billing"],
    ["server_error", undefined, "provider_error"],
  ] as const)("names the cause of the assistant error %s", (error, status, cause) => {
    expect(causeOf(error, status)).toBe(cause);
  });

  it.each([
    [401, "auth_failed"],
    [403, "auth_failed"],
    [402, "billing"],
    [429, "rate_limit"],
    [500, "provider_error"],
    [529, "provider_error"],
    [499, undefined],
    [400, undefined],
    [404, undefined],
    [undefined, undefined],
  ] as const)("falls back to the API status %s", (status, cause) => {
    expect(causeOf(undefined, status)).toBe(cause);
  });

  it("gives errors not tied to the provider no cause unless the status names one", () => {
    expect(causeOf("invalid_request", 400)).toBeUndefined();
    expect(causeOf("max_output_tokens", undefined)).toBeUndefined();
    expect(causeOf("a_later_error", undefined)).toBeUndefined();
    expect(causeOf("a_later_error", 429)).toBe("rate_limit");
    expect(causeOf("constructor", undefined)).toBeUndefined();
    expect(causeOf("toString", 429)).toBe("rate_limit");
  });
});

describe("resetOf", () => {
  const at = 1794668400;
  it("reads the reset of a rejected limit, the overage's when the overage was rejected", () => {
    expect(resetOf({ status: "rejected", resetsAt: at })).toBe("2026-11-14T15:00:00Z");
    const overage = { status: "rejected", resetsAt: at, overageResetsAt: at + 3600 };
    expect(resetOf({ ...overage, isUsingOverage: true, overageStatus: "rejected" })).toBe(
      "2026-11-14T16:00:00Z",
    );
    expect(resetOf({ ...overage, isUsingOverage: true, overageStatus: "allowed" })).toBe(
      "2026-11-14T15:00:00Z",
    );
    expect(resetOf({ ...overage, isUsingOverage: false, overageStatus: "rejected" })).toBe(
      "2026-11-14T15:00:00Z",
    );
  });

  it("gives no time without a rate limit info", () => {
    expect(resetOf(undefined)).toBeUndefined();
  });

  it("takes any positive time", () => {
    expect(resetOf({ status: "rejected", resetsAt: 1 })).toBe("1970-01-01T00:00:01Z");
  });

  it.each([
    [{ status: "allowed", resetsAt: at }],
    [{ status: "allowed_warning", resetsAt: at }],
    [{ status: "rejected" }],
    [{ status: "rejected", resetsAt: "1794668400" }],
    [{ status: "rejected", resetsAt: 0 }],
    [{ status: "rejected", resetsAt: -1 }],
    [{ status: "rejected", resetsAt: Number.NaN }],
    [{ status: "rejected", resetsAt: Number.POSITIVE_INFINITY }],
    [{ status: "rejected", resetsAt: 1e20 }],
  ])("gives no time for %j", (info) => {
    expect(resetOf(info)).toBeUndefined();
  });
});

describe("causeMessage", () => {
  it("says what happened and when to retry", () => {
    expect(causeMessage("rate_limit", "2026-11-14T15:00:00Z")).toBe(
      "Claude Code hit its usage limit. Retry after 2026-11-14T15:00:00Z.",
    );
    expect(causeMessage("rate_limit", undefined)).toBe(
      "Claude Code hit its usage limit. Retry later.",
    );
    expect(causeMessage("auth_failed", undefined)).toMatch(/sign in to Claude Code again/);
    expect(causeMessage("billing", undefined)).toMatch(/fix its billing/);
    expect(causeMessage("provider_error", undefined)).toMatch(/Retry later/);
  });
});
