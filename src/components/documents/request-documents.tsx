import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { RecordForm, type RecordFieldSpec } from '@/components/ui/action-controls';
import { generateDocumentAction } from '@/app/documents/actions';
import { loadDocumentsForRequest } from '@/services/documents';
import { threadTargetsForRequest } from '@/services/messaging';
import type { DocumentKind } from '@/db/schema/enums';

/**
 * Documents attached to a request (CLAUDE.md §19).
 *
 * Documents are listed, never edited. Regenerating creates a new one rather than replacing
 * the old: the confirmation a client received on Tuesday must still be retrievable exactly
 * as they received it, even after the trip changed.
 *
 * Links go through `/api/documents/[id]`, which re-checks who may read each one. The bytes
 * are not served from a public path.
 */

const KIND_LABEL: Record<DocumentKind, string> = {
  itinerary: 'Itinerary',
  service_confirmation: 'Service confirmation',
  handling_summary: 'Handling summary',
  provider_work_order: 'Work order',
  client_confirmation: 'Client confirmation',
  operational_packet: 'Operational packet',
  upload: 'Upload',
};

export async function RequestDocuments({
  requestId,
  canGenerate,
  providerCompanyId,
}: {
  readonly requestId: string;
  readonly canGenerate: boolean;
  /** Set for a provider view, which then sees only its own documents. */
  readonly providerCompanyId?: string;
}) {
  const [rows, providers] = await Promise.all([
    loadDocumentsForRequest(
      requestId,
      providerCompanyId === undefined ? {} : { providerCompanyId },
    ),
    canGenerate ? threadTargetsForRequest(requestId) : Promise.resolve([]),
  ]);

  const fields: readonly RecordFieldSpec[] = [
    {
      name: 'kind',
      label: 'Document',
      type: 'select',
      required: true,
      defaultValue: 'client_confirmation',
      wide: true,
      options: [
        { value: 'client_confirmation', label: 'Client confirmation — what the client is getting' },
        { value: 'handling_summary', label: 'Handling summary — the full internal picture' },
        ...(providers.length > 0
          ? [{ value: 'provider_work_order', label: "Work order — one provider's own services" }]
          : []),
      ],
    },
    ...(providers.length > 0
      ? ([
          {
            name: 'providerCompanyId',
            label: 'Provider (work order only)',
            type: 'select',
            defaultValue: '',
            wide: true,
            options: [
              { value: '', label: 'not applicable' },
              ...providers.map((provider) => ({
                value: provider.providerCompanyId,
                label: provider.displayName,
              })),
            ],
            hint: "A work order contains only that provider's own services — never another company's.",
          },
        ] satisfies readonly RecordFieldSpec[])
      : []),
  ];

  return (
    <Card>
      <CardHeader
        title="Documents"
        description="Generated from the record, never written by a model. Each one is kept exactly as it was produced."
      />

      {rows.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-text-secondary">
          None generated yet.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{KIND_LABEL[row.kind]}</Badge>
                  <span className="tabular text-[11px] text-text-secondary">
                    {Math.ceil(row.byteSize / 1024)} KB
                  </span>
                </div>
                <p className="mt-1 truncate text-[13px] text-text-primary">{row.title}</p>
                <p className="tabular mt-0.5 text-[11px] text-text-secondary">
                  {row.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                </p>
              </div>
              <a
                href={`/api/documents/${row.id}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-[13px] font-medium text-accent hover:underline"
              >
                Open PDF
              </a>
            </li>
          ))}
        </ul>
      )}

      {canGenerate && (
        <div className="border-t border-border px-5 py-4">
          <RecordForm
            action={generateDocumentAction}
            fields={fields}
            hiddenFields={{ requestId }}
            trigger="Generate a document"
            title="New document"
            description="Every value is read from the request as it stands right now. Generating again produces a new document and keeps this one."
            submitLabel="Generate"
          />
        </div>
      )}
    </Card>
  );
}
