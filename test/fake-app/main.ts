import { randomBytes } from "node:crypto";
import { startFakeApp } from "./server.ts";

/**
 * Starts the fake app server with its conformance hooks on, for trying the suite by hand:
 *   bun run fake-app [port]
 * The hook secret comes from TETHER_CONFORMANCE_SECRET, or a fresh one is made for this run.
 */
const port = Number(process.argv[2] ?? 0);
const hookSecret = process.env.TETHER_CONFORMANCE_SECRET || randomBytes(16).toString("hex");
const app = await startFakeApp({ hookSecret }, port);
process.stdout.write(
  `Fake Tether app on ${app.url}\nRun: TETHER_CONFORMANCE_SECRET=${hookSecret} bun run conformance ${app.url}\n`,
);
