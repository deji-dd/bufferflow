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
    return session.trafficClient.start(customConfig);
  })
  .post('/api/traffic/stop', ({ headers }) => {
    const session = getSession(headers as any);
    return session.trafficClient.stop();
  })
  .get('/api/traffic/status', ({ headers, query }) => {
    const session = getSession(headers as any, query as any);
    return {
      active: session.trafficClient.isActive(),
      config: session.trafficClient.getConfig(),
    };
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
    return session.config;
  })
  .post('/api/config', ({ headers, body }) => {
    const session = getSession(headers as any);
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
      ws.send(JSON.stringify(initialFrame));
    },
    close(ws) {
      const sessionId = (ws as any)._sessionId || 'default';
      const session = sessionManager.getOrCreate(sessionId);
      session.sockets.delete(ws);
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

console.log(`🚀 Bufferflow Engine online at http://localhost:${PORT}`);
console.log(`📊 Ingress Endpoint: POST http://localhost:${PORT}/api/ingress`);
console.log(`📡 WebSocket Telemetry: ws://localhost:${PORT}/ws`);

export type App = typeof app;
