import { requirePermission } from '@/auth/context';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { OfferCard, type OfferCardData } from '@/components/requests/offer-card';
import { loadOfferQueue } from '@/db/queries/provider-queue';
import { can } from '@/domain/permissions';
import { ApronError } from '@/lib/errors';
import { formatOperational } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * The provider request queue (CLAUDE.md §13).
 *
 * Ordered by SLA deadline, soonest first — the order a dispatcher on shift actually needs.
 * Everything is scoped to the session's company by the query itself.
 */
export default async function ProviderQueuePage() {
  const actor = await requirePermission('request.view.offered_to_own_provider');

  if (actor.providerCompanyId === null) {
    throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
  }

  const offers = await loadOfferQueue(actor.providerCompanyId);
  const now = new Date();
  const canAct = can(actor, 'offer.acknowledge');

  const cards: OfferCardData[] = offers.map((offer) => ({
    offerId: offer.offerId,
    reference: offer.reference,
    serviceName: offer.serviceName,
    serviceCode: offer.serviceCode,
    quantity: offer.quantity,
    unitLabel: offer.unitLabel,
    requirementsSummary: summariseRequirements(offer.requirements),
    airportLabel: offer.airportLabel,
    fboName: offer.fboName,
    aircraftLabel: offer.aircraftLabel,
    passengerCount: offer.passengerCount,
    serviceWindowLabel:
      offer.serviceStartUtc === null || offer.serviceEndUtc === null
        ? 'not yet set'
        : `${formatOperational(offer.serviceStartUtc, offer.airportTimezone)} — ${formatOperational(
            offer.serviceEndUtc,
            offer.airportTimezone,
          )} local`,
    deadlineLabel: formatOperational(offer.expiresAt, offer.airportTimezone),
    minutesRemaining: Math.floor((offer.expiresAt.getTime() - now.getTime()) / 60_000),
    selectionReason: offer.selectionReason,
    priority: offer.priority,
    canAct,
  }));

  const critical = cards.filter((card) => card.minutesRemaining <= 10).length;

  return (
    <>
      <PageHeader
        eyebrow="Provider"
        title="Request queue"
        description="Offers waiting on you, soonest deadline first. Accepting commits your company; declining sends the request on with your reason attached."
      />

      {cards.length === 0 ? (
        <Card>
          <CardHeader
            title="Nothing waiting"
            description="Offers appear here as operations dispatches them."
          />
          <EmptyState
            title="Your queue is clear"
            description="When a request needs a service you cover at an airport you cover, and your desk is open for the window, it will arrive here with a response deadline."
          />
        </Card>
      ) : (
        <>
          {critical > 0 && (
            <div className="mb-4 rounded-md border border-danger/30 bg-danger-wash px-4 py-3 text-[13px] text-danger">
              {critical} offer{critical === 1 ? '' : 's'} with under 10 minutes remaining.
            </div>
          )}

          <div className="space-y-4">
            {cards.map((card) => (
              <OfferCard key={card.offerId} offer={card} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Turns declared requirement fields into a sentence a dispatcher can scan. */
function summariseRequirements(requirements: Record<string, unknown>): string {
  const entries = Object.entries(requirements).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );
  if (entries.length === 0) return '';

  return entries
    .map(([key, value]) => {
      const label = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
      if (typeof value === 'boolean') return value ? label : `no ${label}`;
      return `${label}: ${String(value)}`;
    })
    .join(' · ');
}
