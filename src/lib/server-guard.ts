/**
 * Runtime guard for modules that must never reach the browser bundle.
 *
 * The `server-only` package cannot be used here: it resolves to a throwing module
 * outside the `react-server` condition, which would break the standalone worker process
 * that legitimately imports the same configuration, database and domain modules
 * (ADR-001). This guard is condition-independent — it fails in a browser and nowhere
 * else — and is paired with a source-boundary test that forbids client components from
 * importing server modules at all.
 */
if (typeof window !== 'undefined') {
  throw new Error(
    'A server-only Apron module was imported into client code. ' +
      'Move the import behind a server component, server action or route handler.',
  );
}

export {};
