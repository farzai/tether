#!/usr/bin/env bun
import { killAgentsNow } from "../client/claude-code.ts";
import { main } from "./main.ts";

// However Tether exits, no agent may outlive it: each runs in its own process group, so it would
// keep spending outside the caps with its task token on disk.
process.on("exit", killAgentsNow);

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (stop.signal.aborted) process.exit(130);
    process.stderr.write("Stopping: running tasks are left for the app to offer again.\n");
    stop.abort();
  });
}

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  signal: stop.signal,
});
