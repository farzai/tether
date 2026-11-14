#!/usr/bin/env bun
import { main } from "./main.ts";

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
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
