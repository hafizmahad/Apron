import { desc, sql } from 'drizzle-orm';
import { aiErrorLabel, aiOutcomeLabel, aiStageLabel } from '@/lib/domain-labels';
import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { DataTable, PendingSurface, type Column } from '@/components/ui/data-table';
import { getDb } from '@/db/client';
import { aiCalls } from '@/db/schema';
import type { AiOutcome, AiStage } from '@/db/schema/enums';
import { getEnv, isAiEnabled } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

/**
 * AI reliability (CLAUDE.md §14 as amended, ADR-015).
 *
 * RELIABILITY ONLY. There is deliberately no token count and no cost figure anywhere on
 * this page or in the table behind it — cost tracking is out of scope for this product.
 *
 * What matters here is whether the model is helping or quietly failing: how often calls
 * succeed, how often the deterministic fallback ran, how often a model answer failed code
 * verification, and what the latency looks like.
 */

const OUTCOME_TONE: Record<AiOutcome, BadgeTone> = {
  success: 'success',
  schema_invalid: 'warning',
  verification_failed: 'warning',
  timeout: 'warning',
  refused: 'neutral',
  unavailable: 'danger',
  error: 'danger',
};

interface CallRow {
  readonly id: number;
  readonly occurredAt: Date;
  readonly stage: AiStage;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly outcome: AiOutcome;
  readonly verificationStatus: string | null;
  readonly errorCategory: string | null;
  readonly errorDetail: string | null;
}

export default async function AdminAiPage() {
  await requirePermission('ai.view_observability');

  const db = getDb();
  const env = getEnv();

  const [summary] = await db
    .select({
      total: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${aiCalls.outcome} = 'success')::int`,
      schemaFailures: sql<number>`count(*) filter (where ${aiCalls.outcome} = 'schema_invalid')::int`,
      verificationFailures: sql<number>`count(*) filter (where ${aiCalls.verificationStatus} = 'rejected')::int`,
      unavailable: sql<number>`count(*) filter (where ${aiCalls.outcome} in ('unavailable','timeout'))::int`,
      p50: sql<number>`coalesce(percentile_disc(0.5) within group (order by ${aiCalls.latencyMs}), 0)::int`,
      p95: sql<number>`coalesce(percentile_disc(0.95) within group (order by ${aiCalls.latencyMs}), 0)::int`,
    })
    .from(aiCalls);

  const byStage = await db
    .select({
      stage: aiCalls.stage,
      total: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${aiCalls.outcome} = 'success')::int`,
      p50: sql<number>`coalesce(percentile_disc(0.5) within group (order by ${aiCalls.latencyMs}), 0)::int`,
    })
    .from(aiCalls)
    .groupBy(aiCalls.stage)
    .orderBy(aiCalls.stage);

  const topErrors = await db
    .select({
      category: aiCalls.errorCategory,
      count: sql<number>`count(*)::int`,
    })
    .from(aiCalls)
    .where(sql`${aiCalls.errorCategory} is not null`)
    .groupBy(aiCalls.errorCategory)
    .orderBy(sql`count(*) desc`)
    .limit(8);

  const recent = await db
    .select({
      id: aiCalls.id,
      occurredAt: aiCalls.occurredAt,
      stage: aiCalls.stage,
      promptId: aiCalls.promptId,
      promptVersion: aiCalls.promptVersion,
      model: aiCalls.model,
      latencyMs: aiCalls.latencyMs,
      outcome: aiCalls.outcome,
      verificationStatus: aiCalls.verificationStatus,
      errorCategory: aiCalls.errorCategory,
      errorDetail: aiCalls.errorDetail,
    })
    .from(aiCalls)
    .orderBy(desc(aiCalls.occurredAt), desc(aiCalls.id))
    .limit(100);

  const total = summary?.total ?? 0;
  const rate = (value: number): string =>
    total === 0 ? '—' : `${Math.round((value / total) * 100)}%`;

  const columns: readonly Column<CallRow>[] = [
    {
      key: 'when',
      header: 'When (UTC)',
      numeric: true,
      render: (row) => row.occurredAt.toISOString().slice(0, 19).replace('T', ' '),
    },
    { key: 'stage', header: 'Stage', render: (row) => <Badge tone="info">{aiStageLabel(row.stage)}</Badge> },
    {
      key: 'prompt',
      header: 'Prompt',
      render: (row) => (
        <span className="font-mono text-[12px]">
          {row.promptId}
          <span className="ml-1.5 text-text-secondary">v{row.promptVersion}</span>
        </span>
      ),
    },
    { key: 'model', header: 'Model', secondary: true, render: (row) => row.model },
    {
      key: 'latency',
      header: 'Latency',
      numeric: true,
      align: 'right',
      render: (row) => `${row.latencyMs} ms`,
    },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (row) => (
        <div>
          <Badge tone={OUTCOME_TONE[row.outcome]}>{aiOutcomeLabel(row.outcome)}</Badge>
          {row.verificationStatus !== null && (
            <p className="mt-1 text-[11px] text-text-secondary">
              verification: {row.verificationStatus}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'detail',
      header: 'Detail',
      secondary: true,
      render: (row) =>
        row.errorDetail === null ? (
          <span className="text-text-secondary/60">—</span>
        ) : (
          <span className="text-[12px] text-text-secondary">{row.errorDetail.slice(0, 120)}</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Observability"
        title="AI reliability"
        description="Whether the model is helping or quietly failing. Token accounting and cost estimation are deliberately out of scope for this product (ADR-015)."
        actions={
          <Badge tone={isAiEnabled(env) ? 'success' : 'neutral'}>
            {isAiEnabled(env) ? 'AI enabled' : 'AI disabled'}
          </Badge>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {[
          { label: 'Calls recorded', value: String(total) },
          { label: 'Success rate', value: rate(summary?.succeeded ?? 0) },
          { label: 'Schema failures', value: rate(summary?.schemaFailures ?? 0) },
          { label: 'Verification rejected', value: rate(summary?.verificationFailures ?? 0) },
          { label: 'Median latency', value: total === 0 ? '—' : `${summary?.p50 ?? 0} ms` },
          { label: '95th latency', value: total === 0 ? '—' : `${summary?.p95 ?? 0} ms` },
        ].map((metric) => (
          <Card key={metric.label} className="p-4">
            <p className="text-[11px] uppercase tracking-[0.1em] text-text-secondary">
              {metric.label}
            </p>
            <p className="tabular mt-1 text-xl text-text-primary">{metric.value}</p>
          </Card>
        ))}
      </div>

      {total === 0 ? (
        <PendingSurface
          title="No model calls recorded yet"
          description="Every production call is recorded here — successes and failures alike — as soon as intake or matching runs. The failure paths are recorded too, so an outage cannot pass unnoticed."
          dependsOn="a model call to have been made"
          liveNow={[
            'The adapter, its typed failure results and the ai_calls table are in place.',
            'Prompts are versioned source files with their own tests.',
            'With AI unavailable, intake falls back to a deterministic pass and says so.',
          ]}
        />
      ) : (
        <>
          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="By stage" />
              <ul className="divide-y divide-border">
                {byStage.map((row) => (
                  <li key={row.stage} className="flex items-center justify-between px-5 py-3">
                    <span className="text-[13px] text-text-primary">{aiStageLabel(row.stage)}</span>
                    <span className="tabular text-[13px] text-text-secondary">
                      {row.succeeded}/{row.total} ok · {row.p50} ms median
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Top error categories" />
              {topErrors.length === 0 ? (
                <p className="px-5 py-4 text-[13px] text-text-secondary">No failures recorded.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {topErrors.map((row) => (
                    <li
                      key={row.category ?? 'unknown'}
                      className="flex items-center justify-between px-5 py-3"
                    >
                      <span className="text-[13px] text-text-primary">{aiErrorLabel(row.category)}</span>
                      <span className="tabular text-[13px] text-text-secondary">{row.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <CardHeader title="Recent calls" description="Newest first, most recent 100." />
            <DataTable
              columns={columns}
              rows={recent}
              rowKey={(row) => String(row.id)}
              emptyTitle="No calls"
              emptyDescription="Model calls appear here as they happen."
              caption="Recent AI calls"
            />
          </Card>
        </>
      )}
    </>
  );
}
