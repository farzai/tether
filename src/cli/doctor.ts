import { AppClient, AppError, type Fetch } from "../client/app-client.ts";
import {
  adapterFlags,
  CLAUDE_CODE_VERSION,
  claudeCli,
  claudeVersion,
  HIDDEN_FLAGS,
} from "../client/claude-code.ts";
import { clean, type Log } from "../client/output.ts";
import type { AppRecord, Store } from "../client/store.ts";

export interface DoctorDeps {
  store: Store;
  out: Log;
  fetch: Fetch;
  env: Record<string, string | undefined>;
  agentCommand: string;
}

type Level = "ok" | "warn" | "FAIL";

/** A task id no app issues: asking for it proves the credential works (404) or not (401). */
const PROBE_TASK = "tether-doctor-probe";

/**
 * `tether doctor`: checks the agent CLI and every connected app, one line per check. Exit status
 * 1 when any check fails; a warning does not fail.
 */
export async function doctor(deps: DoctorDeps): Promise<number> {
  let failed = false;
  const say = (level: Level, text: string) => {
    if (level === "FAIL") failed = true;
    deps.out.line(`${level.padEnd(6)}${text}`);
  };
  await checkAgent(deps, say);
  const apps = deps.store.apps();
  if (apps.length === 0) say("warn", "No apps connected. Run: tether connect <app-url>");
  for (const app of apps) await checkApp(deps, app, say);
  return failed ? 1 : 0;
}

type Say = (level: Level, text: string) => void;

async function checkAgent(deps: DoctorDeps, say: Say): Promise<void> {
  const { agentCommand: command, env } = deps;
  const version = await claudeVersion(command, env);
  if (!version) {
    say("FAIL", `Claude Code was not found at ${command}. Install it, then run: claude auth login`);
    return;
  }
  say("ok", `Claude Code ${version} (${command})`);
  const auth = await claudeCli(command, ["auth", "status", "--json"], env);
  // Only the yes or no is read: the status also names the account, which is not printed here.
  if (signedIn(auth.stdout)) say("ok", "Claude Code is signed in");
  else say("FAIL", "Claude Code is not signed in. Run: claude auth login");
  await checkFlags(deps, version, say);
}

function signedIn(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

async function checkFlags(deps: DoctorDeps, version: string, say: Say): Promise<void> {
  if (version === CLAUDE_CODE_VERSION) {
    say("ok", `Flags: Tether's flags were checked against Claude Code ${CLAUDE_CODE_VERSION}`);
    return;
  }
  const help = (await claudeCli(deps.agentCommand, ["--help"], deps.env)).stdout;
  let missing = 0;
  for (const flag of adapterFlags()) {
    if (listed(help, flag)) continue;
    if (HIDDEN_FLAGS.includes(flag)) {
      say(
        "warn",
        `Flags: ${flag} is hidden from \`claude --help\`, so it was checked only on ${CLAUDE_CODE_VERSION}`,
      );
      continue;
    }
    missing += 1;
    say(
      "FAIL",
      `Flags: ${flag} is not in \`claude --help\` of ${version}; Tether was checked against ${CLAUDE_CODE_VERSION}`,
    );
  }
  if (missing === 0)
    say("ok", `Flags: \`claude --help\` of ${version} lists every flag Tether passes`);
}

/** Whether `flag` appears in the help text as a whole option name, not inside a longer one. */
function listed(help: string, flag: string): boolean {
  const name = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,])${name}(?=[\\s,=<[]|$)`, "m").test(help);
}

async function checkApp(deps: DoctorDeps, app: AppRecord, say: Say): Promise<void> {
  const label = `${clean(app.name, 100)} (${app.origin})`;
  try {
    const client = await AppClient.discover(app.origin, deps.fetch);
    await client.call("GET", "task", { id: PROBE_TASK, credential: app.credential });
    say("ok", `${label} answers and accepts this device`);
  } catch (error) {
    if (error instanceof AppError && error.kind === "gone") {
      say("ok", `${label} answers and accepts this device`);
    } else if (error instanceof AppError && error.kind === "unauthorized") {
      say(
        "FAIL",
        `${label} no longer accepts this device. Pair again: tether connect ${app.origin}`,
      );
    } else {
      say("FAIL", `${label} could not be reached: ${(error as Error).message}`);
    }
  }
}
