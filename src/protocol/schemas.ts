import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import claimRequest from "../../schemas/v1/claim.request.json" with { type: "json" };
import claimResponse from "../../schemas/v1/claim.response.json" with { type: "json" };
import common from "../../schemas/v1/common.json" with { type: "json" };
import conformanceEnqueueRequest from "../../schemas/v1/conformance-enqueue.request.json" with {
  type: "json",
};
import conformancePairRequest from "../../schemas/v1/conformance-pair.request.json" with {
  type: "json",
};
import discovery from "../../schemas/v1/discovery.json" with { type: "json" };
import error from "../../schemas/v1/error.json" with { type: "json" };
import heartbeatRequest from "../../schemas/v1/heartbeat.request.json" with { type: "json" };
import heartbeatResponse from "../../schemas/v1/heartbeat.response.json" with { type: "json" };
import pairPollRequest from "../../schemas/v1/pair-poll.request.json" with { type: "json" };
import pairPollResponse from "../../schemas/v1/pair-poll.response.json" with { type: "json" };
import pairStartRequest from "../../schemas/v1/pair-start.request.json" with { type: "json" };
import pairStartResponse from "../../schemas/v1/pair-start.response.json" with { type: "json" };
import task from "../../schemas/v1/task.json" with { type: "json" };
import taskCompleteRequest from "../../schemas/v1/task-complete.request.json" with { type: "json" };
import taskCompleteResponse from "../../schemas/v1/task-complete.response.json" with {
  type: "json",
};
import taskEventsRequest from "../../schemas/v1/task-events.request.json" with { type: "json" };
import taskEventsResponse from "../../schemas/v1/task-events.response.json" with { type: "json" };
import taskFailRequest from "../../schemas/v1/task-fail.request.json" with { type: "json" };
import taskFailResponse from "../../schemas/v1/task-fail.response.json" with { type: "json" };
import taskStatusResponse from "../../schemas/v1/task-status.response.json" with { type: "json" };

/** Base of every schema `$id`; a schema's name is its file name without `.json`. */
export const SCHEMA_BASE = "https://raw.githubusercontent.com/farzai/tether/main/schemas/v1/";

export type Validation = { ok: true } | { ok: false; errors: string[] };

// Bundled, not read from disk: a compiled binary carries no files beside it.
const SCHEMAS: { $id: string }[] = [
  claimRequest,
  claimResponse,
  common,
  conformanceEnqueueRequest,
  conformancePairRequest,
  discovery,
  error,
  heartbeatRequest,
  heartbeatResponse,
  pairPollRequest,
  pairPollResponse,
  pairStartRequest,
  pairStartResponse,
  task,
  taskCompleteRequest,
  taskCompleteResponse,
  taskEventsRequest,
  taskEventsResponse,
  taskFailRequest,
  taskFailResponse,
  taskStatusResponse,
];

// Ajv runs in strict mode by default, which rejects unknown schema keywords.
const ajv = new Ajv2020({ allErrors: true });
addFormats.default(ajv);

function loadValidators(): Map<string, ValidateFunction> {
  const names = SCHEMAS.map((schema) => schema.$id.slice(SCHEMA_BASE.length, -".json".length));
  for (const schema of SCHEMAS) ajv.addSchema(schema);
  return new Map(names.map((name) => [name, requireSchema(name)]));
}

function requireSchema(name: string): ValidateFunction {
  const check = ajv.getSchema(`${SCHEMA_BASE}${name}.json`);
  if (!check) throw new Error(`schema ${name}.json has an $id that does not match its file name`);
  return check;
}

const validators = loadValidators();

export function schemaNames(): Iterable<string> {
  return validators.keys();
}

/** Validates `data` against the named schema; throws on an unknown name (a programming error). */
export function validate(name: string, data: unknown): Validation {
  const check = validators.get(name);
  if (!check) throw new Error(`unknown schema: ${name}`);
  if (check(data)) return { ok: true };
  const errors = ajv.errorsText(check.errors, { dataVar: "body", separator: "\n" }).split("\n");
  return { ok: false, errors };
}
