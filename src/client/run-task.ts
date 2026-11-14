import { type AppClient, AppError } from "./app-client.ts";
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
  | { kind: "fail"; reason: string; message: string; usage?: Usage };

/** What the task ended as, for the caller's log line and spend accounting. */
export interface TaskResult {
  /** The reported cost, or undefined when the agent gave none (killed, refused). */
  costUsd: number | undefined;
  /** Stopped without a report (shutdown or lost lease): the app hands the task out again. */
  abandoned: boolean;
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

  #event(stage: string, fields: Record<string, unknown>): void {
    this.#queue.push({ at: new Date().toISOString(), stage, ...fields });
  }

  #say(text: string): void {
    this.#deps.log.line(`${this.#deps.client.app.name}  ${this.#claim.task.id}  ${text}`);
  }

  async start(): Promise<TaskResult> {
    try {
      return await this.#run();
    } finally {
      this.#deps.secrets.delete(this.#claim.task.mcp.token);
    }
  }

  async #run(): Promise<TaskResult> {
    const { task } = this.#claim;
    const { client, policy, limits } = this.#deps;
    this.#say(`started: ${task.title}`);
    if (task.mcp.url !== client.app.mcpUrl) {
      return this.#finish(
        {
          kind: "fail",
          reason: "policy",
          message: "The task names an MCP server that is not the app's own.",
        },
        undefined,
      );
    }
    if (limits.budgetUsd < 0.01) {
      return this.#finish(
        { kind: "fail", reason: "budget", message: "No budget left under the user's local caps." },
        undefined,
      );
    }
    const grant = grantTools(task.tools.requested, policy);
    this.#event("started", { message: `Running ${ADAPTER_NAME}` });
    if (grant.refused.length > 0) {
      const line = `Tools not granted by local policy: ${grant.refused.join(", ")}`;
      this.#say(line.replace("Tools not", "tools not"));
      this.#event("message", { message: line });
    }
    const timer = setTimeout(() => this.stop("timeout"), limits.timeoutS * 1000);
    const flusher = this.#flushLoop();
    const startedAt = Date.now();
    let outcome: Outcome;
    try {
      outcome = await this.#deps.runAgent(this.#agentTask(grant.granted), {
        command: this.#deps.agentCommand,
        env: this.#deps.env,
        signal: this.#abort.signal,
        onEvent: (event) => this.#onAgentEvent(event),
      });
    } finally {
      clearTimeout(timer);
    }
    this.#flushing = false;
    await flusher;
    const duration = Date.now() - startedAt;
    return this.#finish(this.#reportFor(outcome, duration), outcome.usage.cost_usd);
  }

  #agentTask(tools: string[]): AgentTask {
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

  #onAgentEvent(event: AgentEvent): void {
    if (event.stage === "usage") {
      this.#event("usage", { usage: event.usage });
      return;
    }
    const message = clean(this.#deps.secrets.redact(event.message), 2000);
    if (event.stage === "tool") this.#say(message);
    this.#event(event.stage, { message });
  }

  #reportFor(outcome: Outcome, durationMs: number): Report {
    const base = { usage: outcome.usage };
    const fail = (reason: string, message: string): Report => ({
      kind: "fail",
      reason,
      message,
      ...base,
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
        return fail("agent_error", outcome.message);
      case "killed":
        return this.#reason === "timeout"
          ? fail("timeout", `Stopped after ${this.#deps.limits.timeoutS} s`)
          : fail("cancelled_by_user", "Stopped because the task was cancelled");
    }
  }

  /** Sends the one report, unless the task is no longer ours or Tether is shutting down. */
  async #finish(report: Report, costUsd: number | undefined): Promise<TaskResult> {
    const reason = this.#reason;
    if (reason === "shutdown" || reason === "lease_lost" || reason === "unauthorized") {
      this.#say(
        reason === "shutdown"
          ? "stopped; the app will offer it again"
          : "dropped: the lease is gone",
      );
      return { costUsd, abandoned: true };
    }
    const leaseId = this.#claim.lease.id;
    const key = report.kind === "complete" ? "task_complete" : "task_fail";
    const body =
      report.kind === "complete"
        ? { lease_id: leaseId, ...report.body }
        : {
            lease_id: leaseId,
            reason: report.reason,
            message: report.message,
            ...(report.usage ? { usage: report.usage } : {}),
          };
    try {
      await withRetry(
        () =>
          this.#deps.client.call("POST", key, {
            id: this.#claim.task.id,
            credential: this.#deps.credential,
            body,
            schema: `${key.replace("_", "-")}.response`,
          }),
        REPORT_ATTEMPTS,
      );
      this.#say(
        report.kind === "complete" ? "completed" : `failed: ${report.reason}: ${report.message}`,
      );
    } catch (error) {
      this.#say(`could not report the result: ${(error as Error).message}`);
    }
    return { costUsd, abandoned: false };
  }

  // Events and lease renewal

  #flushing = true;

  async #flushLoop(): Promise<void> {
    while (this.#flushing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const since = Date.now() - this.#lastRenewal;
      // Progress goes out every couple of seconds; with nothing to say, renew at a third of the lease.
      const due = (this.#queue.length > 0 && since >= FLUSH_MS) || since >= this.#leaseMs / 3;
      if (due && this.#flushing) await this.#flush();
    }
    if (this.#reason === undefined) await this.#flush();
  }

  async #flush(): Promise<void> {
    const events = this.#queue.slice(0, MAX_EVENTS);
    try {
      const reply = (await this.#deps.client.call("POST", "task_events", {
        id: this.#claim.task.id,
        credential: this.#deps.credential,
        body: { lease_id: this.#claim.lease.id, events },
        schema: "task-events.response",
      })) as { status: string; lease?: { duration_s: number } };
      this.#queue.splice(0, events.length);
      this.#lastRenewal = Date.now();
      if (reply.lease) this.#leaseMs = reply.lease.duration_s * 1000;
      if (reply.status === "cancelled") this.stop("cancelled");
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.kind === "gone") this.stop("lease_lost");
      else if (error.kind === "unauthorized") this.stop("unauthorized");
      else if (error.kind === "rejected" || error.kind === "refused")
        this.#queue.splice(0, events.length);
    }
  }
}
