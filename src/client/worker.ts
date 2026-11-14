import { AppClient, AppError, CLIENT, type Fetch } from "./app-client.ts";
import { ADAPTER_NAME, runClaudeCode } from "./claude-code.ts";
import type { Log, Secrets } from "./output.ts";
import { type Cap, capReached, taskLimits, type Usage } from "./policy.ts";
import { backoffMs, pause, retryDelay } from "./retry.ts";
import { type Claimed, type RunAgent, runTask, type TaskControl } from "./run-task.ts";
import { type AppRecord, localDate, type Store } from "./store.ts";

export interface WorkerOptions {
  store: Store;
  log: Log;
  /** Problems the user must act on, such as a revoked device. */
  errors: Log;
  secrets: Secrets;
  fetch: Fetch;
  env: Record<string, string | undefined>;
  concurrency: number;
  agentCommand: string;
  agentVersion: string;
  /** Aborted on Ctrl-C or SIGTERM. */
  signal: AbortSignal;
  runAgent?: RunAgent;
}

const CAP_RECHECK_MS = 60_000;

/** A fair counting semaphore: waiters get slots in the order they asked. */
class Slots {
  readonly max: number;
  #free: number;
  readonly #waiters: (() => void)[] = [];

  constructor(max: number) {
    this.max = max;
    this.#free = max;
  }

  get free(): number {
    return this.#free;
  }

  async take(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (this.#free > 0) {
      this.#free -= 1;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", cancel);
        resolve(true);
      };
      const cancel = () => {
        const at = this.#waiters.indexOf(grant);
        if (at !== -1) this.#waiters.splice(at, 1);
        resolve(false);
      };
      this.#waiters.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  give(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#free += 1;
  }
}

interface Running {
  app: string;
  id: string;
  title: string;
  startedAt: string;
  control: TaskControl;
  done: Promise<unknown>;
}

/**
 * `tether start`: one heartbeat loop and one claim loop per app, sharing one pool of task slots
 * so that all apps together never run more than `concurrency` tasks. Today's spend is reserved
 * when a task is claimed and settled when it ends, so caps hold across concurrent tasks.
 */
export class Worker {
  readonly #opts: WorkerOptions;
  readonly #slots: Slots;
  readonly #running = new Map<string, Running>();
  /** Budget reserved by running tasks, per app origin. */
  readonly #reserved = new Map<string, number>();

  constructor(opts: WorkerOptions) {
    this.#opts = opts;
    this.#slots = new Slots(opts.concurrency);
    opts.signal.addEventListener(
      "abort",
      () => {
        for (const task of this.#running.values()) task.control.stop("shutdown");
      },
      { once: true },
    );
  }

  /** Runs until stopped; resolves to the exit status (1 when no app could be served). */
  async run(apps: AppRecord[]): Promise<number> {
    for (const app of apps) this.#opts.secrets.add(app.credential);
    this.#publish();
    const results = await Promise.all(apps.map((app) => this.#serve(app, apps.length)));
    await Promise.all([...this.#running.values()].map((r) => r.done));
    this.#opts.store.clearRunState();
    return results.some((ok) => ok) ? 0 : 1;
  }

  /** Serves one app until shutdown or until its credential is refused; false on refusal. */
  async #serve(record: AppRecord, appCount: number): Promise<boolean> {
    const appStop = new AbortController();
    const stop = AbortSignal.any([appStop.signal, this.#opts.signal]);
    const client = await this.#discover(record, stop);
    if (!client) return !appStop.signal.aborted;
    const dead = (error: unknown) => {
      if (!(error instanceof AppError) || error.kind !== "unauthorized" || appStop.signal.aborted)
        return;
      this.#opts.errors.line(
        `${record.name}  the app no longer accepts this device. Pair again: tether connect ${record.origin}`,
      );
      for (const task of this.#running.values())
        if (task.app === record.origin) task.control.stop("unauthorized");
      appStop.abort();
    };
    this.#opts.log.line(`${client.app.name}  online, waiting for tasks`);
    await Promise.all([
      this.#heartbeatLoop(client, record, stop, dead),
      this.#claimLoop(client, record, stop, dead, appCount > 1 ? 5 : 30),
    ]);
    return !appStop.signal.aborted;
  }

  async #discover(record: AppRecord, stop: AbortSignal): Promise<AppClient | undefined> {
    for (let attempt = 0; !stop.aborted; attempt += 1) {
      try {
        const client = await AppClient.discover(record.origin, this.#opts.fetch);
        if (client.app.origin === record.origin) return client;
      } catch (error) {
        this.#opts.log.line(`${record.name}  ${(error as Error).message}; retrying`);
      }
      await pause(backoffMs(attempt), stop);
    }
    return undefined;
  }

  async #heartbeatLoop(
    client: AppClient,
    record: AppRecord,
    stop: AbortSignal,
    dead: (error: unknown) => void,
  ): Promise<void> {
    let intervalMs = 15_000;
    for (let failures = 0; !stop.aborted; ) {
      const ids = [...this.#running.values()]
        .filter((r) => r.app === record.origin)
        .map((r) => r.id);
      try {
        const reply = (await client.call("POST", "heartbeat", {
          credential: record.credential,
          body: {
            client: CLIENT,
            adapters: [{ name: ADAPTER_NAME, version: this.#opts.agentVersion }],
            capacity: { max: this.#slots.max, available: this.#slots.free },
            tasks: ids,
          },
          schema: "heartbeat.response",
          signal: stop,
        })) as { heartbeat_interval_s: number; cancelled: string[] };
        intervalMs = reply.heartbeat_interval_s * 1000;
        failures = 0;
        for (const id of reply.cancelled)
          this.#running.get(`${record.origin} ${id}`)?.control.stop("cancelled");
        await pause(intervalMs, stop);
      } catch (error) {
        dead(error);
        await pause(Math.max(intervalMs, retryDelay(error, failures)), stop);
        failures += 1;
      }
    }
  }

  #usage(today: string): Usage {
    const usage = this.#opts.store.usage(today);
    const apps: Record<string, Cap> = { ...usage.apps };
    let reserved = 0;
    for (const [origin, usd] of this.#reserved) {
      const spent = apps[origin] ?? { tasks: 0, usd: 0 };
      apps[origin] = { tasks: spent.tasks, usd: spent.usd + usd };
      reserved += usd;
    }
    return { ...usage, total: { ...usage.total, usd: usage.total.usd + reserved }, apps };
  }

  /** Waits until today's caps leave room for a task of this app. */
  async #roomForTask(record: AppRecord, stop: AbortSignal): Promise<void> {
    let said: string | undefined;
    while (!stop.aborted) {
      const policy = this.#opts.store.policy();
      const usage = this.#usage(localDate(new Date()));
      const reached =
        capReached(policy, usage, record.origin) ??
        (taskLimits({ timeout_s: 1, max_budget_usd: 1 }, policy, usage, record.origin).budgetUsd <
        0.01
          ? "daily spend cap reached"
          : undefined);
      if (reached === undefined) return;
      if (reached !== said) this.#opts.log.line(`${record.name}  ${reached}; not taking tasks`);
      said = reached;
      await pause(CAP_RECHECK_MS, stop);
    }
  }

  async #claimLoop(
    client: AppClient,
    record: AppRecord,
    stop: AbortSignal,
    dead: (error: unknown) => void,
    waitS: number,
  ): Promise<void> {
    for (let failures = 0; !stop.aborted; ) {
      await this.#roomForTask(record, stop);
      if (!(await this.#slots.take(stop))) return;
      let claim: Claimed | undefined;
      try {
        claim = (await client.call("POST", "claim", {
          credential: record.credential,
          body: { wait_s: waitS },
          schema: "claim.response",
          timeoutMs: (waitS + 15) * 1000,
          signal: stop,
        })) as Claimed | undefined;
        failures = 0;
      } catch (error) {
        this.#slots.give();
        if (stop.aborted) return;
        dead(error);
        await pause(retryDelay(error, failures), stop);
        failures += 1;
        continue;
      }
      // A claim that lands after shutdown began is dropped: its lease expires and the app re-offers it.
      if (!claim || stop.aborted) {
        this.#slots.give();
        continue;
      }
      this.#start(client, record, claim);
    }
  }

  #start(client: AppClient, record: AppRecord, claim: Claimed): void {
    const today = localDate(new Date());
    const policy = this.#opts.store.policy();
    const limits = taskLimits(claim.task.limits, policy, this.#usage(today), record.origin);
    const reservation = Math.max(0, limits.budgetUsd);
    this.#opts.store.addUsage(today, record.origin, { tasks: 1, usd: 0 });
    this.#reserved.set(record.origin, (this.#reserved.get(record.origin) ?? 0) + reservation);
    const key = `${record.origin} ${claim.task.id}`;
    const { control, done } = runTask(claim, {
      client,
      credential: record.credential,
      log: this.#opts.log,
      secrets: this.#opts.secrets,
      policy,
      limits,
      runAgent: this.#opts.runAgent ?? runClaudeCode,
      agentCommand: this.#opts.agentCommand,
      env: this.#opts.env,
    });
    const settled = done
      .then((result) => (result.costUsd === undefined ? reservation : result.costUsd))
      .catch((error: unknown) => {
        this.#opts.log.line(`${record.name}  ${claim.task.id}  ${(error as Error).message}`);
        return reservation;
      })
      .then((spent) => {
        this.#reserved.set(record.origin, (this.#reserved.get(record.origin) ?? 0) - reservation);
        this.#opts.store.addUsage(localDate(new Date()), record.origin, { tasks: 0, usd: spent });
        this.#running.delete(key);
        this.#slots.give();
        this.#publish();
      });
    this.#running.set(key, {
      app: record.origin,
      id: claim.task.id,
      title: claim.task.title,
      startedAt: new Date().toISOString(),
      control,
      done: settled,
    });
    this.#publish();
  }

  #publish(): void {
    this.#opts.store.writeRunState({
      pid: process.pid,
      startedAt: this.#startedAt,
      concurrency: this.#slots.max,
      tasks: [...this.#running.values()].map(({ app, id, title, startedAt }) => ({
        app,
        id,
        title,
        startedAt,
      })),
    });
  }

  readonly #startedAt = new Date().toISOString();
}
