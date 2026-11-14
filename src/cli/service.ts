import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Run } from "../client/run.ts";

/** What a background service runs and where its files go; built once from the CLI's context. */
export interface ServiceSpec {
  /** `instanceName` of the Tether home: "tether", or "tether-<hash>" for any other home. */
  name: string;
  /** The command line that runs this Tether; the service appends `start`. */
  program: string[];
  /** Variables the service sets: never a secret (see serviceEnv). */
  env: Record<string, string>;
  /** The Tether home (TETHER_HOME or ~/.tether). */
  home: string;
  /** The user's home directory, where launchd and systemd look for user services. */
  userHome: string;
  /** The user's id, for launchd's gui domain. */
  uid: number;
  /** DOMAIN\user, for the Windows logon trigger. */
  windowsUser: string;
}

/** One OS service manager: install starts the service now and at every login. */
export interface ServiceManager {
  readonly kind: string;
  install(spec: ServiceSpec, run: Run): void;
  uninstall(spec: ServiceSpec, run: Run): void;
  /** One line saying whether it is installed and running. */
  status(spec: ServiceSpec, run: Run): string;
}

/** The variables a service carries: what decides where Tether's files and agent are, nothing else. */
export const SERVICE_ENV = ["PATH", "TETHER_HOME", "TETHER_CLAUDE_PATH", "TETHER_KEYCHAIN"];

export function serviceEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SERVICE_ENV) {
    const value = env[name];
    if (value) out[name] = name === "TETHER_HOME" ? resolve(value) : value;
  }
  return out;
}

/**
 * The command line that runs this Tether again: the binary itself when compiled with
 * `bun build --compile` (its script lives in Bun's embedded file system), else Bun and the script.
 */
export function thisProgram(execPath: string, argv: string[]): string[] {
  const script = argv[1];
  if (!script || script.startsWith("/$bunfs/") || script.includes("~BUN")) return [execPath];
  return [execPath, resolve(script)];
}

class ServiceError extends Error {}

function must(run: Run, command: string, args: string[], what: string): void {
  const done = run(command, args);
  if (done.status !== 0) {
    const detail = done.stderr.trim() || done.stdout.trim() || `exit ${done.status ?? "timeout"}`;
    throw new ServiceError(`${what} failed: ${detail.slice(0, 500)}`);
  }
}

function writePrivate(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// launchd (macOS)

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function launchdLabel(spec: ServiceSpec): string {
  return `dev.farzai.${spec.name}`;
}

export function launchdPlistPath(spec: ServiceSpec): string {
  return join(spec.userHome, "Library", "LaunchAgents", `${launchdLabel(spec)}.plist`);
}

export function launchdPlist(spec: ServiceSpec): string {
  const strings = (values: string[], indent: string) =>
    values.map((value) => `${indent}<string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  const log = xml(join(spec.home, "service.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(launchdLabel(spec))}</string>
  <key>ProgramArguments</key>
  <array>
${strings([...spec.program, "start"], "    ")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export const launchd: ServiceManager = {
  kind: "launchd",
  install(spec, run) {
    const target = `gui/${spec.uid}`;
    // launchd would create the log readable by everyone; create it first, readable by the user.
    const log = join(spec.home, "service.log");
    if (!existsSync(log)) writePrivate(log, "");
    writePrivate(launchdPlistPath(spec), launchdPlist(spec));
    run("launchctl", ["bootout", `${target}/${launchdLabel(spec)}`]);
    must(run, "launchctl", ["bootstrap", target, launchdPlistPath(spec)], "launchctl bootstrap");
  },
  uninstall(spec, run) {
    run("launchctl", ["bootout", `gui/${spec.uid}/${launchdLabel(spec)}`]);
    rmSync(launchdPlistPath(spec), { force: true });
  },
  status(spec, run) {
    if (!existsSync(launchdPlistPath(spec))) return "not installed";
    const done = run("launchctl", ["print", `gui/${spec.uid}/${launchdLabel(spec)}`]);
    if (done.status !== 0) return "installed, not loaded";
    const state = /^\s*state = (.+)$/m.exec(done.stdout)?.[1] ?? "unknown";
    const pid = /^\s*pid = (\d+)$/m.exec(done.stdout)?.[1];
    return `installed, ${state}${pid ? ` (pid ${pid})` : ""}`;
  },
};

// systemd (Linux)

/** One systemd unit word: quoted, with backslash, quote and specifier `%` escaped. */
function unitWord(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

export function systemdUnitPath(spec: ServiceSpec): string {
  return join(spec.userHome, ".config", "systemd", "user", `${spec.name}.service`);
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([name, value]) => `Environment=${unitWord(`${name}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Tether: runs connected apps' tasks with Claude Code
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${[...spec.program, "start"].map(unitWord).join(" ")}
${env}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

export const systemd: ServiceManager = {
  kind: "systemd",
  install(spec, run) {
    const unit = `${spec.name}.service`;
    writePrivate(systemdUnitPath(spec), systemdUnit(spec));
    must(run, "systemctl", ["--user", "daemon-reload"], "systemctl daemon-reload");
    must(run, "systemctl", ["--user", "enable", unit], "systemctl enable");
    must(run, "systemctl", ["--user", "restart", unit], "systemctl restart");
  },
  uninstall(spec, run) {
    run("systemctl", ["--user", "disable", "--now", `${spec.name}.service`]);
    rmSync(systemdUnitPath(spec), { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  },
  status(spec, run) {
    if (!existsSync(systemdUnitPath(spec))) return "not installed";
    const done = run("systemctl", ["--user", "is-active", `${spec.name}.service`]);
    return `installed, ${done.stdout.trim() || "unknown"}`;
  },
};

// Task Scheduler (Windows)

export function windowsTaskName(spec: ServiceSpec): string {
  return spec.name === "tether" ? "Tether" : `Tether-${spec.name.slice("tether-".length)}`;
}

function wrapperPath(spec: ServiceSpec): string {
  return join(spec.home, "service.cmd");
}

/** A batch value: `%` doubled; a quote or line break cannot be written safely and is refused. */
function batchValue(value: string): string {
  if (/["\r\n]/.test(value)) throw new ServiceError(`cannot write ${value} into a batch file`);
  return value.replace(/%/g, "%%");
}

/** The wrapper the task runs: Task Scheduler cannot set variables, so the wrapper does. */
export function windowsWrapper(spec: ServiceSpec): string {
  const lines = ["@echo off"];
  for (const [name, value] of Object.entries(spec.env)) {
    lines.push(`set "${name}=${batchValue(value)}"`);
  }
  lines.push(
    `${[...spec.program, "start"].map((arg) => `"${batchValue(arg)}"`).join(" ")} >> "${batchValue(join(spec.home, "service.log"))}" 2>&1`,
  );
  return `${lines.join("\r\n")}\r\n`;
}

/** The task: at logon, no time limit (the default kills it after 3 days), restart on failure. */
export function windowsTaskXml(spec: ServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Tether: runs connected apps' tasks with Claude Code</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(spec.windowsUser)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(spec.windowsUser)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(wrapperPath(spec))}</Command>
    </Exec>
  </Actions>
</Task>
`;
}

export const taskScheduler: ServiceManager = {
  kind: "Task Scheduler",
  install(spec, run) {
    const name = windowsTaskName(spec);
    const xmlPath = join(spec.home, "service.xml");
    writePrivate(wrapperPath(spec), windowsWrapper(spec));
    // schtasks reads task XML as UTF-16 with a byte order mark.
    writePrivate(xmlPath, Buffer.from(`\ufeff${windowsTaskXml(spec)}`, "utf16le"));
    must(run, "schtasks", ["/Create", "/TN", name, "/XML", xmlPath, "/F"], "schtasks /Create");
    rmSync(xmlPath, { force: true });
    must(run, "schtasks", ["/Run", "/TN", name], "schtasks /Run");
  },
  uninstall(spec, run) {
    const name = windowsTaskName(spec);
    run("schtasks", ["/End", "/TN", name]);
    run("schtasks", ["/Delete", "/TN", name, "/F"]);
    rmSync(wrapperPath(spec), { force: true });
  },
  status(spec, run) {
    const done = run("schtasks", ["/Query", "/TN", windowsTaskName(spec), "/FO", "LIST"]);
    if (done.status !== 0) return "not installed";
    return `installed, ${/^Status:\s*(.+)$/m.exec(done.stdout)?.[1]?.trim().toLowerCase() ?? "unknown"}`;
  },
};

export function serviceManager(platform: NodeJS.Platform): ServiceManager | undefined {
  if (platform === "darwin") return launchd;
  if (platform === "linux") return systemd;
  if (platform === "win32") return taskScheduler;
  return undefined;
}

export { ServiceError };
