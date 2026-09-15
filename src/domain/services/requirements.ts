import { z } from 'zod';
import type { ServiceConfigSchema, ServiceRequirementField } from '@/db/schema';

/**
 * Runtime validation of service-line requirements against the catalogue (ADR-008).
 *
 * A service category declares its fields as data in `config_schema_json`. This module
 * compiles that declaration into a Zod schema at request time, so an admin who adds
 * "de-icing" with a `holdoverMinutes` field gets real validation with no deployment.
 *
 * Compiled schemas are cached by a content key, because the same six categories are
 * validated on every intake and recompiling a schema per request is pure waste.
 */

const cache = new Map<string, z.ZodType<Record<string, unknown>>>();

export interface RequirementIssue {
  readonly key: string;
  readonly label: string;
  readonly message: string;
}

export type RequirementValidation =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly RequirementIssue[] };

/** Compiles one declared field into a validator. */
function fieldSchema(field: ServiceRequirementField): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  switch (field.type) {
    case 'integer': {
      let numeric = z.number().int();
      if (field.min !== undefined) numeric = numeric.min(field.min);
      if (field.max !== undefined) numeric = numeric.max(field.max);
      schema = numeric;
      break;
    }
    case 'number': {
      let numeric = z.number();
      if (field.min !== undefined) numeric = numeric.min(field.min);
      if (field.max !== undefined) numeric = numeric.max(field.max);
      schema = numeric;
      break;
    }
    case 'boolean':
      schema = z.boolean();
      break;
    case 'enum': {
      const options = field.options ?? [];
      schema =
        options.length === 0
          ? z.string().min(1)
          : z.enum(options as unknown as [string, ...string[]]);
      break;
    }
    case 'text':
      schema = z.string().max(4000);
      break;
    case 'string':
    default:
      schema = z.string().max(500);
      break;
  }

  return field.required ? schema : schema.optional();
}

export function compileRequirementsSchema(
  categoryCode: string,
  config: ServiceConfigSchema,
): z.ZodType<Record<string, unknown>> {
  const key = `${categoryCode}:${JSON.stringify(config)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of config.fields) {
    shape[field.key] = fieldSchema(field);
  }

  // `strip` rather than `strict`: an unknown key from an older client is dropped, not a
  // hard failure. The declared fields are what the matching engine reads, and anything
  // else would be ignored downstream anyway.
  const schema = z.object(shape).strip() as unknown as z.ZodType<Record<string, unknown>>;
  cache.set(key, schema);
  return schema;
}

/**
 * Is a conditional field's dependency satisfied by the values supplied so far?
 *
 * A field with no `dependsOn` always applies — which is every seeded field today, so this
 * returns true throughout the current catalogue and changes nothing about it.
 */
export function dependencyMet(
  field: ServiceRequirementField,
  values: Record<string, unknown>,
): boolean {
  const rule = field.dependsOn;
  if (rule === undefined) return true;

  const other = values[rule.field];
  const supplied = other !== undefined && other !== null && other !== '';

  if (rule.equals !== undefined) return supplied && other === rule.equals;
  if (rule.present === false) return !supplied;
  return supplied;
}

/**
 * The config as it applies to THESE values: a conditional field whose dependency is not
 * met cannot be required yet, because nothing has asked for it.
 *
 * Without this, a category declaring `required: true` alongside `dependsOn` would be
 * unanswerable — the clarification engine would correctly decline to ask for it, and
 * validation would then refuse the request for not having it.
 */
function effectiveConfig(
  config: ServiceConfigSchema,
  values: Record<string, unknown>,
): ServiceConfigSchema {
  if (!config.fields.some((field) => field.dependsOn !== undefined)) return config;

  return {
    fields: config.fields.map((field) =>
      field.required && !dependencyMet(field, values) ? { ...field, required: false } : field,
    ),
  };
}

export function validateRequirements(
  categoryCode: string,
  config: ServiceConfigSchema,
  input: unknown,
): RequirementValidation {
  const coerced = coerceLooseValues(config, input);
  const applicable = effectiveConfig(config, coerced);
  const schema = compileRequirementsSchema(categoryCode, applicable);
  const parsed = schema.safeParse(coerced);

  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  const labels = new Map(config.fields.map((field) => [field.key, field.label]));
  const issues: RequirementIssue[] = parsed.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '');
    return { key, label: labels.get(key) ?? key, message: issue.message };
  });

  return { ok: false, issues };
}

/**
 * Nudges loosely-typed input into the declared types before validation.
 *
 * Intake and HTML forms both produce strings for everything. `"3"` for an integer field
 * is unambiguous and is converted; `"about three"` is not and is left alone to fail
 * validation with a message the user can act on. Nothing is invented — a value that
 * cannot be read as its declared type stays as it is and is reported.
 */
function coerceLooseValues(config: ServiceConfigSchema, input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') return {};

  const source = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const byKey = new Map(config.fields.map((field) => [field.key, field]));

  for (const [key, value] of Object.entries(source)) {
    const field = byKey.get(key);
    if (field === undefined) continue;

    // An empty string means "not supplied", not "the empty value".
    if (value === '' || value === null || value === undefined) continue;

    if (field.type === 'integer' || field.type === 'number') {
      if (typeof value === 'number') {
        result[key] = value;
      } else if (typeof value === 'string') {
        const parsed = Number(value.trim());
        result[key] = Number.isFinite(parsed) ? parsed : value;
      } else {
        result[key] = value;
      }
      continue;
    }

    if (field.type === 'boolean') {
      if (typeof value === 'boolean') {
        result[key] = value;
      } else if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['true', 'yes', 'on', '1'].includes(lowered)) result[key] = true;
        else if (['false', 'no', 'off', '0'].includes(lowered)) result[key] = false;
        else result[key] = value;
      } else {
        result[key] = value;
      }
      continue;
    }

    if (field.type === 'enum' && typeof value === 'string') {
      result[key] = matchEnumOption(field, value);
      continue;
    }

    result[key] = typeof value === 'string' ? value.trim() : value;
  }

  return result;
}

/**
 * Reads a declared option out of loosely-cased text.
 *
 * The model returns "SUV" where the catalogue declares `suv`, and a person typing into a
 * text box writes "Armored SUV" for `armored_suv`. Both name exactly one declared option and
 * nothing is being guessed at, so both are accepted.
 *
 * A value matching more than one option, or none, is returned untouched and fails validation
 * with a message — the engine then asks for it again rather than picking one.
 */
function matchEnumOption(field: ServiceRequirementField, value: string): string {
  const options = field.options ?? [];
  const normalise = (input: string): string =>
    input.trim().toLowerCase().replace(/[\s-]+/g, '_');

  const wanted = normalise(value);
  const hits = options.filter((option) => normalise(option) === wanted);

  return hits.length === 1 ? (hits[0] as string) : value.trim();
}

/** Declared fields that are required but absent — drives the "what's missing" prompts. */
export function missingRequiredFields(
  config: ServiceConfigSchema,
  input: Record<string, unknown>,
): ServiceRequirementField[] {
  return config.fields.filter((field) => {
    if (!field.required) return false;
    if (!dependencyMet(field, input)) return false;
    const value = input[field.key];
    return value === undefined || value === null || value === '';
  });
}
