import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { Elysia, t } from 'elysia';
import {
  getConfiguredToken,
  getMaxRequestBodyBytes,
  isAuthorized,
  isProtectedPath,
  isRequestBodyTooLarge,
} from './core/auth';
import {
  type FullSuiteStressOptions,
  SessionManager,
  type SimulationSession,
} from './core/simulation-session';
import type { ConfigPatch } from './core/types';
import { initDb } from './db';
import { historyRepository } from './db/repository';

// Initialize PostgreSQL connection with automatic fallback for dev
initDb().catch((err) => {
  console.warn(`[Bufferflow DB] Startup initialization: ${err?.message}`);
});

const PORT = Number(process.env.PORT || 3001);
const MAX_REQUEST_BODY_BYTES = getMaxRequestBodyBytes();
const sessionManager = new SessionManager(PORT);

function authInputFrom(
  headers: Record<string, string | undefined> | undefined,
  query: Record<string, string | undefined> | undefined
) {
  return {
    authorization: headers?.authorization,
    apiToken: headers?.['x-api-token'],
    queryToken: query?.token,
  };
}

const STOP_REASONS = ['stopped_by_user', 'safety_fallback_blur', 'safety_fallback_unload'] as const;
type StopReason = (typeof STOP_REASONS)[number];

function isStopReason(value: unknown): value is StopReason {
  return typeof value === 'string' && (STOP_REASONS as readonly string[]).includes(value);
}

function getSession(
  headers: Record<string, string | undefined>,
  query?: Record<string, string | undefined>
): SimulationSession {
  const id = (headers['x-session-id'] || query?.session || 'default') as string;
  return sessionManager.getOrCreate(id);
}

// Shared optional-body schema for config/start patches. Numeric bounds are
// enforced here; the session clamps again defensively when applying.
const runtimePatchFields = {
  rateLimitPerSec: t.Optional(t.Number({ minimum: 1, maximum: 1_000_000 })),
  rateLimitBurst: t.Optional(t.Number({ minimum: 1, maximum: 1_000_000 })),
  bufferCapacity: t.Optional(t.Number({ minimum: 1, maximum: 10_000_000 })),
  workerCount: t.Optional(t.Number({ minimum: 1, maximum: 64 })),
  routingStrategy: t.Optional(t.String()),
  circuitFailureThreshold: t.Optional(t.Number({ minimum: 1, maximum: 1_000_000 })),
  circuitRecoveryTimeMs: t.Optional(t.Number({ minimum: 10, maximum: 3_600_000 })),
  maxRetries: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
  maxConcurrencyPerWorker: t.Optional(t.Number({ minimum: 1, maximum: 1000 })),
  mockDownstreamLatencyMs: t.Optional(t.Number({ minimum: 0, maximum: 5000 })),
  mockDownstreamFailureRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
  targetRps: t.Optional(t.Number({ minimum: 10, maximum: 20_000 })),
  durationSec: t.Optional(t.Number({ minimum: 0, maximum: 86_400 })),
  isUnlimited: t.Optional(t.Boolean()),
  schemaType: t.Optional(t.String()),
  failureRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
  downstreamLatencyMs: t.Optional(t.Number({ minimum: 0, maximum: 5000 })),
  idempotencyCollisionRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
};

const runtimePatchSchema = t.Optional(t.Object(runtimePatchFields));

const stopReasonSchema = t.Optional(
  t.Union([
    t.Literal('stopped_by_user'),
    t.Literal('safety_fallback_blur'),
    t.Literal('safety_fallback_unload'),
  ])
);

// Setup Elysia Server
const app = new Elysia()
  .use(cors())
  .use(
    staticPlugin({
      assets: 'dist',
      prefix: '',
    })
  )

  // Shared auth + request-size guard. Auth is opt-in via BUFFERFLOW_API_TOKEN;
  // `/api/auth/status` and static assets remain public so the dashboard can
  // discover whether a token is needed.
  .onBeforeHandle(({ request, headers, query, set }) => {
    if (request.method === 'OPTIONS') return;

    const pathname = new URL(request.url).pathname;
    if (!isProtectedPath(pathname) || pathname === '/api/auth/status') return;

    if (!isAuthorized(authInputFrom(headers as any, query as any))) {
      set.status = 401;
      (set.headers as Record<string, string>)['WWW-Authenticate'] = 'Bearer';
      return {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message: 'A valid API token is required.',
      };
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (isRequestBodyTooLarge(request.headers.get('content-length'), MAX_REQUEST_BODY_BYTES)) {
        set.status = 413;
        return {
          error: 'Payload Too Large',
          code: 'BODY_TOO_LARGE',
          maxBodyBytes: MAX_REQUEST_BODY_BYTES,
        };
      }
    }
  })

  .get('/api/auth/status', () => ({ required: Boolean(getConfiguredToken()) }))

  // Serve index.html on root (built bundle or dev fallback)
  .get('/', async () => {
    const distHtml = Bun.file('dist/index.html');
    if (await distHtml.exists()) return distHtml;
    return Bun.file('ui/index.html');
  })

  // Ingress Gateway Endpoint
  .post(
    '/api/ingress',
    async ({ headers, body, set }) => {
      const session = getSession(headers);
      const idempotencyKey =
        (headers['idempotency-key'] as string) ||
        `gen-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const incomingData = typeof body === 'object' && body !== null ? (body as any) : {};
      const result = session.handleIngress(
        idempotencyKey,
        incomingData.schemaType,
        incomingData.data || incomingData,
        session.config.maxRetries
      );
      set.status = result.status;
      return result.body;
    },
    {
      headers: t.Object({
        'idempotency-key': t.Optional(t.String()),
        'x-session-id': t.Optional(t.String()),
      }),
    }
  )

  // Traffic Generator API
  .post(
    '/api/traffic/start',
    ({ headers, body, set }) => {
      const session = getSession(headers as any);
      if (session.isServerRunningSuite()) {
        set.status = 409;
        return {
          success: false,
          message: 'A full suite stress test is already running. Stop it first.',
        };
      }
      return session.startManualRun((body as ConfigPatch) || {});
    },
    { body: runtimePatchSchema }
  )
  .post(
    '/api/traffic/full-test',
    ({ headers, body, set }) => {
      const session = getSession(headers as any);
      if (session.isServerRunningSuite()) {
        set.status = 409;
        return {
          success: false,
          message: 'A full suite stress test is already running. Stop it first.',
          totalDurationSec: 0,
        };
      }
      return session.startFullSuiteTest((body as FullSuiteStressOptions) || {});
    },
    {
      body: t.Optional(
        t.Object({
          stepDurationSec: t.Optional(t.Number({ minimum: 2, maximum: 120 })),
          targetRps: t.Optional(t.Number({ minimum: 100, maximum: 20_000 })),
          downstreamLatencyMs: t.Optional(t.Number({ minimum: 0, maximum: 5000 })),
          failureRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
          idempotencyCollisionRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
          workerCount: t.Optional(t.Number({ minimum: 1, maximum: 64 })),
          stressLevel: t.Optional(t.Number({ minimum: 1, maximum: 4 })),
          runAllLevels: t.Optional(t.Boolean()),
        })
      ),
    }
  )
  .post(
    '/api/traffic/stop',
    ({ headers, body, query, set }) => {
      const session = getSession(headers as any, query as any);
      const rawReason = (body as any)?.reason ?? (query as any)?.reason;
      if (rawReason !== undefined && !isStopReason(rawReason)) {
        set.status = 400;
        return { success: false, error: 'Invalid stop reason.' };
      }
      const reason: StopReason = isStopReason(rawReason) ? rawReason : 'stopped_by_user';
      const wasSuite = session.isServerRunningSuite();
      const stoppedSuite = wasSuite ? session.stopFullSuiteTest(reason) : null;
      const stopResult = session.trafficClient.stop();
      session.scheduleNextTick();
      return {
        ...stopResult,
        suiteResults: wasSuite ? (stoppedSuite ?? session.getLastSuiteResults()) : null,
      };
    },
    {
      body: t.Optional(t.Object({ reason: stopReasonSchema })),
    }
  )
  .get('/api/traffic/stop', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    const reason: StopReason = 'safety_fallback_unload';
    const wasSuite = session.isServerRunningSuite();
    const stoppedSuite = wasSuite ? session.stopFullSuiteTest(reason) : null;
    const stopResult = session.trafficClient.stop();
    session.scheduleNextTick();
    return {
      ...stopResult,
      suiteResults: wasSuite ? (stoppedSuite ?? session.getLastSuiteResults()) : null,
    };
  })
  .get('/api/traffic/status', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    return {
      active: session.trafficClient.isActive(),
      config: session.trafficClient.getConfig(),
      isServerRunningTest: session.isServerRunningSuite(),
      suiteProgress: session.getSuiteProgress(),
      suiteResults: session.getLastSuiteResults(),
    };
  })
  .get('/api/traffic/suite-results', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    return session.getLastSuiteResults() || { error: 'No suite test results available' };
  })

  // Dead-Letter Queue (DLQ) Management
  .get('/api/dlq', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    const limit = Math.min(500, Math.max(1, Number(query?.limit) || 50));
    const offset = Math.max(0, Number(query?.offset) || 0);
    return session.dlq.getItems(limit, offset);
  })
  .post(
    '/api/dlq/replay',
    ({ headers, body }) => {
      const session = getSession(headers as any);
      const req = (body as any) || {};
      if (req.id) {
        const success = session.dlq.replay(req.id, session.bufferQueue);
        return { success, replayedCount: success ? 1 : 0 };
      }
      const count = session.dlq.replayAll(session.bufferQueue);
      return { success: count > 0, replayedCount: count };
    },
    { body: t.Optional(t.Object({ id: t.Optional(t.String()) })) }
  )
  .delete('/api/dlq', ({ headers }) => {
    const session = getSession(headers as any);
    const purgedCount = session.dlq.purge();
    return { success: true, purgedCount };
  })

  // System Configuration API
  .get('/api/config', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    return {
      ...session.config,
      isLocked: session.isServerRunningSuite(),
    };
  })
  .post(
    '/api/config',
    ({ headers, body, set }) => {
      const session = getSession(headers as any);

      // User is not able to edit settings if it's "server" doing the test
      if (session.isServerRunningSuite()) {
        set.status = 403;
        return {
          success: false,
          error: 'Settings are locked while server full suite test is in progress.',
          locked: true,
        };
      }

      const newConfig = (body as ConfigPatch) || {};
      session.applyConfigPatch(newConfig);
      return { success: true, config: session.config };
    },
    { body: runtimePatchSchema }
  )

  // Instantaneous Snapshot API (does not consume the scheduler's window)
  .get('/api/metrics', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    return session.getTelemetrySnapshot();
  })
  .post('/api/metrics/reset', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    session.resetRunHistory();
    return { success: true };
  })

  // Historical Test Run Results API (Drizzle ORM + PostgreSQL Socket IPC / Dev Fallback)
  .get('/api/history', async ({ query }) => {
    const limit = Math.min(100, Math.max(1, Number(query?.limit) || 50));
    const offset = Math.max(0, Number(query?.offset) || 0);
    return historyRepository.listRuns(limit, offset);
  })
  .get('/api/history/:id', async ({ params, set }) => {
    const run = await historyRepository.getRunById(params.id);
    if (!run) {
      set.status = 404;
      return { error: 'Test run not found' };
    }
    return run;
  })
  .post('/api/history', async ({ body }) => {
    const data = (body as any) || {};
    if (data.runId) {
      await historyRepository.saveTestRun(data);
      return { success: true, runId: data.runId };
    }
    return { success: false, error: 'Invalid run data' };
  })
  .delete('/api/history/:id', async ({ params }) => {
    const success = await historyRepository.deleteRun(params.id);
    return { success };
  })

  // WebSocket for Live Telemetry Push per Session
  .ws('/ws', {
    beforeHandle({ headers, query, set }) {
      if (!isAuthorized(authInputFrom(headers as any, query as any))) {
        set.status = 401;
        (set.headers as Record<string, string>)['WWW-Authenticate'] = 'Bearer';
        return {
          error: 'Unauthorized',
          code: 'UNAUTHORIZED',
          message: 'A valid API token is required.',
        };
      }
    },
    open(ws) {
      // Defense in depth: if the upgrade hook did not reject, never stream
      // telemetry to an unauthenticated socket.
      if (
        !isAuthorized(
          authInputFrom(
            (ws.data as any).headers as Record<string, string | undefined>,
            (ws.data as any).query as Record<string, string | undefined>
          )
        )
      ) {
        ws.close(1008, 'Unauthorized');
        return;
      }

      const sessionId = ((ws.data.query as any)?.session as string) || 'default';
      const session = sessionManager.getOrCreate(sessionId);
      session.addSocket(ws);
      (ws as any)._sessionId = sessionId;
      (ws as any)._session = session;

      // Snapshot, don't roll the window: connecting a socket must not distort
      // the scheduler's RPS measurement.
      ws.send(JSON.stringify(session.getTelemetrySnapshot()));
    },
    close(ws) {
      const session: SimulationSession =
        (ws as any)._session ?? sessionManager.getOrCreate((ws as any)._sessionId || 'default');
      session.removeSocket(ws);
      // Safety fallback: if no client tabs remain connected, stop traffic AND
      // any running suite so no orphaned timers keep compiling bogus results.
      if (session.sockets.size === 0) {
        session.stopForDisconnect('safety_fallback_unload');
      }
    },
    message(ws, message) {
      try {
        const cmd = typeof message === 'string' ? JSON.parse(message) : message;
        if (cmd?.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
        }
      } catch {
        // Ignored
      }
    },
  })

  .listen({
    port: PORT,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });

console.log(`Bufferflow online at http://localhost:${PORT}`);
console.log(`Ingress Endpoint: POST http://localhost:${PORT}/api/ingress`);
console.log(`WebSocket Telemetry: ws://localhost:${PORT}/ws`);
if (getConfiguredToken()) {
  console.log(
    `API authentication: ENABLED (bearer token; max request body ${MAX_REQUEST_BODY_BYTES} bytes)`
  );
} else {
  console.log(
    `API authentication: disabled (set BUFFERFLOW_API_TOKEN to require a bearer token; max request body ${MAX_REQUEST_BODY_BYTES} bytes)`
  );
}

export type App = typeof app;
