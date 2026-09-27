import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as ajvNs from 'ajv';
import * as ajvFormatsNs from 'ajv-formats';

// ajv & ajv-formats ship CJS default exports that NodeNext types as the module
// namespace; unwrap the real default (same interop wrinkle as schemas/index.ts).
const Ajv = (ajvNs as unknown as { default: new (opts?: object) => AjvInstance }).default;
const addFormats = (ajvFormatsNs as unknown as { default: (ajv: AjvInstance) => void }).default;

interface AjvInstance {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown[] | null };
}

/**
 * Full SARIF 2.1.0 JSON Schema validation, against the official OASIS schema vendored
 * at `schemas/vendor/sarif-2.1.0.schema.json`.
 *
 * The SARIF schema is authored in JSON Schema draft-07, so it is compiled with ajv's
 * default (draft-07) validator — NOT the Ajv2020 instance `schemas/index.ts` uses for
 * RTAP's own 2020-12 wire schemas. `ajv-formats` (already a dependency) is registered
 * so the schema's `uri`/`date-time` formats are actually checked rather than ignored.
 * This is real schema validation, not a hand-written field check.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, '../../schemas/vendor/sarif-2.1.0.schema.json');

type CompiledValidator = ((data: unknown) => boolean) & { errors?: unknown[] | null };

let cached: CompiledValidator | undefined;

function compiled(): CompiledValidator {
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as object;
  // strict:false — the SARIF schema uses keywords/annotations ajv's strict mode
  // rejects (it is an external, standards-body schema we validate against, not one we
  // author). allErrors so a failure reports every violation, not just the first.
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  cached = ajv.compile(schema);
  return cached;
}

export interface SarifSchemaValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
}

/** Validate a SARIF log object against the full SARIF 2.1.0 JSON Schema. */
export function validateSarifAgainstSchema(sarifLog: unknown): SarifSchemaValidationResult {
  const validate = compiled();
  const valid = validate(sarifLog);
  if (valid) return { valid: true, errors: [] };
  const errs = (validate.errors ?? []) as { instancePath?: string; message?: string }[];
  return { valid: false, errors: errs.map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`) };
}
