import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { AssignPanel, type AssignableOption } from '@/components/requests/assign-panel';
import { loadAcknowledgedWork, loadAssignableResources } from '@/db/queries/provider-queue';
import { can } from '@/domain/permissions';
import { ApronError } from '@/lib/errors';
import { formatOperational } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * Accepted work and resource assignment (CLAUDE.md §13).
 *
 * Two groups, because they need different things from a dispatcher:
 *  - **awaiting resources** — accepted but nothing committed yet. This is the work that
 *    will embarrass the company if it is forgotten, so it comes first.
 *  - **covered** — resources committed; shown for reference.
 */
export default async function ProviderSchedulePage() {
  const actor = await requirePermission('assignment.view.own_provider');

  if (actor.providerCompanyId === null) {
    throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
  }

  const work = await loadAcknowledgedWork(actor.providerCompanyId);
  const canAssign = can(actor, 'assignment.create');

  const awaiting = work.filter((item) => item.assignmentId === null);
  const covered = work.filter((item) => item.assignmentId !== null);

  // Options are loaded per line because each line has its own window, and what is free
  // depends entirely on that window.
  const optionsByLine = new Map<string, AssignableOption[]>();
  for (const item of awaiting) {
    const window =
      item.serviceStartUtc === null || item.serviceEndUtc === null
        ? null
        : { start: item.serviceStartUtc, end: item.serviceEndUtc };

    const options = await loadAssignableResources(
      actor.providerCompanyId,
      item.serviceCode,
      window,
    );
    optionsByLine.set(item.requestServiceLineId, [...options]);
  }

  return (
    <>
      <PageHeader
        eyebrow="Provider"
        title="Schedule"
        description="Work you have accepted. Assign the actual vehicles, drivers or officers — the platform refuses any commitment that would double-book one of them."
      />

      {work.length === 0 ? (
        <Card>
          <CardHeader title="Nothing assigned" description="Accepted work appears here." />
          <EmptyState
            title="No accepted work"
            description="Once you accept an offer from your queue, it appears here so you can commit the actual resources."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {awaiting.length > 0 && (
            <section>
              <h2 className="mb-3 text-[13px] font-semibold text-text-primary">
                Awaiting resources ({awaiting.length})
              </h2>
              <div className="space-y-4">
                {awaiting.map((item) => {
                  const window =
                    item.serviceStartUtc === null || item.serviceEndUtc === null
                      ? null
                      : `${formatOperational(item.serviceStartUtc, item.airportTimezone)} — ${formatOperational(
                          item.serviceEndUtc,
                          item.airportTimezone,
                        )} local`;

                  return (
                    <Card key={item.requestServiceLineId}>
                      <CardHeader
                        title={`${item.quantity} × ${item.unitLabel}${item.quantity === 1 ? '' : 's'} · ${item.serviceName}`}
                        description={`${item.reference} · ${item.airportLabel}`}
                        action={<Badge tone="warning">needs resources</Badge>}
                      />
                      <div className="p-5">
                        {item.serviceStartUtc === null || item.serviceEndUtc === null ? (
                          <p className="text-[13px] text-text-secondary">
                            This line has no service window yet, so resources cannot be
                            committed. Operations will confirm the timing.
                          </p>
                        ) : (
                          <AssignPanel
                            requestServiceLineId={item.requestServiceLineId}
                            reference={item.reference}
                            serviceName={item.serviceName}
                            quantity={item.quantity}
                            unitLabel={item.unitLabel}
                            startUtc={item.serviceStartUtc.toISOString()}
                            endUtc={item.serviceEndUtc.toISOString()}
                            windowLabel={window ?? ''}
                            options={optionsByLine.get(item.requestServiceLineId) ?? []}
                            canAssign={canAssign}
                          />
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}

          {covered.length > 0 && (
            <section>
              <h2 className="mb-3 text-[13px] font-semibold text-text-primary">
                Covered ({covered.length})
              </h2>
              <Card>
                <ul className="divide-y divide-border">
                  {covered.map((item) => (
                    <li
                      key={item.requestServiceLineId}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-text-primary">
                          {item.quantity} × {item.unitLabel}
                          {item.quantity === 1 ? '' : 's'} · {item.serviceName}
                        </p>
                        <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                          {item.reference} · {item.airportLabel}
                          {item.serviceStartUtc !== null &&
                            ` · ${formatOperational(item.serviceStartUtc, item.airportTimezone)} local`}
                        </p>
                      </div>
                      <Badge tone="success">
                        {item.assignedResourceCount} resource
                        {item.assignedResourceCount === 1 ? '' : 's'} committed
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}
    </>
  );
}
