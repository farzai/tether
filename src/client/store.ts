import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/** One finished task in tasks.jsonl. `title` and `type` come from the app: clean them to print. */
export interface TaskLogEntry {
  /** When it ended (ISO 8601). */
  at: string;
  app: string;
  appName: string;
  id: string;
  type: string;
  title: string;
  durationMs: number;
  /** What the agent reported spending, or null when it reported nothing. */
  costUsd: number | null;
  ended: string;
}

const TASK_LOG_KEEP = 1000;
const TASK_LOG_TRIM_BYTES = 1_000_000;
/** The longest title, in characters, the task log keeps: the app sets it, so it is not trusted. */
const TASK_LOG_TITLE_MAX = 200;
/** Past this size the service log is cut to about its last SERVICE_LOG_KEEP_BYTES. */
const SERVICE_LOG_MAX_BYTES = 5_000_000;
const SERVICE_LOG_KEEP_BYTES = 1_000_000;

/** Whether the file's last byte is not a newline; false for a missing or empty file. */
function endsTorn(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const size = statSync(file).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
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

  private makeHome(): void {
    // Only a home this call created is set to 0700: TETHER_HOME may point at a directory the user
    // owns for other things, such as their home directory, whose mode is theirs to keep.
    if (mkdirSync(this.home, { recursive: true, mode: 0o700 }) !== undefined) {
      chmodSync(this.home, 0o700);
    }
  }

  private write(name: string, value: unknown): void {
    this.makeHome();
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

  /**
   * Saves the app. `where` names the place its credential went: the keychain or the file. A
   * `warning` says the keychain refused it and why; with no keychain at all the file is the place.
   */
  saveApp(record: AppRecord): { where: string; warning?: string } {
    const others = this.stored().filter((app) => app.origin !== record.origin);
    const { credential, ...rest } = record;
    const refused = this.#keychain?.set(record.origin, credential);
    if (this.#keychain && refused === undefined) {
      this.write("credentials.json", { apps: [...others, { ...rest, credential_in: "keychain" }] });
      return { where: this.#keychain.name };
    }
    this.write("credentials.json", { apps: [...others, record] });
    const where = this.path("credentials.json");
    if (!this.#keychain) return { where };
    const name = this.#keychain.name.replace(/^./, (first) => first.toUpperCase());
    return {
      where,
      warning: `${name} refused the credential for ${record.origin} (${refused}), so it is in ${where}, readable only by you.`,
    };
  }

  /**
   * Moves credentials an older Tether, or a refused keychain, left in the file into the keychain;
   * returns a warning for each one the keychain refuses again.
   */
  moveToKeychain(): string[] {
    if (!this.#keychain) return [];
    const warnings: string[] = [];
    for (const app of this.stored()) {
      if (!("credential" in app)) continue;
      const { warning } = this.saveApp(app);
      if (warning) warnings.push(warning);
    }
    return warnings;
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

  /** Appends one finished task; past about 1 MB the log keeps its last 1000 tasks. */
  logTask(entry: TaskLogEntry): void {
    this.makeHome();
    const file = this.path("tasks.jsonl");
    // A crash mid-append leaves a line without its newline; start on a fresh line after it.
    const torn = endsTorn(file) ? "\n" : "";
    const title = Array.from(entry.title).slice(0, TASK_LOG_TITLE_MAX).join("");
    appendFileSync(file, `${torn}${JSON.stringify({ ...entry, title })}\n`, { mode: 0o600 });
    if (statSync(file).size > TASK_LOG_TRIM_BYTES) {
      const kept = this.taskLog(TASK_LOG_KEEP).map((entry) => JSON.stringify(entry));
      const temp = this.path(`.tasks.jsonl.${process.pid}.tmp`);
      writeFileSync(temp, `${kept.join("\n")}\n`, { mode: 0o600 });
      renameSync(temp, file);
    }
  }

  /**
   * Cuts service.log to its last lines once it passes about 5 MB. The file is rewritten in place,
   * not renamed: launchd and the Windows `>>` redirect append, so the running service keeps
   * writing at the new end of the same file.
   */
  trimServiceLog(): void {
    const file = this.path("service.log");
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size <= SERVICE_LOG_MAX_BYTES) return;
    const tail = Buffer.alloc(SERVICE_LOG_KEEP_BYTES);
    const fd = openSync(file, "r");
    try {
      readSync(fd, tail, 0, tail.length, size - tail.length);
    } finally {
      closeSync(fd);
    }
    // Start on a whole line: the first one in the tail is most likely cut.
    const kept = tail.subarray(tail.indexOf(0x0a) + 1);
    writeFileSync(file, kept, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  /** The last `limit` finished tasks, oldest first; a line that does not parse is skipped. */
  taskLog(limit: number): TaskLogEntry[] {
    let text: string;
    try {
      text = readFileSync(this.path("tasks.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: TaskLogEntry[] = [];
    for (const line of text.split("\n")) {
      try {
        if (line) entries.push(JSON.parse(line) as TaskLogEntry);
      } catch {
        // A line cut short by a crash mid-append.
      }
    }
    return entries.slice(-limit);
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
