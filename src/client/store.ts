import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * Tether's files in one directory (mode 0700), each written whole to a temporary file and renamed,
 * readable only by the user (0600). Credentials live in `credentials.json` until keychain storage
 * lands.
 */
export class Store {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
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

  apps(): AppRecord[] {
    const raw = this.read("credentials.json") as { apps?: AppRecord[] } | undefined;
    return raw?.apps ?? [];
  }

  saveApp(record: AppRecord): void {
    const others = this.apps().filter((app) => app.origin !== record.origin);
    this.write("credentials.json", { apps: [...others, record] });
  }

  removeApp(origin: string): void {
    this.write("credentials.json", { apps: this.apps().filter((app) => app.origin !== origin) });
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
