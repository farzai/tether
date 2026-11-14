#!/usr/bin/env node
// A stand-in for the `claude` binary in tests: it never calls a model. It replays a stream-json
// fixture recorded from Claude Code 2.1.325. The test picks the behaviour through the task input,
// which reaches this process on stdin, because Tether gives the agent only an allow-listed
// environment. Input fields under `fake`:
//   fixture   name of a file in test/fixtures/claude-code/ (without .jsonl)
//   record    path where this process writes what it was given (argv, env names, cwd, files)
//   delay_ms  pause before each line
//   hang      after the last line, keep running until killed
//   exit_code exit with this code instead of the one the result line implies
//   grandchild  start a long-running child process first and record its pid
//   ignore_term keep running on SIGTERM, so only SIGKILL stops it
//   hold_pipe   start a long-running child that keeps stdout and stderr open after this exits,
//               and record its pid; "escape" puts it in its own process group, out of Tether's reach
//   stderr    text to write to stderr before exiting
//   leak      write the MCP config (with the task token, raw and in base64) and the Anthropic key to
//             stderr, as a crashing agent might
// "$TOOLS" in a fixture's init line becomes the tools from --tools, "$CWD" the working directory.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
// `tether doctor` tests run this file under other names (symlinks) to pick a broken installation:
//   claude-signed-out  `auth status` says it is not signed in
//   claude-old         an older version whose --help lacks --restricted and that has no
//                      `auth status`
//   claude-newer       a newer version whose --help lists every flag Tether passes
const variant = basename(process.argv[1] ?? "");
const old = variant === "claude-old";
const versions = { "claude-old": "2.0.9", "claude-newer": "2.2.0" };
if (args[0] === "--version") {
  process.stdout.write(`${versions[variant] ?? "2.1.325"} (Claude Code)\n`);
  process.exit(0);
}
if (old && args[0] === "auth") {
  process.stderr.write("error: unknown command 'auth'\n");
  process.exit(1);
}
if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = variant !== "claude-signed-out";
  process.stdout.write(
    `${JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" })}\n`,
  );
  process.exit(loggedIn ? 0 : 1);
}
if (args[0] === "--help") {
  // As Claude Code 2.1.325 prints it: --append-system-prompt-file is a hidden option.
  const options = [
    "-p, --print",
    "--output-format <format>",
    "--verbose",
    "--mcp-config <configs...>",
    "--strict-mcp-config",
    ...(old ? [] : ["--restricted"]),
    "--tools <tools...>",
    "--allowedTools, --allowed-tools <tools...>",
    "--disallowedTools, --disallowed-tools <tools...>",
    "--permission-mode <mode>",
    "--max-budget-usd <amount>",
    "--no-session-persistence",
    "--setting-sources <sources>",
    "--disable-slash-commands",
  ];
  process.stdout.write(
    `Usage: claude [options]\n\nOptions:\n${options.map((o) => `  ${o}  text`).join("\n")}\n`,
  );
  process.exit(0);
}

const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const stdin = readFileSync(0, "utf8");
const json = stdin.slice(stdin.indexOf("{"), stdin.lastIndexOf("}") + 1);
const fake = JSON.parse(json).fake ?? {};
if (fake.ignore_term) process.on("SIGTERM", () => {});

const forever = ["-e", "setInterval(() => {}, 1000)"];
const grandchild = fake.grandchild
  ? spawn(process.execPath, forever, { stdio: "ignore" })
  : fake.hold_pipe
    ? spawn(process.execPath, forever, {
        stdio: ["ignore", "inherit", "inherit"],
        detached: fake.hold_pipe === "escape",
      })
    : undefined;
// A process left holding the pipes must not keep this one from exiting.
if (fake.hold_pipe) grandchild.unref();

if (fake.record) {
  const read = (path) => (path ? readFileSync(path, "utf8") : undefined);
  writeFileSync(
    fake.record,
    JSON.stringify({
      pid: process.pid,
      grandchildPid: grandchild?.pid,
      argv: args,
      env: Object.keys(process.env).sort(),
      cwd: process.cwd(),
      mcpConfig: JSON.parse(read(flag("--mcp-config")) ?? "null"),
      systemPrompt: read(flag("--append-system-prompt-file")),
      stdin,
    }),
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const tools = (flag("--tools") ?? "").split(",").filter(Boolean);
const lines = readFileSync(
  join(here, "..", "fixtures", "claude-code", `${fake.fixture ?? "success"}.jsonl`),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) =>
    line
      .replace('"$TOOLS"', JSON.stringify(tools))
      .replace('"$CWD"', JSON.stringify(process.cwd())),
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const line of lines) {
  if (fake.delay_ms) await sleep(fake.delay_ms);
  process.stdout.write(`${line}\n`);
}
if (fake.stderr) process.stderr.write(fake.stderr);
if (fake.leak) {
  const config = readFileSync(flag("--mcp-config"), "utf8");
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  process.stderr.write(`${config} ${Buffer.from(config).toString("base64")} ${key}\n`);
}
if (fake.hang) setInterval(() => {}, 1000);
else {
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  };
  const result = lines.map(parse).find((msg) => msg?.type === "result");
  process.exitCode = fake.exit_code ?? (result?.is_error ? 1 : 0);
}
