import { main } from "./command.ts";

process.exitCode = await main(process.argv.slice(2), process.env, process.stdout, process.stderr);
