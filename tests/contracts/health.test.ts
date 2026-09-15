import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as QueueConnection from '@/jobs/queues/connection';
import { ensureMigrated } from '../helpers/database';

/**
 * HTTP contract for `GET /api/health`.
 *
 * This route is load-bearing for the deployment, not for a user: the ALB target group and
 * the ECS container health check both read it, and `npm run smoke` gates a release on it.
 * What matters is therefore the *envelope* — status code, headers, body shape — rather
 * than any rendered output, which is why it is tested here rather than as an integration
 * suite around the database.
 *
 * The property worth defending hardest is that a degraded dependency produces **503**. A
 * health route that answers 200 while Postgres is unreachable is worse than none at all:
 * the balancer keeps sending traffic to an instance that cannot serve it, and the failure
 * surfaces to users instead of to the deployment.
 */

const control = vi.hoisted(() => ({ redisFails: false }));

// Only `checkRedisHealth` is replaced, and only while the flag is set. Everything else in
// the module — `closeRedisConnections`, which the suite teardown calls — stays real.
vi.mock('@/jobs/queues/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueConnection>();
  return {
    ...actual,
    checkRedisHealth: async (): Promise<{ latencyMs: number }> => {
      if (control.redisFails) throw new Error('connection refused');
      return actual.checkRedisHealth();
    },
  };
});

beforeAll(async () => {
  await ensureMigrated();
});

afterEach(() => {
  control.redisFails = false;
});

async function get(): Promise<Response> {
  const { GET } = await import('@/app/api/health/route');
  return GET();
}

describe('GET /api/health, healthy', () => {
  it('answers 200 with every dependency reported ok', async () => {
    const response = await get();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      service: string;
      dependencies: { database: { status: string }; redis: { status: string } };
    };

    expect(body.status).toBe('ok');
    expect(body.service).toBe('apron-web');
    expect(body.dependencies.database.status).toBe('ok');
    expect(body.dependencies.redis.status).toBe('ok');
  });

  it('is uncacheable and carries a correlation id that matches the body', async () => {
    const response = await get();
    const body = (await response.json()) as { correlationId: string };

    // A cached health response would report a state that has since changed.
    expect(response.headers.get('cache-control')).toBe('no-store');

    const header = response.headers.get('x-correlation-id');
    expect(header).toBeTruthy();
    // The same id in both places is what makes a failing probe traceable to its log line.
    expect(header).toBe(body.correlationId);
  });

  it('reports feature state without leaking any configured secret', async () => {
    const response = await get();
    const raw = await response.text();

    const parsed = JSON.parse(raw) as { features: Record<string, unknown> };
    expect(typeof parsed.features['aiEnabled']).toBe('boolean');
    expect(typeof parsed.features['queueEnabled']).toBe('boolean');
    expect(typeof parsed.features['rateLimitEnabled']).toBe('boolean');

    // The route is unauthenticated and reachable from anywhere the balancer is. Nothing
    // it returns may be a credential, and a connection string carries one.
    const sessionSecret = process.env['SESSION_SECRET'];
    if (sessionSecret !== undefined && sessionSecret !== '') {
      expect(raw).not.toContain(sessionSecret);
    }
    expect(raw).not.toContain('postgres://');
    expect(raw).not.toContain('redis://');
    expect(raw.toLowerCase()).not.toContain('password');
  });
});

describe('GET /api/health, degraded', () => {
  it('answers 503 when a dependency is unreachable', async () => {
    control.redisFails = true;

    const response = await get();
    expect(response.status).toBe(503);

    const body = (await response.json()) as {
      status: string;
      dependencies: {
        database: { status: string };
        redis: { status: string; error?: string };
      };
    };

    expect(body.status).toBe('degraded');
    expect(body.dependencies.redis.status).toBe('error');
    // Which dependency failed is the whole value of the response to whoever is paged.
    expect(body.dependencies.redis.error).toContain('connection refused');
    // The healthy one is still reported, so the answer narrows the problem.
    expect(body.dependencies.database.status).toBe('ok');
  });

  it('stays uncacheable while degraded', async () => {
    control.redisFails = true;
    const response = await get();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
