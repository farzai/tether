import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Keychain,
  KeychainUnavailable,
  macKeychain,
  secretToolKeychain,
  systemKeychain,
} from "../src/client/keychain.ts";
import type { Ran, Run } from "../src/client/run.ts";
import { type AppRecord, instanceName, Store } from "../src/client/store.ts";

const SECRET = "tcred_s3cr3t-value_0123456789";

function record(origin = "https://paper.example"): AppRecord {
  return {
    origin,
    name: "Paper",
    device: { id: "dev_1", name: "Mac (Tether)" },
    account: "Ann",
    credential: SECRET,
    pairedAt: "2026-11-14T00:00:00.000Z",
  };
}

/** An in-memory keychain; `refuse` makes every write fail, as a locked keyring does. */
function memoryKeychain(refuse = false): Keychain & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    name: "the test keychain",
    items,
    get: (origin) => items.get(origin),
    set: (origin, secret) => {
      if (refuse) return "the test keychain is locked";
      items.set(origin, secret);
      return undefined;
    },
    delete: (origin) => {
      items.delete(origin);
    },
  };
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "tether-keychain-"));
}

function onDisk(dir: string): string {
  return readFileSync(join(dir, "credentials.json"), "utf8");
}

describe("credentials with a keychain", () => {
  it("keeps the credential in the keychain and out of the file, and reads it back", () => {
    const dir = home();
    const keychain = memoryKeychain();
    const saved = new Store(dir, keychain).saveApp(record());
    expect(saved).toEqual({ where: "the test keychain" });
    expect(keychain.items.get("https://paper.example")).toBe(SECRET);
    expect(onDisk(dir)).not.toContain(SECRET);
    expect(JSON.parse(onDisk(dir)).apps[0].credential_in).toBe("keychain");
    expect(new Store(dir, keychain).apps()).toEqual([record()]);
  });

  it("deletes the keychain item when the app is removed", () => {
    const dir = home();
    const keychain = memoryKeychain();
    const store = new Store(dir, keychain);
    store.saveApp(record());
    store.removeApp("https://paper.example");
    expect(keychain.items.size).toBe(0);
    expect(store.apps()).toEqual([]);
  });

  it("says to pair again when the keychain no longer holds the credential", () => {
    const dir = home();
    const keychain = memoryKeychain();
    new Store(dir, keychain).saveApp(record());
    keychain.items.clear();
    expect(() => new Store(dir, keychain).apps()).toThrow(
      /keychain.*tether connect https:\/\/paper\.example/,
    );
  });

  it("says the keychain is locked, not to pair again, when it cannot be read", () => {
    const dir = home();
    new Store(dir, memoryKeychain()).saveApp(record());
    const locked = macKeychain("tether", broken);
    expect(() => new Store(dir, locked).apps()).toThrow(/Unlock the keychain/);
    expect(() => new Store(dir, locked).apps()).not.toThrow(/Pair again/);
  });

  it("moves credentials left in the file into the keychain", () => {
    const dir = home();
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apps: [record()] }));
    const keychain = memoryKeychain();
    expect(new Store(dir, keychain).moveToKeychain()).toEqual([]);
    expect(onDisk(dir)).not.toContain(SECRET);
    expect(new Store(dir, keychain).apps()).toEqual([record()]);
  });

  it("still reads a credential an older Tether left in the file", () => {
    const dir = home();
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apps: [record()] }));
    expect(new Store(dir, memoryKeychain()).apps()).toEqual([record()]);
  });
});

describe("credentials without a keychain", () => {
  it("falls back to the file, readable only by the user, when the keychain refuses", () => {
    const dir = home();
    const keychain = memoryKeychain(true);
    const saved = new Store(dir, keychain).saveApp(record());
    expect(saved.where).toBe(join(dir, "credentials.json"));
    expect(saved.warning).toBe(
      `The test keychain refused the credential for https://paper.example (the test keychain is locked), so it is in ${join(dir, "credentials.json")}, readable only by you.`,
    );
    expect(JSON.parse(onDisk(dir)).apps[0].credential).toBe(SECRET);
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(new Store(dir, keychain).apps()).toEqual([record()]);
  });

  it("warns about each credential the keychain refuses when moving them", () => {
    const dir = home();
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apps: [record()] }));
    const warnings = new Store(dir, memoryKeychain(true)).moveToKeychain();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /refused the credential for https:\/\/paper\.example \(the test keychain is locked\)/,
    );
    expect(warnings[0]).not.toContain(SECRET);
  });

  it("says to pair again when a keychain record is read with no keychain at all", () => {
    const dir = home();
    new Store(dir, memoryKeychain()).saveApp(record());
    expect(() => new Store(dir).apps()).toThrow(/Pair again: tether connect/);
  });

  it("removes an app with no keychain", () => {
    const dir = home();
    const store = new Store(dir);
    store.saveApp(record());
    store.removeApp("https://paper.example");
    expect(store.apps()).toEqual([]);
  });

  it("uses the file, without a warning, when there is no keychain", () => {
    const dir = home();
    expect(new Store(dir).saveApp(record())).toEqual({ where: join(dir, "credentials.json") });
    expect(new Store(dir).apps()).toEqual([record()]);
  });

  it("moves a file credential to the keychain on the next save", () => {
    const dir = home();
    const keychain = memoryKeychain();
    new Store(dir).saveApp(record());
    new Store(dir, keychain).saveApp(record());
    expect(onDisk(dir)).not.toContain(SECRET);
  });
});

/** A fake `security` / `secret-tool`: records every call and keeps one secret. */
function fakeRun(): Run & { calls: { command: string; args: string[]; input?: string }[] } {
  let stored: string | undefined;
  const calls: { command: string; args: string[]; input?: string }[] = [];
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const verbs: Record<string, (input?: string) => Ran> = {
    "-i": (input) => {
      stored = /-w "([^"]*)"/.exec(input ?? "")?.[1];
      return ok();
    },
    store: (input) => {
      stored = input;
      return ok();
    },
    "find-generic-password": () =>
      stored === undefined ? { status: 44, stdout: "", stderr: "not found" } : ok(`${stored}\n`),
    lookup: () => (stored === undefined ? { status: 1, stdout: "", stderr: "" } : ok(stored)),
    "delete-generic-password": () => {
      stored = undefined;
      return ok();
    },
  };
  verbs.clear = verbs["delete-generic-password"] as () => Ran;
  const fake = ((command: string, args: string[], input?: string) => {
    calls.push({ command, args, ...(input === undefined ? {} : { input }) });
    return verbs[args[0] ?? ""]?.(input) ?? ok();
  }) as Run & { calls: typeof calls };
  fake.calls = calls;
  return fake;
}

const broken: Run = () => ({
  status: 1,
  stdout: "",
  stderr: "Cannot autolaunch D-Bus without X11",
});

describe.each([
  ["macOS", macKeychain],
  ["Secret Service", secretToolKeychain],
])("the %s keychain", (_, make) => {
  it("stores, reads and deletes a secret, which only ever travels on stdin", () => {
    const exec = fakeRun();
    const keychain = make("tether", exec);
    expect(keychain.set("https://paper.example", SECRET)).toBeUndefined();
    expect(keychain.get("https://paper.example")).toBe(SECRET);
    keychain.delete("https://paper.example");
    expect(keychain.get("https://paper.example")).toBeUndefined();
    for (const call of exec.calls) expect(call.args.join(" ")).not.toContain(SECRET);
    expect(exec.calls.some((call) => call.input?.includes(SECRET))).toBe(true);
  });

  it("reports a write it cannot read back as refused", () => {
    const writeOnly: Run = (_, args) =>
      ["-i", "store"].includes(args[0] ?? "")
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "keyring locked" };
    expect(make("tether", writeOnly).set("https://paper.example", SECRET)).toMatch(
      /did not answer \(1\)/,
    );
  });

  it("reports a refused write, and a read it could not make as unavailable, not missing", () => {
    const keychain = make("tether", broken);
    expect(keychain.set("https://paper.example", SECRET)).toMatch(/exited 1/);
    expect(() => keychain.get("https://paper.example")).toThrow(KeychainUnavailable);
  });
});

describe("the macOS keychain's stdin command", () => {
  it("refuses a secret it cannot quote rather than send a broken command", () => {
    const exec = fakeRun();
    const reason = "the origin or credential holds a character `security -i` cannot take";
    expect(macKeychain("tether", exec).set("https://paper.example", 'a"b')).toBe(reason);
    expect(macKeychain("tether", exec).set("https://paper.example", "a\\b")).toBe(reason);
    expect(exec.calls).toEqual([]);
  });
});

describe("the reason a keychain gives for refusing a secret", () => {
  it("names only the exit status of `security -i`, whose stdin holds the secret", () => {
    const echoes: Run = (_, args, input) =>
      args[0] === "-i"
        ? { status: 2, stdout: input ?? "", stderr: `parse error near ${input}` }
        : { status: 44, stdout: "", stderr: "" };
    const reason = macKeychain("tether", echoes).set("https://paper.example", SECRET);
    expect(reason).toBe("security exited 2");
  });

  it("says when the macOS keychain gives back something else than it was given", () => {
    const wrong: Run = (_, args) =>
      args[0] === "-i"
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 0, stdout: "another\n", stderr: "" };
    expect(macKeychain("tether", wrong).set("https://paper.example", SECRET)).toBe(
      "the macOS keychain did not give the credential back",
    );
  });

  it("keeps only the first line of what secret-tool printed, and says nothing more when it printed nothing", () => {
    const chatty: Run = () => ({
      status: 3,
      stdout: "",
      stderr: "No such secret collection\nat line 2\n",
    });
    expect(secretToolKeychain("tether", chatty).set("https://paper.example", SECRET)).toBe(
      "secret-tool exited 3: No such secret collection",
    );
    const quiet: Run = () => ({ status: 3, stdout: "", stderr: "" });
    expect(secretToolKeychain("tether", quiet).set("https://paper.example", SECRET)).toBe(
      "secret-tool exited 3",
    );
  });

  it("says why secret-tool could not store it, from its first line of stderr", () => {
    expect(secretToolKeychain("tether", broken).set("https://paper.example", SECRET)).toBe(
      "secret-tool exited 1: Cannot autolaunch D-Bus without X11",
    );
  });
});

describe("the macOS keychain's quoting", () => {
  it("stores a secret with spaces in it", () => {
    const exec = fakeRun();
    expect(macKeychain("tether", exec).set("https://paper.example", "a b  c")).toBeUndefined();
    expect(macKeychain("tether", exec).get("https://paper.example")).toBe("a b  c");
  });
});

describe("the instance name", () => {
  it("is tether for the default home and differs for every other home", () => {
    expect(instanceName(join(homedir(), ".tether"))).toBe("tether");
    const a = instanceName("/tmp/a");
    expect(a).toMatch(/^tether-[0-9a-f]{8}$/);
    expect(instanceName("/tmp/b")).not.toBe(a);
  });
});

describe("the system keychain", () => {
  it("is the macOS keychain on macOS and the Secret Service on Linux", () => {
    expect(systemKeychain({}, "tether", "darwin")?.name).toBe("the macOS keychain");
    expect(systemKeychain({}, "tether", "linux")?.name).toBe("the Secret Service keyring");
  });

  it("is none on Windows, or when TETHER_KEYCHAIN is off", () => {
    expect(systemKeychain({}, "tether", "win32")).toBeUndefined();
    expect(systemKeychain({ TETHER_KEYCHAIN: "off" }, "tether", "darwin")).toBeUndefined();
  });
});
