import { spawnSync } from "node:child_process";

/**
 * What a program did: its exit status (null when it could not start, timed out or was killed),
 * its output, and, when it has no status, the spawn error code and the signal that ended it.
 */
export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  signal?: string;
}

/** Runs a program. `input` goes to its stdin: secrets travel there, never in argv, where `ps` shows them. */
export type Run = (command: string, args: string[], input?: string) => Ran;

export const run: Run = (command, args, input) => {
  const done = spawnSync(command, args, {
    input: input ?? "",
    encoding: "utf8",
    timeout: 15_000,
  });
  const error = (done.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: done.status,
    stdout: done.stdout ?? "",
    stderr: done.stderr ?? "",
    ...(error ? { error } : {}),
    ...(done.signal ? { signal: done.signal } : {}),
  };
};

/** How a program ended, for a message: "exited 2", "timed out", "could not run" or "was stopped". */
export function ended(done: Ran): string {
  if (done.status !== null) return `exited ${done.status}`;
  // A timeout also names the signal spawnSync sent, so it is checked first.
  if (done.error === "ETIMEDOUT") return "timed out";
  if (done.error) return "could not run";
  return done.signal ? `was stopped (${done.signal})` : "was stopped";
}
