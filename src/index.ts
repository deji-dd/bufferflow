import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { Elysia, t } from 'elysia';
import { SessionManager, type SimulationSession } from './core/simulation-session';

const PORT = Number(process.env.PORT || 3001);
const sessionManager = new SessionManager(PORT);

function getSession(
  headers: Record<string, string | undefined>,
  query?: Record<string, string | undefined>
): SimulationSession {
  const id = (headers['x-session-id'] || query?.session || 'default') as string;
  return sessionManager.getOrCreate(id);
}

// Setup Elysia Server
const app = new Elysia()
  .use(cors())
  .use(
    staticPlugin({
      assets: 'dist',
      prefix: '',
    })
  )

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
  .post('/api/traffic/start', ({ headers, body }) => {
    const session = getSession(headers as any);
    const customConfig = (body as any) || {};
    // "history" should clear on new test start
    session.resetRunHistory();
    return session.trafficClient.start(customConfig);
  })
  .post('/api/traffic/full-test', ({ headers, body }) => {
    const session = getSession(headers as any);
    const req = (body as any) || {};
    return session.startFullSuiteTest({
      stepDurationSec: Number(req.stepDurationSec) || 5,
      targetRps: Number(req.targetRps) || 3500,
      downstreamLatencyMs:
        req.downstreamLatencyMs !== undefined ? Number(req.downstreamLatencyMs) : undefined,
      failureRate: req.failureRate !== undefined ? Number(req.failureRate) : undefined,
      idempotencyCollisionRate:
        req.idempotencyCollisionRate !== undefined
          ? Number(req.idempotencyCollisionRate)
          : undefined,
      workerCount: req.workerCount !== undefined ? Number(req.workerCount) : undefined,
      stressLevel: req.stressLevel !== undefined ? Number(req.stressLevel) : undefined,
      runAllLevels: req.runAllLevels !== undefined ? Boolean(req.runAllLevels) : undefined,
    });
  })
  .post('/api/traffic/stop', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    const suiteResults = session.stopFullSuiteTest('stopped_by_user');
    const stopResult = session.trafficClient.stop();
    return {
      ...stopResult,
      suiteResults,
    };
  })
  .get('/api/traffic/stop', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    const suiteResults = session.stopFullSuiteTest('safety_fallback_unload');
    const stopResult = session.trafficClient.stop();
    return {
      ...stopResult,
      suiteResults,
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
    const limit = Number(query?.limit) || 50;
    const offset = Number(query?.offset) || 0;
    return session.dlq.getItems(limit, offset);
  })
  .post('/api/dlq/replay', ({ headers, body }) => {
    const session = getSession(headers as any);
    const req = (body as any) || {};
    if (req.id) {
      const success = session.dlq.replay(req.id, session.bufferQueue);
      return { success, replayedCount: success ? 1 : 0 };
    }
    const count = session.dlq.replayAll(session.bufferQueue);
    return { success: true, replayedCount: count };
  })
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
  .post('/api/config', ({ headers, body, set }) => {
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

    const newConfig = (body as any) || {};
    Object.assign(session.config, newConfig);

    if (newConfig.rateLimitPerSec || newConfig.rateLimitBurst) {
      session.rateLimiter.updateConfig(
        session.config.rateLimitPerSec,
        session.config.rateLimitBurst
      );
    }
    if (newConfig.bufferCapacity) {
      session.bufferQueue.setCapacity(session.config.bufferCapacity);
    }
    session.workerPool.updateConfig(session.config);

    // Controls should affect ops live: forward live parameters to running traffic client
    session.trafficClient.updateConfig({
      targetRps: newConfig.targetRps,
      durationSec: newConfig.durationSec,
      isUnlimited: newConfig.isUnlimited,
      schemaType: newConfig.schemaType,
      failureRate: newConfig.failureRate ?? newConfig.mockDownstreamFailureRate,
      downstreamLatencyMs: newConfig.downstreamLatencyMs ?? newConfig.mockDownstreamLatencyMs,
      idempotencyCollisionRate: newConfig.idempotencyCollisionRate,
    });

    return { success: true, config: session.config };
  })

  // Instantaneous Snapshot API
  .get('/api/metrics', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    return session.metricsCollector.tick(
      session.bufferQueue,
      session.dlq,
      session.workerPool.getWorkers(),
      session.workerPool.getRoutingStrategy(),
      session.trafficClient.isActive(),
      session.trafficClient.getConfig().targetRps
    );
  })
  .post('/api/metrics/reset', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    session.resetRunHistory();
    return { success: true };
  })

  // WebSocket for 250ms Live Telemetry Push per Session
  .ws('/ws', {
    open(ws) {
      const sessionId = ((ws.data.query as any)?.session as string) || 'default';
      const session = sessionManager.getOrCreate(sessionId);
      session.sockets.add(ws);
      (ws as any)._sessionId = sessionId;

      const initialFrame = session.metricsCollector.tick(
        session.bufferQueue,
        session.dlq,
        session.workerPool.getWorkers(),
        session.workerPool.getRoutingStrategy(),
        session.trafficClient.isActive(),
        session.trafficClient.getConfig().targetRps
      );
      initialFrame.burstProgress = session.trafficClient.getProgress();
      initialFrame.suiteProgress = session.getSuiteProgress();
      initialFrame.isServerRunningTest = session.isServerRunningSuite();
      ws.send(JSON.stringify(initialFrame));
    },
    close(ws) {
      const sessionId = (ws as any)._sessionId || 'default';
      const session = sessionManager.getOrCreate(sessionId);
      session.sockets.delete(ws);
      // Safety fallback: if no client tabs connected, stop active traffic
      if (session.sockets.size === 0 && session.trafficClient.isActive()) {
        session.trafficClient.stop();
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

  .listen(PORT);

console.log(`Bufferflow online at http://localhost:${PORT}`);
console.log(`Ingress Endpoint: POST http://localhost:${PORT}/api/ingress`);
console.log(`WebSocket Telemetry: ws://localhost:${PORT}/ws`);

export type App = typeof app;
