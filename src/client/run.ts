import { spawnSync } from "node:child_process";

/** What a program did: its exit status (null when it could not start or timed out) and output. */
export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program. `input` goes to its stdin: secrets travel there, never in argv, where `ps` shows them. */
export type Run = (command: string, args: string[], input?: string) => Ran;

export const run: Run = (command, args, input) => {
  const done = spawnSync(command, args, {
    input: input ?? "",
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
};
