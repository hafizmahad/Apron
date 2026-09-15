'use server';

import '@/lib/server-guard';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSession } from '@/auth/context';
import { can } from '@/domain/permissions';
import { generateDocument } from '@/services/documents';
import { ApronError } from '@/lib/errors';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';

/**
 * Document generation (CLAUDE.md §19).
 *
 * Generating is an operations action. A provider does not produce its own work order, and a
 * client does not produce their own confirmation — a document is a statement the platform
 * makes about the record, so the platform decides when one is made.
 */

export interface DocumentActionResult {
  readonly status: 'ok' | 'error';
  readonly message?: string;
}

export async function generateDocumentAction(formData: FormData): Promise<DocumentActionResult> {
  return withCorrelation(
    { correlationId: newCorrelationId(), route: 'documents/generate' },
    async () => {
      try {
        const user = (await requireSession()).user;
        if (!can(user, 'request.view.any')) {
          throw new ApronError('forbidden', 'Your role cannot generate documents');
        }

        const parsed = z
          .object({
            requestId: z.string().uuid(),
            kind: z.enum(['client_confirmation', 'provider_work_order', 'handling_summary']),
            providerCompanyId: z.string().uuid().optional(),
          })
          .safeParse({
            requestId: formData.get('requestId'),
            kind: formData.get('kind'),
            providerCompanyId: emptyToUndefined(formData.get('providerCompanyId')),
          });

        if (!parsed.success) {
          return { status: 'error', message: 'Check what you asked for.' };
        }

        if (parsed.data.kind === 'provider_work_order' && parsed.data.providerCompanyId === undefined) {
          return { status: 'error', message: 'Choose which provider the work order is for.' };
        }

        const created = await generateDocument(
          {
            requestId: parsed.data.requestId,
            kind: parsed.data.kind,
            providerCompanyId: parsed.data.providerCompanyId ?? null,
          },
          { userId: user.userId, role: user.role, label: user.fullName },
        );

        revalidatePath(`/ops/requests/${parsed.data.requestId}`);
        revalidatePath('/provider');

        return {
          status: 'ok',
          message: `${created.title} generated (${String(Math.ceil(created.byteSize / 1024))} KB).`,
        };
      } catch (error) {
        logError('document generation failed', error);
        return {
          status: 'error',
          message:
            error instanceof ApronError ? error.publicMessage : 'That document could not be generated.',
        };
      }
    },
  );
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
