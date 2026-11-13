import { parseArgs } from "node:util";
import { runConformance } from "./runner.ts";

const USAGE = `Usage: bun run conformance <base-url> [--hook-secret <secret>]

Checks that the app server at <base-url> follows Tether Protocol v1.
The hook secret can also come from TETHER_CONFORMANCE_SECRET.
Exit status: 0 every check passed, 1 a check failed or was skipped, 2 usage error.
`;

interface Args {
  baseUrl: string;
  hookSecret?: string;
}

/** Parses the command line; returns undefined on a usage error. */
export function parseCli(
  argv: string[],
  env: Record<string, string | undefined>,
): Args | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { "hook-secret": { type: "string" } },
    });
    const [baseUrl] = positionals;
    if (positionals.length !== 1 || !baseUrl || !URL.canParse(baseUrl)) return undefined;
    const hookSecret = values["hook-secret"] ?? env.TETHER_CONFORMANCE_SECRET;
    return hookSecret ? { baseUrl, hookSecret } : { baseUrl };
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const args = parseCli(process.argv.slice(2), process.env);
  if (!args) {
    process.stderr.write(USAGE);
    return 2;
  }
  const run = await runConformance(args);
  process.stdout.write(run.report);
  return run.ok ? 0 : 1;
}

process.exitCode = await main();
