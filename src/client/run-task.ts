import type { AppClient, AppError } from "./app-client.ts";
import {
  ADAPTER_NAME,
  type AgentEvent,
  type AgentOptions,
  type AgentTask,
  type Outcome,
  type Usage,
} from "./claude-code.ts";
import { clean, type Log, type Secrets } from "./output.ts";
import { grantTools, type Policy, type TaskLimits } from "./policy.ts";
import { withRetry } from "./retry.ts";

/** The parts of a claimed task the client uses; the claim body was checked against its schema. */
export interface Claimed {
  task: {
    id: string;
    type: string;
    title: string;
    instructions: string;
    skill?: { name: string; version: string; markdown: string };
    input?: Record<string, unknown>;
    mcp: { url: string; token: string };
    tools: { requested: string[] };
    limits: { timeout_s: number; max_budget_usd: number };
  };
  lease: { id: string; duration_s: number };
}

export type RunAgent = (task: AgentTask, options: AgentOptions) => Promise<Outcome>;

export interface TaskDeps {
  client: AppClient;
  credential: string;
  log: Log;
  secrets: Secrets;
  policy: Policy;
  limits: TaskLimits;
  runAgent: RunAgent;
  agentCommand: string;
  env: Record<string, string | undefined>;
}

/** Why the agent was stopped early. The first reason wins; later ones are ignored. */
export type StopReason = "timeout" | "cancelled" | "lease_lost" | "unauthorized" | "shutdown";

/** Signals from outside one task: a cancel from the heartbeat, a 401 elsewhere, or shutdown. */
export interface TaskControl {
  stop(reason: StopReason): void;
}

const FLUSH_MS = 2_000;
const MAX_EVENTS = 100;
const REPORT_ATTEMPTS = 6;

type Report =
  | { kind: "complete"; body: Record<string, unknown> }
  | {
      kind: "fail";
      reason: string;
      message: string;
      usage?: Usage;
      cause?: string;
      retry_at?: string;
    };

type Fail = Extract<Report, { kind: "fail" }>;

function reportBody(report: Report): Record<string, unknown> {
  if (report.kind === "complete") return report.body;
  const { kind: _, ...body } = report;
  return body;
}

/** What the task ended as, for the caller's log line and spend accounting. */
export interface TaskResult {
  /** The reported cost, or undefined when the agent gave none (killed, refused). */
  costUsd: number | undefined;
  /**
   * How it ended, for the task log: "complete", "fail: <reason>", or "left" when it stopped without
   * a report (shutdown or lost lease) and the app hands the task out again.
   */
  ended: string;
}

/**
 * Runs one claimed task to its end: policy checks, the agent, progress events that also renew the
 * lease, and exactly one report. `control` lets the caller stop it.
 */
export function runTask(
  claim: Claimed,
  deps: TaskDeps,
): { control: TaskControl; done: Promise<TaskResult> } {
  const run = new TaskRun(claim, deps);
  return { control: run, done: run.start() };
}

class TaskRun implements TaskControl {
  readonly #claim: Claimed;
  readonly #deps: TaskDeps;
  readonly #abort = new AbortController();
  readonly #queue: Record<string, unknown>[] = [];
  #reason: StopReason | undefined;
  #leaseMs: number;
  #lastRenewal = Date.now();

  constructor(claim: Claimed, deps: TaskDeps) {
    this.#claim = claim;
    this.#deps = deps;
    this.#leaseMs = claim.lease.duration_s * 1000;
    deps.secrets.add(claim.task.mcp.token);
  }

  stop(reason: StopReason): void {
    if (this.#reason !== undefined) return;
    this.#reason = reason;
    this.#abort.abort();
  }

  private event(stage: string, fields: Record<string, unknown>): void {
    this.#queue.push({ at: new Date().toISOString(), stage, ...fields });
  }

  private say(text: string): void {
    this.#deps.log.line(`${this.#deps.client.app.name}  ${this.#claim.task.id}  ${text}`);
  }

  async start(): Promise<TaskResult> {
    try {
      return await this.run();
    } finally {
      this.#deps.secrets.delete(this.#claim.task.mcp.token);
    }
  }

  private async run(): Promise<TaskResult> {
    const { task } = this.#claim;
    const { client, policy, limits } = this.#deps;
    this.say(`started: ${task.title}`);
    if (task.mcp.url !== client.app.mcpUrl) {
      return this.finish(
        {
          kind: "fail",
          reason: "policy",
          message: "The task names an MCP server that is not the app's own.",
        },
        undefined,
      );
    }
    if (limits.budgetUsd < 0.01) {
      return this.finish(
        { kind: "fail", reason: "budget", message: "No budget left under the user's local caps." },
        undefined,
      );
    }
    const grant = grantTools(task.tools.requested, policy);
    this.event("started", { message: `Running ${ADAPTER_NAME}` });
    if (grant.refused.length > 0) {
      const line = `Tools not granted by local policy: ${grant.refused.join(", ")}`;
      this.say(line.replace("Tools not", "tools not"));
      this.event("message", { message: line });
    }
    const timer = setTimeout(() => this.stop("timeout"), limits.timeoutS * 1000);
    const flusher = this.flushLoop();
    const startedAt = Date.now();
    let outcome: Outcome;
    try {
      outcome = await this.#deps.runAgent(this.agentTask(grant.granted), {
        command: this.#deps.agentCommand,
        env: this.#deps.env,
        signal: this.#abort.signal,
        onEvent: (event) => this.onAgentEvent(event),
      });
    } finally {
      clearTimeout(timer);
    }
    this.#flushing = false;
    await flusher;
    const duration = Date.now() - startedAt;
    if (outcome.kind === "error" && outcome.detail) {
      // Redact the whole tail first, then cut it, so a cut cannot leave part of a secret.
      const detail = this.#deps.secrets.redact(outcome.detail).slice(-1000);
      this.say(`Claude Code wrote to stderr: ${detail}`);
    }
    return this.finish(this.reportFor(outcome, duration), outcome.usage.cost_usd);
  }

  private agentTask(tools: string[]): AgentTask {
    const { task } = this.#claim;
    const agentTask: AgentTask = {
      appName: this.#deps.client.app.name,
      instructions: task.instructions,
      input: task.input ?? {},
      mcp: task.mcp,
      tools,
      budgetUsd: Math.floor(this.#deps.limits.budgetUsd * 10_000) / 10_000,
    };
    if (task.skill) agentTask.skill = task.skill;
    return agentTask;
  }

  private onAgentEvent(event: AgentEvent): void {
    if (event.stage === "usage") {
      this.event("usage", { usage: event.usage });
      return;
    }
    const message = clean(this.#deps.secrets.redact(event.message), 2000);
    if (event.stage === "tool") this.say(message);
    this.event(event.stage, { message });
  }

  private reportFor(outcome: Outcome, durationMs: number): Report {
    const base = { usage: outcome.usage };
    const fail = (
      reason: string,
      message: string,
      extra: Pick<Fail, "cause" | "retry_at"> = {},
    ): Report => ({
      kind: "fail",
      reason,
      message: clean(this.#deps.secrets.redact(message), 2000),
      ...base,
      ...extra,
    });
    switch (outcome.kind) {
      case "success":
        return {
          kind: "complete",
          body: {
            exit_code: outcome.exitCode,
            duration_ms: durationMs,
            usage: outcome.usage,
            summary: clean(this.#deps.secrets.redact(outcome.summary), 2000),
          },
        };
      case "refused":
        return fail("policy", `Refused: ${outcome.message}.`);
      case "budget":
        return fail("budget", outcome.message);
      case "error":
        return fail("agent_error", outcome.message, {
          ...(outcome.cause ? { cause: outcome.cause } : {}),
          ...(outcome.retryAt ? { retry_at: outcome.retryAt } : {}),
        });
      case "killed":
        return this.#reason === "timeout"
          ? fail("timeout", `Stopped after ${this.#deps.limits.timeoutS} s`)
          : fail("cancelled_by_user", "Stopped because the task was cancelled");
    }
  }

  /** Sends the one report, unless the task is no longer ours or Tether is shutting down. */
  private async finish(report: Report, costUsd: number | undefined): Promise<TaskResult> {
    const reason = this.#reason;
    if (reason === "shutdown") {
      this.say("stopped; the app will offer it again");
      return { costUsd, ended: "left" };
    }
    if (reason === "lease_lost" || reason === "unauthorized") {
      this.say("dropped: the task is no longer this device's");
      return { costUsd, ended: "left" };
    }
    const key = report.kind === "complete" ? "task_complete" : "task_fail";
    const ended = report.kind === "complete" ? "complete" : `fail: ${report.reason}`;
    try {
      await withRetry(
        () =>
          this.#deps.client.call("POST", key, {
            id: this.#claim.task.id,
            credential: this.#deps.credential,
            body: { lease_id: this.#claim.lease.id, ...reportBody(report) },
            schema: `${key.replace("_", "-")}.response`,
          }),
        REPORT_ATTEMPTS,
      );
      this.say(
        report.kind === "complete"
          ? `completed: ${clean(report.body.summary as string, 200)}`
          : `failed: ${report.reason}${report.cause ? ` (${report.cause})` : ""}: ${report.message}`,
      );
    } catch (error) {
      this.say(`could not report the result: ${(error as Error).message}`);
      return { costUsd, ended: `${ended} (not reported)` };
    }
    return { costUsd, ended };
  }

  // Events and lease renewal

  #flushing = true;

  private async flushLoop(): Promise<void> {
    while (this.#flushing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const since = Date.now() - this.#lastRenewal;
      // Progress goes out every couple of seconds; with nothing to say, renew at a third of the lease.
      const due = (this.#queue.length > 0 && since >= FLUSH_MS) || since >= this.#leaseMs / 3;
      if (due && this.#flushing) await this.flush();
    }
    if (this.#reason === undefined) await this.flush();
  }

  private async flush(): Promise<void> {
    const events = this.#queue.slice(0, MAX_EVENTS);
    let reply: { status: string; lease?: { duration_s: number } };
    try {
      reply = (await this.#deps.client.call("POST", "task_events", {
        id: this.#claim.task.id,
        credential: this.#deps.credential,
        body: { lease_id: this.#claim.lease.id, events },
        schema: "task-events.response",
      })) as typeof reply;
    } catch (error) {
      this.flushFailed(error as AppError, events.length);
      return;
    }
    this.#queue.splice(0, events.length);
    this.#lastRenewal = Date.now();
    if (reply.lease) this.#leaseMs = reply.lease.duration_s * 1000;
    if (reply.status === "cancelled") this.stop("cancelled");
  }

  /** A lost lease or a dead credential stops the agent; events the app refused are dropped. */
  private flushFailed(error: AppError, sent: number): void {
    if (error.kind === "gone") this.stop("lease_lost");
    if (error.kind === "unauthorized") this.stop("unauthorized");
    if (error.kind === "rejected") this.#queue.splice(0, sent);
  }
}
