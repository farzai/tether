import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** Base of every schema `$id`; a schema's name is its file name without `.json`. */
export const SCHEMA_BASE = "https://raw.githubusercontent.com/farzai/tether/main/schemas/v1/";

export type Validation = { ok: true } | { ok: false; errors: string[] };

const schemaDir = new URL("../../schemas/v1/", import.meta.url);

function loadValidators(): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats.default(ajv);
  const names = readdirSync(schemaDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
  for (const name of names) {
    ajv.addSchema(JSON.parse(readFileSync(new URL(`${name}.json`, schemaDir), "utf8")));
  }
  return new Map(names.map((name) => [name, requireSchema(ajv, name)]));
}

function requireSchema(ajv: Ajv2020, name: string): ValidateFunction {
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
  const errors = (check.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`,
  );
  return { ok: false, errors };
}
