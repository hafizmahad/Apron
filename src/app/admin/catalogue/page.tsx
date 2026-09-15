import { asc, sql } from 'drizzle-orm';
import { qualified } from '@/db/sql';
import { hasPermission, requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { ServiceIcon } from '@/components/ui/domain-icon';
import { ActionButton, RecordForm, type RecordFieldSpec } from '@/components/ui/action-controls';
import { createServiceAction, toggleServiceAction } from '@/app/admin/actions';
import { getDb } from '@/db/client';
import { serviceCategories } from '@/db/schema';
import { assignmentStrategies } from '@/db/schema/enums';
import { assignmentStrategyHint, assignmentStrategyLabel, configValueLabel } from '@/lib/domain-labels';
import { strategiesWithConcreteRules } from '@/domain/matching';
import type { ServiceConfigSchema } from '@/db/schema';

export const dynamic = 'force-dynamic';

/**
 * Service catalogue (CLAUDE.md §14, ADR-008).
 *
 * The point this page makes visible: services are DATA. Each category's declared
 * requirement fields are shown exactly as stored, because that declaration is what
 * validates a request line at runtime and what the intake read-back renders. Adding a
 * category needs no migration: the form below writes a row, and matching picks it up on the
 * next run. Disabling one keeps its history intact and simply stops it being offered.
 */
export default async function AdminCataloguePage() {
  await requirePermission('provider.view.any');
  const editor = await hasPermission('catalogue.manage');

  const db = getDb();
  const rows = await db
    .select({
      id: serviceCategories.id,
      code: serviceCategories.code,
      name: serviceCategories.name,
      description: serviceCategories.description,
      unitLabel: serviceCategories.unitLabel,
      assignmentStrategy: serviceCategories.assignmentStrategy,
      sortOrder: serviceCategories.sortOrder,
      active: serviceCategories.active,
      configSchemaJson: serviceCategories.configSchemaJson,
      providerCount: sql<number>`(
        select count(distinct pc.provider_company_id)::int
        from provider_coverage pc
        where pc.service_category_id = ${qualified(serviceCategories.id)} and pc.active
      )`,
      coverageCount: sql<number>`(
        select count(*)::int from provider_coverage pc
        where pc.service_category_id = ${qualified(serviceCategories.id)} and pc.active
      )`,
    })
    .from(serviceCategories)
    .orderBy(asc(serviceCategories.sortOrder), asc(serviceCategories.name), asc(serviceCategories.id));

  const withRules = new Set(strategiesWithConcreteRules());

  const createFields: readonly RecordFieldSpec[] = [
    {
      name: 'code',
      label: 'Code',
      type: 'text',
      required: true,
      placeholder: 'concierge',
      hint: 'Lowercase, used by intake to classify a service token. Cannot be changed later.',
    },
    { name: 'name', label: 'Display name', type: 'text', required: true, placeholder: 'Concierge' },
    {
      name: 'unitLabel',
      label: 'Unit',
      type: 'text',
      required: true,
      placeholder: 'bookings',
      hint: 'What a quantity of 3 means — cars, rooms, officers, bookings.',
    },
    {
      name: 'sortOrder',
      label: 'Sort order',
      type: 'number',
      defaultValue: '100',
      hint: 'Lower sorts first across the product.',
    },
    {
      name: 'assignmentStrategy',
      label: 'Matching strategy',
      type: 'select',
      required: true,
      defaultValue: 'generic',
      wide: true,
      options: assignmentStrategies.map((strategy) => ({
        value: strategy,
        // The VALUE stays the enum member the database stores; only the label is readable.
        label: assignmentStrategyLabel(strategy),
      })),
      hint: 'Pick generic unless this service reuses an existing resource model. A strategy with no registered rules is matched on coverage alone, never incorrectly.',
    },
    {
      name: 'description',
      label: 'Description',
      type: 'textarea',
      wide: true,
      placeholder: 'What operations and providers should understand this service to cover.',
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Service catalogue"
        description="Services are rows, not an enum. A category added here is matched immediately — by its own rules if one is registered for its strategy, otherwise by coverage, hours, lead time and capacity."
      />

      {editor && (
        <div className="mb-6">
          <RecordForm
            action={createServiceAction}
            fields={createFields}
            trigger="Add a service"
            title="New service category"
            description="This writes a catalogue row — no migration, no deployment. Providers can declare coverage for it straight away, and intake can classify a request into it."
            submitLabel="Create service"
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((row) => {
          const config = row.configSchemaJson as ServiceConfigSchema;
          const hasConcreteRules = withRules.has(row.assignmentStrategy);

          return (
            <Card key={row.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2.5">
                    <ServiceIcon code={row.code} label="" className="size-5 text-accent" />
                    {row.name}
                  </span>
                }
                description={row.description}
                action={
                  <div className="flex items-center gap-2">
                    {row.active ? (
                      <Badge tone="success">active</Badge>
                    ) : (
                      <Badge tone="neutral">disabled</Badge>
                    )}
                    {editor && (
                      <ActionButton
                        action={toggleServiceAction}
                        fields={{ serviceCategoryId: row.id, active: row.active ? 'false' : 'true' }}
                        label={row.active ? 'Disable' : 'Enable'}
                        pendingLabel="Saving…"
                        confirm={
                          row.active
                            ? {
                                title: `Disable ${row.name}?`,
                                body: `It stops being offered on new requests and disappears from intake. ${String(row.coverageCount)} provider coverage row${row.coverageCount === 1 ? '' : 's'} and every request already using it are left untouched.`,
                                confirmLabel: 'Disable service',
                              }
                            : {
                                title: `Enable ${row.name}?`,
                                body: 'It becomes selectable on new requests immediately.',
                                confirmLabel: 'Enable service',
                              }
                        }
                      />
                    )}
                  </div>
                }
              />

              <div className="space-y-4 p-5">
                <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
                  <div>
                    <dt className="uppercase tracking-[0.1em] text-text-secondary">Code</dt>
                    <dd className="mt-0.5 font-mono text-text-primary">{row.code}</dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-[0.1em] text-text-secondary">Unit</dt>
                    <dd className="mt-0.5 text-text-primary">{row.unitLabel}</dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-[0.1em] text-text-secondary">Providers</dt>
                    <dd className="tabular mt-0.5 text-text-primary">{row.providerCount}</dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-[0.1em] text-text-secondary">Coverage rows</dt>
                    <dd className="tabular mt-0.5 text-text-primary">{row.coverageCount}</dd>
                  </div>
                </dl>

                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                    Matching strategy
                  </p>
                  <p className="mt-1 text-[13px] font-medium text-text-primary">
                    {assignmentStrategyLabel(row.assignmentStrategy)}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">
                    {assignmentStrategyHint(row.assignmentStrategy)}
                    {hasConcreteRules ? '' : ' No concrete resource rules are registered for it.'}
                  </p>
                  {/* The stored value, kept small — it is what the matching engine switches
                      on and what an audit event records. */}
                  <p className="mt-1.5 font-mono text-[11px] text-text-secondary/80">
                    {row.assignmentStrategy}
                  </p>
                </div>

                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                    Declared requirement fields
                  </p>
                  {config.fields.length === 0 ? (
                    <p className="mt-1 text-[13px] text-text-secondary">None declared.</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {config.fields.map((field) => (
                        <li key={field.key} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                          <span className="font-medium text-text-primary">{field.label}</span>
                          <span className="text-text-secondary">{field.type}</span>
                          {field.required && <Badge tone="accent">required</Badge>}
                          {field.options !== undefined && field.options.length > 0 && (
                            <span className="text-text-secondary">
                              ({field.options.slice(0, 5).map(configValueLabel).join(' · ')}
                              {field.options.length > 5 ? ' …' : ''})
                            </span>
                          )}
                          {field.unit !== undefined && (
                            <span className="text-text-secondary">in {field.unit}</span>
                          )}
                          {/* The stored key, kept last and small: it is what a saved
                              requirement is keyed by and what validation reports against. */}
                          <span className="font-mono text-[11px] text-text-secondary/70">
                            {field.key}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
