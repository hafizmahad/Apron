import Link from 'next/link';
import { Button } from '@/components/ui/primitives';

/**
 * The 404 surface.
 *
 * Deliberately says nothing about whether the thing exists but is out of reach — that
 * distinction is exactly what an attacker probing URLs wants to learn (CLAUDE.md §27).
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col justify-center px-6 py-16">
      <div className="rounded-lg border border-border bg-surface p-8 shadow-card">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-secondary">
          Not found
        </p>
        <h1 className="mt-2 font-display text-2xl leading-tight text-text-primary">
          That page is not here
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-text-secondary">
          The address may be mistyped, or the page may have moved.
        </p>
        <div className="mt-6">
          <Link href="/">
            <Button>Back to start</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
