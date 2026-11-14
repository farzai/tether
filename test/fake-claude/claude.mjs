#!/usr/bin/env node
// A stand-in for the `claude` binary in tests: it never calls a model. It replays a stream-json
// fixture recorded from Claude Code 2.1.325. The test picks the behaviour through the task input,
// which reaches this process on stdin, because Tether gives the agent only an allow-listed
// environment. Input fields under `fake`:
//   fixture   name of a file in fixtures/ (without .jsonl)
//   record    path where this process writes what it was given (argv, env names, cwd, files)
//   delay_ms  pause before each line
//   hang      after the last line, keep running until killed
//   exit_code exit with this code instead of the one the result line implies
//   grandchild  start a long-running child process first and record its pid
//   ignore_term keep running on SIGTERM, so only SIGKILL stops it
// "$TOOLS" in a fixture's init line becomes the tools from --tools, "$CWD" the working directory.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("2.1.325 (Claude Code)\n");
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

const grandchild = fake.grandchild
  ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  : undefined;

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
const lines = readFileSync(join(here, "fixtures", `${fake.fixture ?? "success"}.jsonl`), "utf8")
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
if (fake.hang) setInterval(() => {}, 1000);
else {
  const result = lines.map((line) => JSON.parse(line)).find((msg) => msg.type === "result");
  process.exitCode = fake.exit_code ?? (result?.is_error ? 1 : 0);
}
