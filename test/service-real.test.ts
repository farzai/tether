import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.ts";
import { instanceName } from "../src/client/store.ts";
import { type FakeApp, startFakeApp } from "./fake-app/server.ts";

// Installs a real background service, so it runs only where asked (CI sets TETHER_REAL_SERVICE=1).
// Its Tether home is a temporary directory, so its label is dev.farzai.tether-<hash>: it can never
// replace or remove a Tether the developer installed.
const REAL = process.env.TETHER_REAL_SERVICE === "1" && process.platform === "darwin";

const FAKE_CLAUDE = new URL("./fake-claude/claude.mjs", import.meta.url).pathname;
const BIN = new URL("../src/cli/bin.ts", import.meta.url).pathname;

const home = mkdtempSync(join(tmpdir(), "tether-real-service-"));
let out = "";
let err = "";
let app: FakeApp | undefined;

function tether(argv: string[]): Promise<number> {
  const bun = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
  return main(argv, {
    env: {
      TETHER_HOME: home,
      TETHER_CLAUDE_PATH: FAKE_CLAUDE,
      TETHER_KEYCHAIN: "off",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
    program: [bun, BIN],
  });
}

async function until(probe: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out; service log:\n${serviceLog()}`);
    await sleep(250);
  }
}

function serviceLog(): string {
  const file = join(home, "service.log");
  return existsSync(file) ? readFileSync(file, "utf8").slice(-4000) : "(none)";
}

afterAll(async () => {
  if (REAL) await tether(["service", "uninstall"]);
  await app?.close();
});

describe.runIf(REAL)("tether service on a real macOS", () => {
  it("installs a launchd agent that runs tasks, and uninstalls it", async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    app = await startFakeApp();
    const connecting = tether(["connect", app.url]);
    await until(() => /[B-Z]{4}-[B-Z]{4}/.test(out), 10_000);
    const code = /([B-Z]{4}-[B-Z]{4})/.exec(out)?.[1] as string;
    expect(app.approvePairing(code)).toBe(true);
    expect(await connecting).toBe(0);
    const credential = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")).apps[0]
      .credential as string;
    const task = app.enqueueFor(credential, { input: { fake: { fixture: "success" } } });

    expect(await tether(["service", "install"])).toBe(0);
    const label = `dev.farzai.${instanceName(home)}`;
    const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    expect(existsSync(plist)).toBe(true);

    // The proof that launchd really runs `tether start`: the task gets done.
    await until(async () => {
      const res = await fetch(`${app?.url}/tether/v1/tasks/${task.id}`, {
        headers: { authorization: `Bearer ${credential}` },
      });
      return ((await res.json()) as { status: string }).status === "completed";
    }, 60_000);
    out = "";
    await tether(["service", "status"]);
    expect(out).toMatch(/installed, running \(pid \d+\)/);
    out = "";
    await tether(["logs"]);
    expect(out).toContain(task.id);

    expect(await tether(["service", "uninstall"])).toBe(0);
    expect(existsSync(plist)).toBe(false);
    const target = `gui/${userInfo().uid}/${label}`;
    expect(() => execFileSync("launchctl", ["print", target], { stdio: "ignore" })).toThrow();
    expect(err).toBe("");
  }, 120_000);
});
