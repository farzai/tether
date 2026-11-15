import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    title: "x".repeat(150),
    durationMs: 1000,
    costUsd: 0.01,
    ended: "complete",
  };
}

describe("the task log", () => {
  it("keeps the last 1000 tasks once it passes about 1 MB", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tether-store-")));
    for (let n = 1; n <= 4000; n += 1) store.logTask(entry(n));
    const file = join(store.home, "tasks.jsonl");
    expect(statSync(file).size).toBeLessThanOrEqual(1_100_000);
    const all = store.taskLog(1000);
    expect(all.at(-1)?.id).toBe("tsk_4000");
    expect(all.length).toBeLessThanOrEqual(1000);
    expect(all.length).toBeGreaterThan(900);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("writes exactly one line per task", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tether-store-")));
    store.logTask(entry(1));
    store.logTask(entry(2));
    const text = readFileSync(join(store.home, "tasks.jsonl"), "utf8");
    expect(text).toBe(`${JSON.stringify(entry(1))}\n${JSON.stringify(entry(2))}\n`);
  });

  it("starts an emptied log on its first line", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tether-store-")));
    writeFileSync(join(store.home, "tasks.jsonl"), "");
    store.logTask(entry(1));
    expect(readFileSync(join(store.home, "tasks.jsonl"), "utf8")).toBe(
      `${JSON.stringify(entry(1))}\n`,
    );
  });

  it("skips a line cut short by a crash and keeps the next one", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tether-store-")));
    store.logTask(entry(1));
    appendFileSync(join(store.home, "tasks.jsonl"), '{"at": "2026');
    expect(store.taskLog(10).map((e) => e.id)).toEqual(["tsk_1"]);
    store.logTask(entry(2));
    expect(store.taskLog(10).map((e) => e.id)).toEqual(["tsk_1", "tsk_2"]);
  });

  it("keeps at most 200 characters of an app's title", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tether-store-")));
    store.logTask({ ...entry(1), title: `${"t".repeat(199)}\u{1F600}${"x".repeat(5000)}` });
    const [logged] = store.taskLog(1);
    expect(Array.from(logged?.title ?? "")).toHaveLength(200);
    expect(logged?.title.endsWith("\u{1F600}")).toBe(true);
  });
});

describe("the service log", () => {
  it("keeps the last part of the log, from a line start, once it passes the limit", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tether-store-")));
    const file = join(store.home, "service.log");
    const lines = Array.from({ length: 60_000 }, (_, n) => `line ${n} ${"y".repeat(90)}`);
    writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o644 });
    store.trimServiceLog();
    const kept = readFileSync(file, "utf8");
    expect(kept.length).toBeLessThanOrEqual(1_000_000);
    expect(kept.length).toBeGreaterThan(900_000);
    expect(kept.startsWith("line ")).toBe(true);
    expect(kept.endsWith(`line 59999 ${"y".repeat(90)}\n`)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves a log at or under the limit, and a missing one, alone", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tether-store-")));
    store.trimServiceLog();
    const file = join(store.home, "service.log");
    writeFileSync(file, "started\n");
    store.trimServiceLog();
    expect(readFileSync(file, "utf8")).toBe("started\n");
    const atLimit = `${"z".repeat(4_999_999)}\n`;
    writeFileSync(file, atLimit);
    store.trimServiceLog();
    expect(statSync(file).size).toBe(5_000_000);
  });
});
