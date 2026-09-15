import Link from 'next/link';
import { Badge, Card, CardHeader, EmptyState, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { ResearchPanel } from '@/components/ai/research-panel';
import { requirePermission } from '@/auth/context';
import { requestStatusLabel } from '@/lib/domain-labels';
import { loadRequestList } from '@/db/queries/operations';
import { isAiEnabled, getEnv } from '@/lib/config/env';
import { formatOperational } from '@/lib/time';
import type { RequestStatus } from '@/db/schema/enums';

export const dynamic = 'force-dynamic';

/**
 * The research assistant (CLAUDE.md §12, Journey F).
 *
 * The assistant answers about ONE request, because its entire knowledge is that request's
 * snapshot and decision trace. So this page is a chooser first: pick the request, then ask.
 *
 * `?request=<id>` drives it, which means a link from anywhere else in the product can open
 * the assistant already pointed at the right request — and the URL is shareable, so "ask it
 * about RQ-8841F2" is a link rather than a set of instructions.
 *
 * Read-only in every sense. The panel below posts to an action that has no tool able to
 * mutate anything, and the assistant states as much when asked to act.
 */

const STATUS_TONE: Record<RequestStatus, BadgeTone> = {
  draft: 'neutral',
  awaiting_confirmation: 'neutral',
  sent: 'info',
  sourcing: 'info',
  partial: 'warning',
  confirmed: 'success',
  in_progress: 'success',
  completed: 'neutral',
  cancelled: 'neutral',
  failed: 'danger',
};

export default async function OperationsResearchPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('request.use_research_assistant');

  const params = await searchParams;
  const requested = typeof params['request'] === 'string' ? params['request'] : null;

  const requests = await loadRequestList({});
  const selected = requested === null ? null : requests.find((row) => row.id === requested) ?? null;

  const aiOn = isAiEnabled(getEnv());

  return (
    <>
      <PageHeader
        eyebrow="Tools"
        title="Research assistant"
        description="Read-only questions about a request, answered strictly from its own decision trace. It states plainly when the platform does not hold an answer, and it cannot perform an action."
      />

      {!aiOn && (
        <Card className="mb-6 border-warning/30 bg-warning-wash">
          <div className="p-5">
            <p className="text-[13px] font-semibold text-warning">AI assistance is switched off</p>
            <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
              An administrator can switch it back on. Every decision trace is still
              readable in full on the request page — the assistant summarises it, it is not
              the source of it.
            </p>
          </div>
        </Card>
      )}

      {requests.length === 0 ? (
        <Card>
          <EmptyState
            title="No requests to ask about"
            description="The assistant answers from a request's stored trace, so there has to be a request first. Compose one from the client portal, or create one from Operations."
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <Card>
            <CardHeader
              title="Choose a request"
              description={`${String(requests.length)} request${requests.length === 1 ? '' : 's'}. The assistant only ever sees the one you pick.`}
            />
            <ul className="max-h-[560px] divide-y divide-border overflow-y-auto">
              {requests.map((row) => {
                const isSelected = row.id === selected?.id;

                return (
                  <li key={row.id}>
                    <Link
                      href={`/ops/research?request=${row.id}`}
                      aria-current={isSelected ? 'true' : undefined}
                      className={
                        isSelected
                          ? 'block bg-accent-wash px-5 py-3'
                          : 'block px-5 py-3 transition-colors hover:bg-canvas-cool'
                      }
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-text-primary">{row.reference}</span>
                        <Badge tone={STATUS_TONE[row.status]}>
                          {requestStatusLabel(row.status)}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-[12px] text-text-secondary">
                        {row.clientName} · {row.airportLabel}
                      </p>
                      <p className="tabular mt-0.5 text-[11px] text-text-secondary">
                        {row.arrivalUtc === null
                          ? 'arrival not set'
                          : `${formatOperational(row.arrivalUtc, row.airportTimezone)} local`}
                        {' · '}
                        {row.lineCount} service{row.lineCount === 1 ? '' : 's'}
                        {row.failedCount > 0 && (
                          <span className="text-danger"> · {row.failedCount} failed</span>
                        )}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="space-y-4">
            {selected === null ? (
              <Card>
                <EmptyState
                  title="Pick a request to ask about"
                  description="The assistant's whole knowledge is one request's snapshot: its flight details, every service line, every offer, and the decision trace showing which providers were rejected and why. It knows nothing else, and says so when asked."
                />
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader
                    title={selected.reference}
                    description={`${selected.clientName} · ${selected.airportLabel}`}
                    action={
                      <Link
                        href={`/ops/requests/${selected.id}`}
                        className="text-[13px] font-medium text-accent hover:underline"
                      >
                        Open the request →
                      </Link>
                    }
                  />
                </Card>

                <ResearchPanel requestId={selected.id} />

                <Card>
                  <CardHeader title="What it can answer" />
                  <ul className="space-y-1.5 px-5 pb-5 pt-1 text-[13px] text-text-secondary">
                    <li>Why was a particular provider rejected?</li>
                    <li>Why was the chosen provider preferred over the others?</li>
                    <li>Which driver or officer is committed to a service?</li>
                    <li>What is still unconfirmed on this request?</li>
                    <li>Which FBO serves this arrival?</li>
                  </ul>
                  <div className="border-t border-border px-5 py-3">
                    <p className="text-[12px] leading-relaxed text-text-secondary">
                      Ask it to book, assign, cancel or contact anyone and it will refuse and
                      say it is read-only. It has no tool that could, and it will never imply
                      an action has been taken.
                    </p>
                  </div>
                </Card>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
