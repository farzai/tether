import { appendFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, type TaskLogEntry } from "../src/client/store.ts";

function entry(n: number): TaskLogEntry {
  return {
    at: "2026-11-14T00:00:00.000Z",
    app: "https://paper.example",
    appName: "Paper",
    id: `tsk_${n}`,
    type: "paper.summarise",
    title: "x".repeat(900),
    durationMs: 1000,
    costUsd: 0.01,
    ended: "complete",
  };
}

describe("the task log", () => {
  it("keeps the last 1000 tasks once it passes about 1 MB", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tether-store-")));
    for (let n = 1; n <= 1200; n += 1) store.logTask(entry(n));
    const file = join(store.home, "tasks.jsonl");
    expect(statSync(file).size).toBeLessThanOrEqual(1_100_000);
    const all = store.taskLog(1000);
    expect(all.at(-1)?.id).toBe("tsk_1200");
    expect(all.length).toBeLessThanOrEqual(1000);
    expect(all.length).toBeGreaterThan(900);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("skips a line cut short by a crash and keeps the next one", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tether-store-")));
    store.logTask(entry(1));
    appendFileSync(join(store.home, "tasks.jsonl"), '{"at": "2026');
    expect(store.taskLog(10).map((e) => e.id)).toEqual(["tsk_1"]);
    store.logTask(entry(2));
    expect(store.taskLog(10).map((e) => e.id)).toEqual(["tsk_1", "tsk_2"]);
  });
});
