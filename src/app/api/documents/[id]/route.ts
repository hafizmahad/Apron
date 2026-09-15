import { NextResponse } from 'next/server';
import { getActor } from '@/auth/context';
import { can, isOperations, isPlatformAdmin } from '@/domain/permissions';
import { loadDocumentPayload } from '@/services/documents';
import { recordAuditEvent } from '@/domain/audit';
import { ApronError } from '@/lib/errors';
import type { DocumentKind } from '@/db/schema/enums';
import { logError, logger, newCorrelationId, withCorrelation } from '@/lib/logging';

export const dynamic = 'force-dynamic';

/**
 * Document download (CLAUDE.md §19, §27).
 *
 * Documents are private. This route is the only way to reach the bytes, and it decides
 * access from the record rather than from the URL: knowing a document id proves nothing.
 *
 *  - operations and admin may read any document;
 *  - a provider user may read a document addressed to their own company, and nothing else;
 *  - a client user may read a document on their own organisation's request, and only the
 *    kinds meant for a client — a work order or an internal handling summary is not theirs
 *    to read even on their own trip.
 *
 * Every successful read is audited, because "who downloaded the manifest" is a question
 * that gets asked after the fact and must have an answer (CLAUDE.md §27).
 */

/** The only kinds a client may read, even on their own request. */
const CLIENT_READABLE: ReadonlySet<DocumentKind> = new Set<DocumentKind>([
  'client_confirmation',
  'itinerary',
  'service_confirmation',
]);

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  return withCorrelation(
    { correlationId: newCorrelationId(), route: 'api/documents' },
    async (): Promise<NextResponse> => {
      const { id } = await context.params;

      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }

      const actor = await getActor();
      if (actor === null) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      }

      try {
        const payload = await loadDocumentPayload(id);

        // A document that does not exist and one this actor may not read are the same
        // answer. Distinguishing them would confirm the id is real.
        if (payload === null || !mayRead(actor, payload)) {
          if (payload !== null) {
            logger().warn(
              { documentId: id, actorId: actor.userId, role: actor.role },
              'document download refused',
            );
          }
          return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }

        await recordAuditEvent({
          action: 'document.download',
          entityType: 'document',
          entityId: id,
          actorUserId: actor.userId,
          actorRole: actor.role,
          actorLabel: actor.userId,
          afterState: { requestId: payload.requestId },
        });

        return new NextResponse(new Uint8Array(payload.body), {
          status: 200,
          headers: {
            'content-type': payload.contentType,
            // `inline` so it opens in the browser; the filename is ours, never echoed
            // from a parameter, so there is no header-injection surface here.
            'content-disposition': `inline; filename="${safeFilename(payload.title)}.pdf"`,
            'content-length': String(payload.body.byteLength),
            // Private and uncacheable: a shared cache must never hold a client manifest.
            'cache-control': 'private, no-store, max-age=0',
            'x-content-type-options': 'nosniff',
          },
        });
      } catch (error) {
        if (error instanceof ApronError && error.code === 'not_found') {
          return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }
        logError('document download failed', error, { documentId: id });
        return NextResponse.json({ error: 'Could not read that document' }, { status: 500 });
      }
    },
  );
}

function mayRead(
  actor: NonNullable<Awaited<ReturnType<typeof getActor>>>,
  payload: {
    kind: DocumentKind;
    providerCompanyId: string | null;
    clientOrganizationId: string | null;
  },
): boolean {
  if (isPlatformAdmin(actor) || isOperations(actor)) return true;

  if (actor.providerCompanyId !== null) {
    return payload.providerCompanyId === actor.providerCompanyId;
  }

  if (actor.clientOrganizationId !== null) {
    if (payload.clientOrganizationId !== actor.clientOrganizationId) return false;
    // An allow-list, not a deny-list: a document kind added later is refused to clients
    // until somebody decides it should not be.
    return can(actor, 'request.view.own_client') && CLIENT_READABLE.has(payload.kind);
  }

  return false;
}

function safeFilename(title: string): string {
  return title.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 80).trim() || 'document';
}
