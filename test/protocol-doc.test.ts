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

  it("rejects a task without instructions", () => {
    const result = validate("task", { id: "t", type: "x", title: "y" });
    expect(result.ok).toBe(false);
  });
});
