import { boolean, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { activeFlag, createdAt, primaryId, prose, updatedAt } from './_shared';
import type { AssignmentStrategy } from './enums';

/**
 * The service catalogue (ADR-008).
 *
 * `service_category` is a table, never an enum, so Admin can add "de-icing" or "crew
 * transport" with no migration and no deployment. The six seeded services are rows.
 *
 * `configSchemaJson` describes the per-service requirement fields that a request line
 * must supply; `src/domain/services/requirements.ts` compiles it to a Zod schema and
 * validates `requestServiceLines.requirementsJson` against it at runtime.
 */

/** One declared requirement field on a service category. */
export interface ServiceRequirementField {
  readonly key: string;
  readonly label: string;
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'text';
  readonly required: boolean;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
  readonly help?: string;
  /**
   * Show and require this field only when another declared field holds a given value.
   *
   * Declared inside `config_schema_json`, so this is a shape a category's JSON may take —
   * NOT a column. No migration, and every seeded category omits it, so today every field
   * is unconditional and behaviour is unchanged.
   *
   * It exists so a category added from Admin can say "ask for the de-icing fluid type only
   * when de-icing is required" without anyone writing a bespoke component for it.
   */
  readonly dependsOn?: {
    readonly field: string;
    /** Applies when the other field equals this. */
    readonly equals?: string | number | boolean;
    /** Or, when `equals` is absent, applies as soon as the other field holds any value. */
    readonly present?: boolean;
  };
}

export interface ServiceConfigSchema {
  readonly fields: readonly ServiceRequirementField[];
}

export const serviceCategories = pgTable('service_categories', {
  id: primaryId(),
  /** Stable machine identifier, e.g. `ground_transport`. Never shown to clients. */
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: prose('description'),
  /** "vehicle", "officer", "room night", "uplift" — used in quantity labels. */
  unitLabel: text('unit_label').notNull(),
  assignmentStrategy: text('assignment_strategy')
    .$type<AssignmentStrategy>()
    .notNull()
    .default('generic'),
  configSchemaJson: jsonb('config_schema_json').$type<ServiceConfigSchema>().notNull(),
  sortOrder: integer('sort_order').notNull().default(100),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: prose('description'),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  description: prose('description'),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ServiceCategory = typeof serviceCategories.$inferSelect;
export type NewServiceCategory = typeof serviceCategories.$inferInsert;
export type PlatformSetting = typeof platformSettings.$inferSelect;
export type FeatureFlag = typeof featureFlags.$inferSelect;
