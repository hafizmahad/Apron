import { asc } from 'drizzle-orm';
import { hasPermission, requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { ActionButton, InlineValueForm } from '@/components/ui/action-controls';
import { setFlagAction, setSettingAction } from '@/app/admin/actions';
import { flagLabel, groupByArea, settingLabel } from '@/lib/settings-labels';
import { getDb } from '@/db/client';
import { featureFlags, platformSettings } from '@/db/schema';
import { getEnv, isAiEnabled } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

/**
 * Platform settings and feature flags (CLAUDE.md §14).
 *
 * Real values from the database plus the runtime configuration the process actually
 * booted with. No secret is rendered — only whether one is present, which is the part an
 * administrator needs to know (CLAUDE.md §27 "no sensitive data in client bundles").
 *
 * Settings and flags are editable here and each edit writes an audit event carrying the
 * before and after value. Runtime configuration is deliberately NOT editable: it is
 * validated at boot from the environment, and changing it is a deployment concern.
 */
export default async function AdminSettingsPage() {
  await requirePermission('provider.view.any');
  const [canEditSettings, canEditFlags] = await Promise.all([
    hasPermission('settings.manage'),
    hasPermission('feature_flag.manage'),
  ]);

  const db = getDb();
  const [settings, flags] = await Promise.all([
    db.select().from(platformSettings).orderBy(asc(platformSettings.key)),
    db.select().from(featureFlags).orderBy(asc(featureFlags.key)),
  ]);

  const env = getEnv();

  const runtime: readonly { label: string; value: string; tone?: 'ok' | 'off' }[] = [
    { label: 'Environment', value: env.APP_ENV },
    { label: 'Log level', value: env.LOG_LEVEL },
    { label: 'AI enabled', value: isAiEnabled(env) ? 'yes' : 'no', tone: isAiEnabled(env) ? 'ok' : 'off' },
    { label: 'Intake model', value: env.OPENAI_INTAKE_MODEL ?? 'not set' },
    { label: 'Reasoning model', value: env.OPENAI_REASONING_MODEL ?? 'not set' },
    { label: 'Research model', value: env.OPENAI_RESEARCH_MODEL ?? 'not set' },
    { label: 'Summary model', value: env.OPENAI_SUMMARY_MODEL ?? 'not set' },
    { label: 'Prompt bodies stored', value: env.AI_STORE_PROMPT_BODIES ? 'yes' : 'no' },
    { label: 'Queue enabled', value: env.QUEUE_ENABLED ? 'yes' : 'no', tone: env.QUEUE_ENABLED ? 'ok' : 'off' },
    { label: 'Rate limiting', value: env.RATE_LIMIT_ENABLED ? 'on' : 'off', tone: env.RATE_LIMIT_ENABLED ? 'ok' : 'off' },
    { label: 'Mail transport', value: env.MAIL_TRANSPORT },
    { label: 'Password hashing', value: env.PASSWORD_HASH_ALGO },
    { label: 'Map provider', value: env.NEXT_PUBLIC_MAP_PROVIDER },
    { label: 'Document storage', value: env.DOCUMENT_STORAGE_DRIVER },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Settings and feature flags"
        description="Operational defaults, feature flags and the runtime configuration this process booted with. No secret value is shown here."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Operational settings"
            description="Read by the matching engine and the SLA workers on every run. Stored in the database, not in code, so a change takes effect without a deployment."
          />
<div>
            {groupByArea(settings, (setting) => setting.key, settingLabel).map((section) => (
              <section key={section.group}>
                <h3 className="border-b border-border bg-canvas-cool px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                  {section.group}
                </h3>
                <dl className="divide-y divide-border">
                  {section.rows.map((setting) => {
                    const named = settingLabel(setting.key);

                    return (
                      <div key={setting.key} className="px-5 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <dt className="text-[14px] font-medium text-text-primary">
                              {named.label}
                            </dt>
                            <dd className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                              {setting.description}
                            </dd>
                          </div>

                          {canEditSettings ? (
                            <InlineValueForm
                              action={setSettingAction}
                              fields={{ key: setting.key }}
                              name="value"
                              label=""
                              defaultValue={JSON.stringify(setting.value)}
                              submitLabel="Save"
                              hint={named.unit ?? 'JSON'}
                            />
                          ) : (
                            <span className="tabular shrink-0 rounded bg-canvas-cool px-2.5 py-1 text-[13px] font-medium text-text-primary">
                              {JSON.stringify(setting.value)}
                              {named.unit !== undefined && (
                                <span className="ml-1 font-normal text-text-secondary">
                                  {named.unit}
                                </span>
                              )}
                            </span>
                          )}
                        </div>

                        {/* The key stays visible: it is what the audit trail records. */}
                        <p className="mt-2 font-mono text-[11px] text-text-secondary/80">
                          {setting.key}
                        </p>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Feature flags" />
            <ul className="divide-y divide-border">
              {flags.map((flag) => (
                <li key={flag.key} className="flex items-start justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium text-text-primary">
                      {flagLabel(flag.key).label}
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                      {flag.description}
                    </p>
                    <p className="mt-2 font-mono text-[11px] text-text-secondary/80">{flag.key}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={flag.enabled ? 'success' : 'neutral'}>
                      {flag.enabled ? 'on' : 'off'}
                    </Badge>
                    {canEditFlags && (
                      <ActionButton
                        action={setFlagAction}
                        fields={{ key: flag.key, enabled: flag.enabled ? 'false' : 'true' }}
                        label={flag.enabled ? 'Turn off' : 'Turn on'}
                        pendingLabel="Saving…"
                        confirm={{
                          title: `${flag.enabled ? 'Turn off' : 'Turn on'} ${flagLabel(flag.key).label}?`,
                          body: flag.description,
                          confirmLabel: flag.enabled ? 'Turn off' : 'Turn on',
                        }}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Runtime configuration"
              description="Validated at boot. The process refuses to start on an invalid configuration."
            />
            <dl className="grid grid-cols-2 gap-px bg-border">
              {runtime.map((item) => (
                <div key={item.label} className="bg-surface px-4 py-2.5">
                  <dt className="text-[11px] uppercase tracking-[0.1em] text-text-secondary">
                    {item.label}
                  </dt>
                  <dd
                    className={
                      item.tone === 'off'
                        ? 'mt-0.5 text-[13px] text-text-secondary'
                        : 'mt-0.5 text-[13px] text-text-primary'
                    }
                  >
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
