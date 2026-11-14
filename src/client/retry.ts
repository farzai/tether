import { setTimeout as sleep } from "node:timers/promises";
import { AppError } from "./app-client.ts";

/** Exponential back-off from the protocol: 1 s doubling to 60 s, with jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.5 + random() / 2));
}

/** Waits `ms`, or less if `signal` aborts first; never throws. */
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  await sleep(ms, undefined, signal ? { signal } : {}).catch(() => {});
}

/** The wait before retrying a failed call: the app's Retry-After when it gave one. */
export function retryDelay(error: unknown, attempt: number): number {
  if (error instanceof AppError && error.retryAfterMs !== undefined) return error.retryAfterMs;
  return backoffMs(attempt);
}

/**
 * Runs `call` until it succeeds, retrying only `retry` failures, for at most `attempts` tries or
 * until `signal` aborts. Safe for calls the protocol makes idempotent (complete, fail).
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  attempts: number,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const retryable = error instanceof AppError && error.kind === "retry";
      if (!retryable || attempt + 1 >= attempts || signal?.aborted) throw error;
      await pause(retryDelay(error, attempt), signal);
    }
  }
}
