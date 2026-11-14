import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schemaNames, validate } from "../src/protocol/schemas.ts";

const root = new URL("../", import.meta.url);
const protocolDoc = readFileSync(new URL("docs/protocol.md", root), "utf8");
const specDoc = readFileSync(new URL("docs/spec.md", root), "utf8");
const schemaFiles = readdirSync(new URL("schemas/v1/", root)).filter((f) => f.endsWith(".json"));

describe("schemas/", () => {
  it("holds the protocol schemas", () => {
    expect(schemaFiles.length).toBeGreaterThan(10);
  });

  it.each(schemaFiles)("references schemas/%s from docs/protocol.md", (file) => {
    expect(protocolDoc).toContain(`schemas/v1/${file}`);
  });

  it("only references schema files that exist", () => {
    const referenced = new Set(
      [...protocolDoc.matchAll(/schemas\/v1\/([\w.-]+\.json)/g)].map((m) => m[1]),
    );
    expect([...referenced].filter((file) => !schemaFiles.includes(file as string))).toEqual([]);
  });

  it("compiles every schema file", () => {
    expect([...schemaNames()].sort()).toEqual(
      schemaFiles.map((f) => f.replace(/\.json$/, "")).sort(),
    );
  });

  it("gives every schema an $id that matches its file name", () => {
    for (const file of schemaFiles) {
      const schema = JSON.parse(readFileSync(new URL(`schemas/v1/${file}`, root), "utf8"));
      expect(schema.$id).toBe(
        `https://raw.githubusercontent.com/farzai/tether/main/schemas/v1/${file}`,
      );
    }
  });
});

describe("docs/protocol.md examples", () => {
  it("validates every example labelled with a schema", () => {
    const examples = [
      ...protocolDoc.matchAll(/<!-- example: ([\w.-]+) -->\s*```json\n([\s\S]*?)```/g),
    ];
    expect(examples.length).toBeGreaterThan(10);
    for (const [, name, body] of examples) {
      const result = validate(name as string, JSON.parse(body as string));
      expect({ name, errors: result.ok ? [] : result.errors }).toEqual({ name, errors: [] });
    }
  });

  it("accepts the task payload from the spec", () => {
    const sample = /### Task payload\s*```json\n([\s\S]*?)```/.exec(specDoc)?.[1];
    const task = JSON.parse(sample ?? "null");
    task.id = "tsk_1";
    task.created_at = "2026-11-13T02:00:00Z";
    expect(validate("task", task)).toEqual({ ok: true });
  });

  it("gives the task token the lifetime the protocol gives it", () => {
    expect(protocolDoc).toContain("Lease expiry alone does not stop it");
    expect(specDoc).not.toMatch(/expires with the lease/);
    expect(specDoc).toMatch(/stops when another claim takes the task/);
    expect(specDoc).toMatch(/lease expiry alone does not stop it/);
  });

  it("keeps fail causes open: any short lower-case word, with an optional retry time", () => {
    const fail = (extra: Record<string, unknown>) =>
      validate("task-fail.request", { lease_id: "l", reason: "agent_error", ...extra }).ok;
    expect(fail({ cause: "rate_limit", retry_at: "2026-11-14T15:00:00Z" })).toBe(true);
    expect(fail({ cause: "some_later_cause" })).toBe(true);
    expect(fail({ cause: "Rate limit" })).toBe(false);
    expect(fail({ cause: "x".repeat(65) })).toBe(false);
    expect(fail({ retry_at: "in an hour" })).toBe(false);
    expect(fail({ reason: "rate_limit" })).toBe(false);
  });

  it("rejects a task without instructions", () => {
    const result = validate("task", { id: "t", type: "x", title: "y" });
    expect(result.ok).toBe(false);
  });
});

describe("schema limits on app-supplied values", () => {
  const discovery = (endpoint: string) => ({
    protocol: "tether/1",
    app: { name: "App" },
    endpoints: Object.fromEntries(
      [
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
      ].map((key) => [key, endpoint]),
    ),
  });

  it.each([
    "/tether/v1/x",
    "https://app.example/x",
    "https://app.example:8443/x?a=b&c=d",
    "https://xn--bcher-kva.example/x",
    "https://app.example/a%2Fb",
    "/tether/v1/tasks/{id}/a%2Fb?x=1",
  ])("accepts the endpoint %s", (endpoint) => {
    expect(validate("discovery", discovery(endpoint))).toEqual({ ok: true });
  });

  it.each([
    "//evil.example/x",
    "/\\evil.example/x",
    "http://app.example/x",
    "javascript:alert(1)",
    "/tether\\v1/x",
    "/tether/v1/x\\",
    "https://app.example\\@evil.example/x",
    "/\t/evil.example/x",
    "/tether/v1/\tx",
    "/tether/v1/x\r",
    "/tether/v1/x\n",
    "https://app.example/x\n",
    "/a\u2028\\b",
    "https://x@app.example/x",
    "https://app.example%40evil.example/x",
    "https://app.example%2F/x",
    "/tether/v1/\u0000x",
    "/tether/v1/\u001fx",
    "/tether/v1/ x",
    "/tether/v1/x\u007f",
    "https://app.example/\u000bx",
  ])("refuses the endpoint %j", (endpoint) => {
    expect(validate("discovery", discovery(endpoint)).ok).toBe(false);
  });

  const task = (patch: Record<string, unknown>) => ({
    id: "tsk_1",
    type: "t",
    title: "T",
    instructions: "Do it.",
    mcp: { url: "https://app.example/mcp", token: "tok_0123456789abcdef0123456789" },
    tools: { requested: ["WebSearch"] },
    limits: { timeout_s: 60, max_budget_usd: 0.1 },
    ...patch,
  });

  it.each(["http://169.254.169.254/latest/mcp", "http://app.example/mcp", "file:///etc/passwd"])(
    "refuses the MCP URL %s",
    (url) => {
      const mcp = { url, token: "tok_0123456789abcdef0123456789" };
      expect(validate("task", task({ mcp })).ok).toBe(false);
    },
  );

  it("refuses an MCP URL with userinfo", () => {
    const mcp = {
      url: "https://app.example@evil.example/mcp",
      token: "tok_0123456789abcdef0123456789",
    };
    expect(validate("task", task({ mcp })).ok).toBe(false);
  });

  it.each([
    { icon: "https://app.example@evil.example/icon.png" },
    { url: "https://app.example:pw@evil.example/" },
    { url: "https://@evil.example/" },
    { icon: "https://app.example%40evil.example/i.png" },
    { url: "https://app.example%40evil.example/" },
  ])("refuses the app links %j", (links) => {
    const doc = { ...discovery("/tether/v1/x"), app: { name: "App", ...links } };
    expect(validate("discovery", doc).ok).toBe(false);
  });

  it("refuses an MCP URL with a percent sign in the host", () => {
    const mcp = {
      url: "https://app.example%40evil.example/mcp",
      token: "tok_0123456789abcdef0123456789",
    };
    expect(validate("task", task({ mcp })).ok).toBe(false);
  });

  it.each([
    { icon: "https://app.example:8443/icon.png", url: "https://app.example/?a=b&c=d" },
    { icon: "https://xn--bcher-kva.example/icon.png", url: "https://app.example/a%2Fb" },
  ])("accepts the app links %j", (links) => {
    const doc = { ...discovery("/tether/v1/x"), app: { name: "App", ...links } };
    expect(validate("discovery", doc)).toEqual({ ok: true });
  });

  it("accepts app links with an @ in the path or query", () => {
    const app = {
      name: "App",
      icon: "https://app.example/@me/icon.png",
      url: "https://app.example/?u=a@b",
    };
    expect(validate("discovery", { ...discovery("/tether/v1/x"), app })).toEqual({ ok: true });
  });

  it("accepts a loopback MCP URL for development", () => {
    const mcp = { url: "http://127.0.0.1:4000/mcp", token: "tok_0123456789abcdef0123456789" };
    expect(validate("task", task({ mcp }))).toEqual({ ok: true });
  });

  it("refuses a short task token and a tool list smuggled into one name", () => {
    expect(validate("task", task({ mcp: { url: "https://a.example/mcp", token: "t1" } })).ok).toBe(
      false,
    );
    expect(validate("task", task({ tools: { requested: ["WebFetch,Bash"] } })).ok).toBe(false);
  });

  const started = (patch: Record<string, unknown>) => ({
    device_code: "dc_7f3a9b2c4d5e6f708192a3b4",
    user_code: "KQTM-WXPD",
    verification_uri: "https://app.example/tether/pair",
    interval: 5,
    expires_in: 600,
    ...patch,
  });

  it.each([
    { verification_uri: "javascript:alert(1)" },
    { verification_uri: "file:///Applications/Calculator.app" },
    { verification_uri_complete: "http://app.example/pair?code=KQTM-WXPD" },
    { verification_uri: "https://app.example@evil.example/pair" },
    { verification_uri_complete: "https://app.example@evil.example/pair?code=KQTM-WXPD" },
    { user_code: "AB12" },
    { user_code: "KQ7M-3XPD" },
    { device_code: "dc_0000000000000001" },
  ])("refuses the pairing start %j", (patch) => {
    expect(validate("pair-start.response", started(patch)).ok).toBe(false);
  });

  it("requires the approving account in an approved pairing", () => {
    const approved = {
      status: "approved",
      device: { id: "dev_1", name: "Mac" },
      credential: "tdc_0123456789abcdef0123456789",
    };
    expect(validate("pair-poll.response", approved).ok).toBe(false);
    const named = { ...approved, account: { name: "Ann" } };
    expect(validate("pair-poll.response", named)).toEqual({ ok: true });
  });
});

describe("validate", () => {
  it("reports every problem with its path", () => {
    const result = validate("task", { id: "t", type: "x", title: "y", limits: { timeout_s: 0 } });
    expect(result).toEqual({
      ok: false,
      errors: [
        "body must have required property 'instructions'",
        "body must have required property 'mcp'",
        "body must have required property 'tools'",
        "body/limits must have required property 'max_budget_usd'",
        "body/limits/timeout_s must be >= 1",
      ],
    });
  });

  it("refuses an unknown schema name", () => {
    expect(() => validate("nope", {})).toThrow("unknown schema: nope");
  });
});
