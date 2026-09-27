import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
// ajv-formats ships a CJS default export that TS's NodeNext resolution types as the
// whole module namespace rather than unwrapping it; this is a well-known interop
// wrinkle (it calls correctly at runtime — Node's cjs-module-lexer resolves the real
// default export), not a real type error.
import * as ajvFormatsNs from 'ajv-formats';
const addFormats = (ajvFormatsNs as unknown as { default: (ajv: Ajv2020) => void }).default;

/**
 * Loads every *.schema.json under rtap/schemas/, registers them all with one
 * Ajv instance (so $ref: "rtap:common#/$defs/..." resolves across files), and
 * exposes a compiled validator per schema $id.
 *
 * Source of truth for the shapes themselves is wiki/Arch_Overlay/ARCHITECTURE.md
 * §1 and wiki/Arch_Overlay/FROZEN_INTEGRATION.md §2-§9 — this module does not
 * redefine anything, it makes those definitions executable.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.resolve(here, '../../schemas');

export const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'));

if (schemaFiles.length === 0) {
  throw new Error(`No *.schema.json files found under ${schemasDir}`);
}

export const schemaIds: string[] = [];

for (const file of schemaFiles) {
  const raw = readFileSync(path.join(schemasDir, file), 'utf-8');
  const schema = JSON.parse(raw) as { $id?: string };
  if (!schema.$id) {
    throw new Error(`Schema file ${file} has no $id`);
  }
  ajv.addSchema(schema, schema.$id);
  schemaIds.push(schema.$id);
}

const validators = new Map<string, ValidateFunction>();

export function validatorFor(id: string): ValidateFunction {
  let v = validators.get(id);
  if (!v) {
    const compiled = ajv.getSchema(id);
    if (!compiled) {
      throw new Error(`Unknown schema $id: ${id}. Known ids: ${schemaIds.join(', ')}`);
    }
    v = compiled;
    validators.set(id, v);
  }
  return v;
}

export function validate(id: string, data: unknown): { valid: boolean; errors: string[] } {
  const v = validatorFor(id);
  const valid = v(data) as boolean;
  return {
    valid,
    errors: valid ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`),
  };
}
