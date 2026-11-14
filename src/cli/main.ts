import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AppClient, AppError, CLIENT, type Fetch, parseAppUrl } from "../client/app-client.ts";
import { claudeVersion, SECRET_ENV_NAMES } from "../client/claude-code.ts";
import { type Keychain, systemKeychain } from "../client/keychain.ts";
import { clean, Log, type Output, Secrets } from "../client/output.ts";
import { policyWarnings } from "../client/policy.ts";
import { pause } from "../client/retry.ts";
import { type Run, run } from "../client/run.ts";
import { type AppRecord, defaultHome, instanceName, localDate, Store } from "../client/store.ts";
import { Worker } from "../client/worker.ts";
import { isAllowedUrl } from "../protocol/urls.ts";
import { doctor } from "./doctor.ts";
import {
  type ServiceManager,
  type ServiceSpec,
  serviceEnv,
  serviceManager,
  thisProgram,
} from "./service.ts";

export const USAGE = `Usage: tether <command>

  connect <app-url>     Pair this computer with an app (you approve it on the app's web page).
  start [--concurrency <n>]
                        Run in the foreground: claim the apps' tasks and run each one in a
                        fresh Claude Code session. Ctrl-C stops.
  status                Whether Tether is running, what it runs, and today's usage.
  apps                  The connected apps.
  disconnect <app>      Revoke this device at the app and forget it (app URL or name).
  doctor                Check that Claude Code is installed, signed in and supports the flags
                        Tether passes, and that each app is reachable and accepts this device.
  service install|uninstall|status
                        Run tether start in the background, now and at every login (launchd,
                        a systemd user unit, or Task Scheduler), remove it, or show its state.
  logs [--limit <n>]    The last tasks run (20 by default): when, app, type, id, duration, cost,
                        how it ended, and title.

Files live in ~/.tether (or TETHER_HOME): credentials.json, policy.json, usage.json, tasks.jsonl.
Device credentials go in the OS keychain where there is one (TETHER_KEYCHAIN=off keeps them
in credentials.json, readable only by you).
`;

export interface Io {
  env: Record<string, string | undefined>;
  stdout: Output;
  stderr: Output;
  /** Aborted on Ctrl-C or SIGTERM; `start` stops when it is. */
  signal?: AbortSignal;
  fetch?: Fetch;
  /** The keychain for credentials; when absent, the OS keychain (or none, see systemKeychain). */
  keychain?: Keychain;
  /** The command line that runs this Tether, for `service install` (see thisProgram). */
  program?: string[];
  /** For `service`: the OS, the process runner and the user's home; the real ones when absent. */
  platform?: NodeJS.Platform;
  run?: Run;
  userHome?: string;
}

interface Context {
  io: Io;
  store: Store;
  secrets: Secrets;
  out: Log;
  err: Log;
  fetch: Fetch;
}

class UsageError extends Error {}

type Command = (ctx: Context, args: string[]) => number | Promise<number>;

const COMMANDS: Record<string, Command> = {
  connect: (ctx, args) => connect(ctx, oneArg(args)),
  start: (ctx, args) => start(ctx, args),
  status: (ctx, args) => {
    noArgs(args);
    return status(ctx);
  },
  apps: (ctx, args) => {
    noArgs(args);
    return apps(ctx);
  },
  disconnect: (ctx, args) => disconnect(ctx, oneArg(args)),
  logs: (ctx, args) => logs(ctx, args),
  service: (ctx, args) => service(ctx, oneArg(args)),
  doctor: (ctx, args) => {
    noArgs(args);
    return doctor({
      store: ctx.store,
      out: ctx.out,
      fetch: ctx.fetch,
      env: ctx.io.env,
      agentCommand: agentCommandOf(ctx.io.env),
    });
  },
};

function agentCommandOf(env: Record<string, string | undefined>): string {
  return env.TETHER_CLAUDE_PATH || "claude";
}

function noArgs(args: string[]): void {
  if (args.length > 0) throw new UsageError();
}

/** Runs one tether command; resolves to its exit status (0 ok, 1 failed, 2 usage error). */
export async function main(argv: string[], io: Io): Promise<number> {
  const secrets = new Secrets();
  for (const name of SECRET_ENV_NAMES) secrets.add(io.env[name] ?? "");
  const ctx: Context = {
    io,
    store: openStore(io),
    secrets,
    out: new Log(io.stdout, secrets),
    err: new Log(io.stderr, secrets),
    fetch: io.fetch ?? fetch,
  };
  const [command = "", ...rest] = argv;
  try {
    const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (!run) throw new UsageError();
    return await run(ctx, rest);
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message) ctx.err.line(error.message);
      io.stderr.write(USAGE);
      return 2;
    }
    ctx.err.line(`tether: ${(error as Error).message}`);
    return 1;
  }
}

function openStore(io: Io): Store {
  const home = defaultHome(io.env);
  return new Store(home, io.keychain ?? systemKeychain(io.env, instanceName(home)));
}

function oneArg(args: string[]): string {
  const [value] = args;
  if (args.length !== 1 || value === undefined) throw new UsageError();
  return value;
}

function appUrl(value: string): string {
  try {
    return parseAppUrl(value);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

// connect

interface PairStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
}

type PairPoll =
  | { status: "pending" | "denied" | "expired" }
  | {
      status: "approved";
      device: { id: string; name: string };
      account: { name: string };
      credential: string;
    };

async function connect(ctx: Context, value: string): Promise<number> {
  const origin = appUrl(value);
  const client = await AppClient.discover(origin, ctx.fetch);
  const deviceName = `${hostname()} (Tether)`;
  const started = (await client.call("POST", "pair_start", {
    body: { client: CLIENT, device_name: deviceName },
    schema: "pair-start.response",
  })) as PairStart;
  ctx.secrets.add(started.device_code);
  const page = URL.parse(started.verification_uri);
  if (!page || !isAllowedUrl(origin, started.verification_uri)) {
    throw new AppError("refused", "The app's pairing page is not an https:// address.");
  }
  ctx.out.line(`Open ${page.href}`);
  ctx.out.line(`  (a page on ${page.host}) and enter code  ${started.user_code}`);
  ctx.out.line("Waiting for approval...");
  const approved = await pollPairing(ctx, client, started);
  ctx.secrets.add(approved.credential);
  const { where, warning } = ctx.store.saveApp({
    origin,
    name: client.app.name,
    device: approved.device,
    account: approved.account.name,
    credential: approved.credential,
    pairedAt: new Date().toISOString(),
  });
  ctx.out.line(
    `Connected to ${client.app.name} as "${approved.account.name}" (device "${approved.device.name}").`,
  );
  ctx.out.line(`The device credential is in ${where}.`);
  if (warning) ctx.err.line(warning);
  ctx.out.line(`If that is not your account, run: tether disconnect ${origin}`);
  return 0;
}

const EXPIRED = "The code expired. Run tether connect again.";

async function pollPairing(
  ctx: Context,
  client: AppClient,
  started: PairStart,
): Promise<Extract<PairPoll, { status: "approved" }>> {
  const deadline = Date.now() + started.expires_in * 1000;
  const wait = { intervalMs: started.interval * 1000, failures: 0 };
  while (Date.now() < deadline && !ctx.io.signal?.aborted) {
    await pause(wait.intervalMs, ctx.io.signal);
    const reply = await pollOnce(client, started.device_code, wait);
    if (reply === undefined || reply.status === "pending") continue;
    if (reply.status === "approved") return reply;
    throw new Error(
      reply.status === "denied" ? "The pairing was denied on the app's page." : EXPIRED,
    );
  }
  throw new Error(EXPIRED);
}

/** One poll; undefined when it must be retried, with `wait` lengthened as RFC 8628 says. */
async function pollOnce(
  client: AppClient,
  deviceCode: string,
  wait: { intervalMs: number; failures: number },
): Promise<PairPoll | undefined> {
  try {
    return (await client.call("POST", "pair_poll", {
      body: { device_code: deviceCode },
      schema: "pair-poll.response",
    })) as PairPoll;
  } catch (error) {
    if (!(error instanceof AppError) || error.kind !== "retry") throw error;
    // slow_down adds 5 seconds to the interval for good; other failures back off.
    if (error.code === "slow_down") wait.intervalMs += 5_000;
    else wait.intervalMs = Math.max(wait.intervalMs, Math.min(60_000, 1000 * 2 ** wait.failures));
    wait.failures += 1;
    return undefined;
  }
}

// start

async function start(ctx: Context, args: string[]): Promise<number> {
  const concurrency = parseCount(args, "concurrency", 1, 16);
  const records = connectedApps(ctx);
  const running = ctx.store.runState();
  if (running && isAlive(running.pid)) {
    throw new Error(`Tether is already running (pid ${running.pid}).`);
  }
  for (const warning of policyWarnings(ctx.store.policy())) ctx.err.line(warning);
  const agentCommand = agentCommandOf(ctx.io.env);
  const agentVersion = await claudeVersion(agentCommand, ctx.io.env);
  if (!agentVersion) {
    throw new Error("Claude Code was not found. Install it and sign in, then run tether start.");
  }
  const signal = ctx.io.signal ?? new AbortController().signal;
  const worker = new Worker({
    store: ctx.store,
    log: ctx.out,
    errors: ctx.err,
    secrets: ctx.secrets,
    fetch: ctx.fetch,
    env: ctx.io.env,
    concurrency,
    agentCommand,
    agentVersion,
    signal,
  });
  const trimming = trimServiceLog(ctx);
  try {
    return await worker.run(records);
  } finally {
    clearInterval(trimming);
  }
}

/** How often a running `tether start` checks the size of the service log. */
const SERVICE_LOG_CHECK_MS = 10 * 60_000;

/**
 * Keeps service.log, which the background service writes, under its size limit: now and every
 * ten minutes. Not on Windows, where cmd's `>>` keeps writing at its old offset after a cut.
 */
function trimServiceLog(ctx: Context): NodeJS.Timeout | undefined {
  if ((ctx.io.platform ?? process.platform) === "win32") return undefined;
  const trim = () => {
    try {
      ctx.store.trimServiceLog();
    } catch (error) {
      ctx.err.line(`Could not trim the service log: ${(error as Error).message}`);
    }
  };
  trim();
  const timer = setInterval(trim, SERVICE_LOG_CHECK_MS);
  timer.unref();
  return timer;
}

/**
 * The apps to run, after moving file credentials into the keychain; warns about each one the
 * keychain refused once its credential is known to the redactor.
 */
function connectedApps(ctx: Context): AppRecord[] {
  const refused = ctx.store.moveToKeychain();
  const records = ctx.store.apps();
  for (const record of records) ctx.secrets.add(record.credential);
  for (const warning of refused) ctx.err.line(warning);
  if (records.length === 0) throw new Error("No apps connected. Run: tether connect <app-url>");
  return records;
}

/** The command's only option, `--<name> <n>`, a whole number from 1 to `max`; no positionals. */
function parseCount(args: string[], name: string, fallback: number, max: number): number {
  try {
    // parseArgs is strict: an unknown option or a positional throws.
    const { values } = parseArgs({ args, options: { [name]: { type: "string" } } });
    const n = Number(values[name] ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error();
    return n;
  } catch {
    throw new UsageError(`--${name} must be a whole number from 1 to ${max}.`);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// status, apps, disconnect

function status(ctx: Context): number {
  const state = ctx.store.runState();
  if (state && isAlive(state.pid)) {
    ctx.out.line(`Tether is running (pid ${state.pid}, up to ${state.concurrency} at a time).`);
    for (const task of state.tasks) ctx.out.line(`  ${task.app}  ${task.id}  ${task.title}`);
    if (state.tasks.length === 0) ctx.out.line("  No task running.");
  } else {
    ctx.out.line("Tether is not running. Start it with: tether start");
  }
  const policy = ctx.store.policy();
  const usage = ctx.store.usage(localDate(new Date()));
  ctx.out.line(
    `Today: ${usage.total.tasks} of ${policy.daily.tasks} tasks, $${usage.total.usd.toFixed(2)} of $${policy.daily.usd.toFixed(2)}.`,
  );
  ctx.out.line(
    `Tools a task may get: ${policy.tools.join(", ") || "none"}, plus the app's own MCP tools.`,
  );
  return apps(ctx);
}

function apps(ctx: Context): number {
  const records = ctx.store.apps();
  if (records.length === 0) {
    ctx.out.line("No apps connected. Run: tether connect <app-url>");
    return 0;
  }
  ctx.out.line("Connected apps:");
  for (const app of records) {
    ctx.out.line(
      `  ${clean(app.name)}  ${app.origin}  account "${clean(app.account)}"  device "${clean(app.device.name)}"  since ${app.pairedAt.slice(0, 10)}`,
    );
  }
  return 0;
}

/** The app named by its URL, or by its name when that is unambiguous. */
function findApp(ctx: Context, value: string): AppRecord {
  const records = ctx.store.apps();
  const url = URL.parse(value);
  const matches = url
    ? records.filter((app) => app.origin === url.origin)
    : records.filter((app) => app.name === value);
  const [found, ...others] = matches;
  if (!found) throw new Error(`No connected app matches "${clean(value, 200)}". See: tether apps`);
  if (others.length > 0) {
    throw new Error(`More than one app is named "${clean(value, 200)}". Use its URL instead.`);
  }
  return found;
}

async function disconnect(ctx: Context, value: string): Promise<number> {
  const record = findApp(ctx, value);
  ctx.secrets.add(record.credential);
  try {
    const client = await AppClient.discover(record.origin, ctx.fetch);
    await client.call("POST", "revoke", { credential: record.credential });
  } catch (error) {
    if (!(error instanceof AppError) || error.kind !== "unauthorized") {
      ctx.err.line(
        `Could not revoke the device at ${record.origin} (${(error as Error).message}). Revoke it on the app's device page.`,
      );
    }
  }
  ctx.store.removeApp(record.origin);
  ctx.out.line(`Disconnected ${record.name} (${record.origin}).`);
  return 0;
}

// logs

function logs(ctx: Context, args: string[]): number {
  const entries = ctx.store.taskLog(parseCount(args, "limit", 20, 1000));
  if (entries.length === 0) ctx.out.line("No tasks have run yet.");
  for (const entry of entries) {
    const at = new Date(entry.at);
    ctx.out.line(
      [
        `${localDate(at)} ${at.toTimeString().slice(0, 8)}`,
        clean(entry.appName, 100),
        clean(entry.type, 100),
        clean(entry.id, 100),
        `${(entry.durationMs / 1000).toFixed(1)} s`,
        entry.costUsd === null ? "-" : `$${entry.costUsd.toFixed(4)}`,
        entry.ended,
        clean(entry.title, 200),
      ].join("  "),
    );
  }
  return 0;
}

// service

function serviceSpec(ctx: Context): ServiceSpec {
  const { io } = ctx;
  const home = ctx.store.home;
  return {
    name: instanceName(home),
    program: io.program ?? thisProgram(process.execPath, process.argv),
    env: serviceEnv(io.env),
    home,
    userHome: io.userHome ?? homedir(),
    uid: userInfo().uid,
    windowsUser: `${io.env.USERDOMAIN ?? ""}\\${io.env.USERNAME ?? userInfo().username}`,
  };
}

function service(ctx: Context, action: string): number {
  const manager = serviceManager(ctx.io.platform ?? process.platform);
  if (!manager) throw new Error("A background service is not supported on this system.");
  const spec = serviceSpec(ctx);
  const exec = ctx.io.run ?? run;
  if (action === "status") {
    ctx.out.line(`Background service (${manager.kind}): ${manager.status(spec, exec)}`);
    return 0;
  }
  if (action === "uninstall") {
    manager.uninstall(spec, exec);
    ctx.out.line(`Removed the background service (${manager.kind}).`);
    return 0;
  }
  if (action !== "install") throw new UsageError();
  installService(ctx, manager, spec, exec);
  return 0;
}

function installService(ctx: Context, manager: ServiceManager, spec: ServiceSpec, exec: Run): void {
  if (ctx.store.apps().length === 0) {
    throw new Error("No apps connected. Run: tether connect <app-url>, then install the service.");
  }
  for (const name of SECRET_ENV_NAMES) {
    if (ctx.io.env[name]) {
      ctx.err.line(
        `The service does not carry ${name}: Claude Code there uses its own sign-in (claude auth login).`,
      );
    }
  }
  manager.install(spec, exec);
  ctx.out.line(
    `Installed the background service (${manager.kind}): it runs now and at every login.`,
  );
  ctx.out.line(
    manager.kind === "systemd"
      ? `Its output: journalctl --user -u ${spec.name}`
      : `Its output: ${join(spec.home, "service.log")}`,
  );
  ctx.out.line("Check it with: tether service status, tether logs, tether doctor");
}
