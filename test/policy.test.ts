import { describe, expect, it } from "vitest";
import {
  capReached,
  DEFAULT_POLICY,
  grantTools,
  parsePolicy,
  taskLimits,
  type Usage,
} from "../src/client/policy.ts";

const ORIGIN = "https://paper.example";
const noUsage = (date = "2026-11-14"): Usage => ({ date, total: { tasks: 0, usd: 0 }, apps: {} });

describe("grantTools", () => {
  it("grants only what both the app asks for and local policy allows", () => {
    const grant = grantTools(["Bash", "WebSearch", "Write"], DEFAULT_POLICY);
    expect(grant.granted).toEqual(["WebSearch"]);
    expect(grant.refused).toEqual(["Bash", "Write"]);
  });

  it("never grants a tool the app did not ask for", () => {
    expect(grantTools([], DEFAULT_POLICY).granted).toEqual([]);
  });

  it("allows only the defaults WebSearch and WebFetch out of the box", () => {
    expect(DEFAULT_POLICY.tools).toEqual(["WebSearch", "WebFetch"]);
  });
});

describe("taskLimits", () => {
  const policy = { ...DEFAULT_POLICY, maxTaskUsd: 0.5, maxTimeoutS: 600 };

  it("takes the lower of the app's limit and the local one", () => {
    expect(taskLimits({ timeout_s: 900, max_budget_usd: 1 }, policy, noUsage(), ORIGIN)).toEqual({
      timeoutS: 600,
      budgetUsd: 0.5,
    });
    expect(taskLimits({ timeout_s: 60, max_budget_usd: 0.2 }, policy, noUsage(), ORIGIN)).toEqual({
      timeoutS: 60,
      budgetUsd: 0.2,
    });
  });

  it("caps the budget at what is left of the daily spend, overall and per app", () => {
    const usage: Usage = {
      date: "2026-11-14",
      total: { tasks: 3, usd: 9.9 },
      apps: { [ORIGIN]: { tasks: 3, usd: 1.9 } },
    };
    const withApp = { ...policy, apps: { [ORIGIN]: { tasks: 10, usd: 2 } } };
    expect(taskLimits({ timeout_s: 60, max_budget_usd: 1 }, withApp, usage, ORIGIN).budgetUsd).toBe(
      Math.min(10 - 9.9, 2 - 1.9),
    );
  });
});

describe("capReached", () => {
  it("is undefined while every cap has room", () => {
    expect(capReached(DEFAULT_POLICY, noUsage(), ORIGIN)).toBeUndefined();
  });

  it("names the daily task cap once it is used up", () => {
    const policy = { ...DEFAULT_POLICY, daily: { tasks: 1, usd: 10 } };
    const usage: Usage = { ...noUsage(), total: { tasks: 1, usd: 0.1 } };
    expect(capReached(policy, usage, ORIGIN)).toBe("daily task cap reached (1)");
  });

  it("names the app's spend cap once it is used up", () => {
    const policy = { ...DEFAULT_POLICY, apps: { [ORIGIN]: { tasks: 5, usd: 1 } } };
    const usage: Usage = {
      ...noUsage(),
      total: { tasks: 2, usd: 1 },
      apps: { [ORIGIN]: { tasks: 2, usd: 1 } },
    };
    expect(capReached(policy, usage, ORIGIN)).toBe("daily spend cap for this app reached ($1)");
    expect(capReached(policy, usage, "https://other.example")).toBeUndefined();
  });
});

describe("parsePolicy", () => {
  it("fills every field the file leaves out with the default", () => {
    expect(parsePolicy({})).toEqual(DEFAULT_POLICY);
  });

  it("reads the file's snake_case fields", () => {
    const policy = parsePolicy({
      tools: ["WebSearch"],
      max_task_usd: 0.25,
      max_timeout_s: 120,
      daily: { tasks: 5, usd: 2 },
      apps: { [ORIGIN]: { tasks: 2 } },
    });
    expect(policy).toEqual({
      tools: ["WebSearch"],
      maxTaskUsd: 0.25,
      maxTimeoutS: 120,
      daily: { tasks: 5, usd: 2 },
      apps: { [ORIGIN]: { tasks: 2, usd: 2 } },
    });
  });

  it("refuses a malformed file instead of guessing", () => {
    expect(() => parsePolicy({ tools: "Bash" })).toThrow(/tools/);
    expect(() => parsePolicy({ max_task_usd: -1 })).toThrow(/max_task_usd/);
    expect(() => parsePolicy({ tools: ["mcp__evil__x"] })).toThrow(/tools/);
    expect(() => parsePolicy([])).toThrow(/object/);
  });
});
