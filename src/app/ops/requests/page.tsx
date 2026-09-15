import Link from 'next/link';
import { requestStatusLabel } from '@/lib/domain-labels';
import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import { loadFilterOptions, loadRequestList, type RequestListRow } from '@/db/queries/operations';
import { requestStatuses, type RequestStatus } from '@/db/schema/enums';
import { formatOperational } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * The operations request list (CLAUDE.md §12).
 *
 * Filters live entirely in the URL, so a filtered view is a shareable link, survives a
 * refresh, and ships no client JavaScript. A controller can paste "everything overdue at
 * Teterboro" into a chat and the person who opens it sees exactly the same rows.
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

export default async function OperationsRequestsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('request.view.any');

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };

  const statusParam = single('status');
  const filters = {
    ...(statusParam !== undefined && requestStatuses.includes(statusParam as RequestStatus)
      ? { status: [statusParam as RequestStatus] }
      : {}),
    ...(single('airport') === undefined ? {} : { airportId: single('airport')! }),
    ...(single('client') === undefined ? {} : { clientOrganizationId: single('client')! }),
    ...(single('service') === undefined ? {} : { serviceCategoryId: single('service')! }),
    ...(single('provider') === undefined ? {} : { providerCompanyId: single('provider')! }),
    ...(single('q') === undefined ? {} : { search: single('q')! }),
    ...(single('overdue') === '1' ? { overdueOnly: true } : {}),
    ...(single('exceptions') === '1' ? { exceptionsOnly: true } : {}),
  };

  const [rows, options] = await Promise.all([loadRequestList(filters), loadFilterOptions()]);
  const now = new Date();
  const activeFilters = Object.keys(filters).length;

  const columns: readonly Column<RequestListRow>[] = [
    {
      key: 'reference',
      header: 'Request',
      numeric: true,
      render: (row) => (
        <Link
          href={`/ops/requests/${row.id}`}
          className="font-medium text-text-primary underline-offset-4 hover:underline"
        >
          {row.reference}
        </Link>
      ),
    },
    {
      key: 'client',
      header: 'Client',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-text-primary">{row.clientName}</p>
          {row.providerNames !== '' && (
            <p className="mt-0.5 truncate text-[12px] text-text-secondary">{row.providerNames}</p>
          )}
        </div>
      ),
    },
    {
      key: 'where',
      header: 'Airport',
      numeric: true,
      render: (row) => (
        <div>
          <p>{row.airportLabel}</p>
          {row.fboName !== null && (
            <p className="mt-0.5 text-[12px] text-text-secondary">{row.fboName}</p>
          )}
        </div>
      ),
    },
    {
      key: 'arrival',
      header: 'Arrival (local)',
      numeric: true,
      render: (row) =>
        row.arrivalUtc === null ? (
          <span className="text-text-secondary/70 italic">not set</span>
        ) : (
          formatOperational(row.arrivalUtc, row.airportTimezone)
        ),
    },
    {
      key: 'coverage',
      header: 'Services',
      align: 'center',
      render: (row) => (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <Badge tone={row.failedCount > 0 ? 'danger' : row.coveredCount === row.lineCount && row.lineCount > 0 ? 'success' : row.coveredCount > 0 ? 'warning' : 'neutral'}>
            {row.coveredCount}/{row.lineCount}
          </Badge>
          {row.awaitingCount > 0 && <Badge tone="info">{row.awaitingCount} waiting</Badge>}
          {row.failedCount > 0 && <Badge tone="danger">{row.failedCount} failed</Badge>}
        </div>
      ),
    },
    {
      key: 'deadline',
      header: 'Next deadline',
      numeric: true,
      secondary: true,
      render: (row) => {
        if (row.nextDeadlineUtc === null) return <span className="text-text-secondary/60">—</span>;
        const minutes = Math.round((row.nextDeadlineUtc.getTime() - now.getTime()) / 60_000);
        return (
          <span className={minutes <= 0 ? 'font-medium text-danger' : minutes <= 15 ? 'text-warning' : ''}>
            {minutes <= 0 ? `${Math.abs(minutes)} min over` : `${minutes} min`}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={STATUS_TONE[row.status]}>{requestStatusLabel(row.status)}</Badge>,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Requests"
        description="Every request, soonest arrival first. Filters are held in the URL, so a filtered view can be shared as a link."
      />

      <Card className="mb-4">
        <CardHeader title="Filter" description="Applied server-side; the list below updates on submit." />
        <form method="get" className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search" name="q" defaultValue={single('q') ?? ''} placeholder="RQ-…, client, airport" />

          <Select label="Status" name="status" defaultValue={single('status') ?? ''}>
            <option value="">Any status</option>
            {requestStatuses.map((status) => (
              <option key={status} value={status}>
                {requestStatusLabel(status)}
              </option>
            ))}
          </Select>

          <Select label="Airport" name="airport" defaultValue={single('airport') ?? ''}>
            <option value="">Any airport</option>
            {options.airports.map((airport) => (
              <option key={airport.id} value={airport.id}>
                {airport.icao ?? airport.name}
              </option>
            ))}
          </Select>

          <Select label="Client" name="client" defaultValue={single('client') ?? ''}>
            <option value="">Any client</option>
            {options.clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </Select>

          <Select label="Service" name="service" defaultValue={single('service') ?? ''}>
            <option value="">Any service</option>
            {options.services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </Select>

          <Select label="Provider" name="provider" defaultValue={single('provider') ?? ''}>
            <option value="">Any provider</option>
            {options.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>

          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 text-[13px] text-text-primary">
              <input
                type="checkbox"
                name="overdue"
                value="1"
                defaultChecked={single('overdue') === '1'}
                className="size-4 accent-[var(--color-accent)]"
              />
              Overdue only
            </label>
            <label className="flex items-center gap-2 text-[13px] text-text-primary">
              <input
                type="checkbox"
                name="exceptions"
                value="1"
                defaultChecked={single('exceptions') === '1'}
                className="size-4 accent-[var(--color-accent)]"
              />
              Exceptions
            </label>
          </div>

          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-strong"
            >
              Apply
            </button>
            {activeFilters > 0 && (
              <Link
                href="/ops/requests"
                className="h-10 rounded-md border border-border-strong px-4 text-sm font-medium leading-10 text-text-secondary transition-colors hover:bg-canvas-cool"
              >
                Clear
              </Link>
            )}
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title={`${rows.length} request${rows.length === 1 ? '' : 's'}`}
          description={activeFilters > 0 ? `${activeFilters} filter${activeFilters === 1 ? '' : 's'} applied.` : undefined}
        />
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyTitle={activeFilters > 0 ? 'No requests match these filters' : 'No requests yet'}
          emptyDescription={
            activeFilters > 0
              ? 'Clear the filters to see everything, or widen the date range.'
              : 'Requests appear here once a client or an operations user confirms one.'
          }
          caption="Requests"
        />
      </Card>
    </>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
}: {
  readonly label: string;
  readonly name: string;
  readonly defaultValue: string;
  readonly placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-[12px] font-medium text-text-secondary">
        {label}
      </label>
      <input
        id={name}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="mt-1 block h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
      />
    </div>
  );
}

function Select({
  label,
  name,
  defaultValue,
  children,
}: {
  readonly label: string;
  readonly name: string;
  readonly defaultValue: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-[12px] font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
        className="mt-1 block h-10 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
      >
        {children}
      </select>
    </div>
  );
}
