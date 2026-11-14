import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Keychain, KeychainUnavailable } from "./keychain.ts";
import { type Cap, DEFAULT_POLICY, type Policy, parsePolicy, type Usage } from "./policy.ts";

/** A paired app as stored on disk. `credential` is the device credential: a secret. */
export interface AppRecord {
  origin: string;
  name: string;
  device: { id: string; name: string };
  account: string;
  credential: string;
  pairedAt: string;
}

/** An app record in credentials.json: the credential itself, or a note that the keychain holds it. */
type StoredApp = Omit<AppRecord, "credential"> &
  ({ credential: string } | { credential_in: "keychain" });

/** What a running `tether start` publishes for `tether status`. */
export interface RunState {
  pid: number;
  startedAt: string;
  concurrency: number;
  tasks: { app: string; id: string; title: string; startedAt: string }[];
}

/** The local date as YYYY-MM-DD: daily caps reset at the user's midnight. */
export function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function defaultHome(env: Record<string, string | undefined>): string {
  return env.TETHER_HOME || join(homedir(), ".tether");
}

/**
 * Names this Tether home's keychain items and background service: "tether" for ~/.tether, and
 * "tether-" plus a hash of the path for any other home, so two homes never replace each other's.
 */
export function instanceName(home: string): string {
  if (resolve(home) === resolve(homedir(), ".tether")) return "tether";
  return `tether-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 8)}`;
}

/**
 * Tether's files in one directory (mode 0700), each written whole to a temporary file and renamed,
 * readable only by the user (0600). A device credential lives in the OS keychain when there is one
 * that takes it, and otherwise in `credentials.json`.
 */
export class Store {
  readonly home: string;
  readonly #keychain: Keychain | undefined;

  constructor(home: string, keychain?: Keychain) {
    this.home = home;
    this.#keychain = keychain;
  }

  private path(name: string): string {
    return join(this.home, name);
  }

  private read(name: string): unknown {
    try {
      return JSON.parse(readFileSync(this.path(name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`${this.path(name)} could not be read: ${(error as Error).message}`);
    }
  }

  private write(name: string, value: unknown): void {
    // Only a home this call created is set to 0700: TETHER_HOME may point at a directory the user
    // owns for other things, such as their home directory, whose mode is theirs to keep.
    if (mkdirSync(this.home, { recursive: true, mode: 0o700 }) !== undefined) {
      chmodSync(this.home, 0o700);
    }
    const temp = this.path(`.${name}.${process.pid}.tmp`);
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path(name));
  }

  private stored(): StoredApp[] {
    const raw = this.read("credentials.json") as { apps?: StoredApp[] } | undefined;
    return raw?.apps ?? [];
  }

  apps(): AppRecord[] {
    return this.stored().map((app) => this.withCredential(app));
  }

  private withCredential(app: StoredApp): AppRecord {
    if ("credential" in app) return app;
    const { credential_in: _, ...record } = app;
    const pairAgain = `Pair again: tether connect ${app.origin}`;
    let credential: string | undefined;
    try {
      credential = this.#keychain?.get(app.origin);
    } catch (error) {
      if (!(error instanceof KeychainUnavailable)) throw error;
      throw new Error(
        `The credential for ${app.origin} is in the keychain, but ${error.message}. Unlock the keychain (sign in to the desktop) and try again.`,
      );
    }
    if (credential === undefined) {
      throw new Error(
        `The keychain no longer holds the credential for ${app.origin}. ${pairAgain}`,
      );
    }
    return { ...record, credential };
  }

  /** Saves the app; returns where its credential went (the keychain's name or the file's path). */
  saveApp(record: AppRecord): string {
    const others = this.stored().filter((app) => app.origin !== record.origin);
    const { credential, ...rest } = record;
    if (this.#keychain?.set(record.origin, credential)) {
      this.write("credentials.json", { apps: [...others, { ...rest, credential_in: "keychain" }] });
      return this.#keychain.name;
    }
    this.write("credentials.json", { apps: [...others, record] });
    return this.path("credentials.json");
  }

  /** Moves credentials an older Tether, or a refused keychain, left in the file into the keychain. */
  moveToKeychain(): void {
    if (!this.#keychain) return;
    for (const app of this.stored()) if ("credential" in app) this.saveApp(app);
  }

  removeApp(origin: string): void {
    this.write("credentials.json", { apps: this.stored().filter((app) => app.origin !== origin) });
    this.#keychain?.delete(origin);
  }

  policy(): Policy {
    const raw = this.read("policy.json");
    return raw === undefined ? DEFAULT_POLICY : parsePolicy(raw);
  }

  usage(today: string): Usage {
    const raw = this.read("usage.json") as Usage | undefined;
    return raw?.date === today ? raw : { date: today, total: { tasks: 0, usd: 0 }, apps: {} };
  }

  addUsage(today: string, origin: string, spent: Cap): Usage {
    const usage = this.usage(today);
    const add = (cap: Cap = { tasks: 0, usd: 0 }): Cap => ({
      tasks: cap.tasks + spent.tasks,
      usd: cap.usd + spent.usd,
    });
    const next = {
      date: today,
      total: add(usage.total),
      apps: { ...usage.apps, [origin]: add(usage.apps[origin]) },
    };
    this.write("usage.json", next);
    return next;
  }

  runState(): RunState | undefined {
    return this.read("state.json") as RunState | undefined;
  }

  writeRunState(state: RunState): void {
    this.write("state.json", state);
  }

  clearRunState(): void {
    rmSync(this.path("state.json"), { force: true });
  }
}
