import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { Elysia, t } from 'elysia';
import { BufferQueue } from './core/buffer-queue';
import { DeadLetterQueue } from './core/dlq';
import { IdempotencyStore } from './core/idempotency';
import { MetricsCollector } from './core/metrics';
import { TokenBucketRateLimiter } from './core/rate-limiter';
import { TrafficClient } from './core/traffic-client';
import type { IngressPayload, SystemConfig } from './core/types';
import { WorkerPool } from './core/worker-pool';

const PORT = Number(process.env.PORT || 3001);

// System Defaults
const config: SystemConfig = {
  rateLimitPerSec: 3500,
  rateLimitBurst: 6000,
  bufferCapacity: 50000,
  workerCount: 8,
  routingStrategy: 'LEAST_CONNECTIONS',
  circuitFailureThreshold: 4,
  circuitRecoveryTimeMs: 3000,
  maxRetries: 3,
  mockDownstreamLatencyMs: 12,
  mockDownstreamFailureRate: 5,
};

// Core Engine Instances
const rateLimiter = new TokenBucketRateLimiter(config.rateLimitPerSec, config.rateLimitBurst);
const idempotencyStore = new IdempotencyStore(100000, 60000);
const bufferQueue = new BufferQueue(config.bufferCapacity);
const dlq = new DeadLetterQueue(10000);
const metricsCollector = new MetricsCollector();
const trafficClient = new TrafficClient(`http://127.0.0.1:${PORT}/api/ingress`);

const workerPool = new WorkerPool({
  workerCount: config.workerCount,
  routingStrategy: config.routingStrategy,
  circuitFailureThreshold: config.circuitFailureThreshold,
  circuitRecoveryTimeMs: config.circuitRecoveryTimeMs,
  maxRetries: config.maxRetries,
  mockDownstreamLatencyMs: config.mockDownstreamLatencyMs,
  mockDownstreamFailureRate: config.mockDownstreamFailureRate,
});

// Link worker pool callbacks to metrics collector
workerPool.setEventProcessedCallback((_item, success, _workerId) => {
  metricsCollector.recordJobProcessed(success);
});

// Start worker pool processing loop
workerPool.start(bufferQueue, dlq);

// Active WebSocket subscriptions for telemetry broadcast
const telemetrySockets = new Set<any>();

// 250ms Telemetry Broadcast Loop
setInterval(() => {
  if (telemetrySockets.size === 0) return;

  const frame = metricsCollector.tick(
    bufferQueue,
    dlq,
    workerPool.getWorkers(),
    workerPool.getRoutingStrategy(),
    trafficClient.isActive(),
    trafficClient.getConfig().targetRps
  );

  const payloadStr = JSON.stringify(frame);
  for (const ws of telemetrySockets) {
    try {
      ws.send(payloadStr);
    } catch {
      telemetrySockets.delete(ws);
    }
  }
}, 250);

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
      const startTime = performance.now();

      // 1. Rate Limiting Check (<0.1ms)
      if (!rateLimiter.tryConsume(1)) {
        metricsCollector.recordIngress(performance.now() - startTime);
        metricsCollector.recordRateLimited();
        set.status = 429;
        return {
          error: 'Too Many Requests',
          code: 'RATE_LIMITED',
          message: 'Ingress threshold exceeded. Token bucket depleted.',
        };
      }

      // 2. Idempotency Key Deduplication Check (<0.1ms)
      const idempotencyKey =
        (headers['idempotency-key'] as string) ||
        `gen-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const { isDuplicate } = idempotencyStore.checkAndRecord(idempotencyKey);
      if (isDuplicate) {
        metricsCollector.recordIngress(performance.now() - startTime);
        metricsCollector.recordDuplicate();
        set.status = 409;
        return {
          error: 'Conflict: Duplicate Request',
          code: 'DUPLICATE_IDEMPOTENCY_KEY',
          idempotencyKey,
          message:
            'Payload with identical Idempotency-Key previously registered within TTL window.',
        };
      }

      // 3. Build Enqueued Ingress Event
      const incomingData = typeof body === 'object' && body !== null ? (body as any) : {};
      const payload: IngressPayload = {
        id: `ev_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        idempotencyKey,
        enqueuedAt: Date.now(),
        schemaType: incomingData.schemaType || 'generic',
        data: incomingData.data || incomingData,
        attempts: 0,
        maxAttempts: config.maxRetries,
      };

      // 4. Enqueue into Shock Absorber Buffer
      const enqueued = bufferQueue.enqueue(payload);
      const elapsedLatency = performance.now() - startTime;
      metricsCollector.recordIngress(elapsedLatency);

      if (!enqueued) {
        set.status = 503;
        return {
          error: 'Buffer Overflow',
          code: 'QUEUE_CAPACITY_EXCEEDED',
          message: 'Shock absorber queue buffer is at maximum capacity.',
        };
      }

      metricsCollector.recordAccepted();

      // 5. Immediate 202 Accepted response (<10ms)
      set.status = 202;
      return {
        status: 'accepted',
        id: payload.id,
        idempotencyKey: payload.idempotencyKey,
        enqueuedAt: payload.enqueuedAt,
        bufferDepth: bufferQueue.getDepth(),
        ingressLatencyMs: Number(elapsedLatency.toFixed(3)),
      };
    },
    {
      headers: t.Object({
        'idempotency-key': t.Optional(t.String()),
      }),
    }
  )

  // Traffic Generator API
  .post('/api/traffic/start', ({ body }) => {
    const customConfig = (body as any) || {};
    return trafficClient.start(customConfig);
  })
  .post('/api/traffic/stop', () => {
    return trafficClient.stop();
  })
  .get('/api/traffic/status', () => {
    return {
      active: trafficClient.isActive(),
      config: trafficClient.getConfig(),
    };
  })

  // Dead-Letter Queue (DLQ) Management
  .get('/api/dlq', ({ query }) => {
    const limit = Number(query.limit) || 50;
    const offset = Number(query.offset) || 0;
    return dlq.getItems(limit, offset);
  })
  .post('/api/dlq/replay', ({ body }) => {
    const req = (body as any) || {};
    if (req.id) {
      const success = dlq.replay(req.id, bufferQueue);
      return { success, replayedCount: success ? 1 : 0 };
    }
    // Replay all
    const count = dlq.replayAll(bufferQueue);
    return { success: true, replayedCount: count };
  })
  .delete('/api/dlq', () => {
    const purgedCount = dlq.purge();
    return { success: true, purgedCount };
  })

  // System Configuration API
  .get('/api/config', () => {
    return config;
  })
  .post('/api/config', ({ body }) => {
    const newConfig = (body as any) || {};
    Object.assign(config, newConfig);

    if (newConfig.rateLimitPerSec || newConfig.rateLimitBurst) {
      rateLimiter.updateConfig(config.rateLimitPerSec, config.rateLimitBurst);
    }
    if (newConfig.bufferCapacity) {
      bufferQueue.setCapacity(config.bufferCapacity);
    }
    workerPool.updateConfig(config);

    return { success: true, config };
  })

  // Instantaneous Snapshot API
  .get('/api/metrics', () => {
    return metricsCollector.tick(
      bufferQueue,
      dlq,
      workerPool.getWorkers(),
      workerPool.getRoutingStrategy(),
      trafficClient.isActive(),
      trafficClient.getConfig().targetRps
    );
  })

  // WebSocket for 250ms Live Telemetry Push
  .ws('/ws', {
    open(ws) {
      telemetrySockets.add(ws);
      // Immediately send initial frame
      const initialFrame = metricsCollector.tick(
        bufferQueue,
        dlq,
        workerPool.getWorkers(),
        workerPool.getRoutingStrategy(),
        trafficClient.isActive(),
        trafficClient.getConfig().targetRps
      );
      ws.send(JSON.stringify(initialFrame));
    },
    close(ws) {
      telemetrySockets.delete(ws);
    },
    message(ws, message) {
      // Optional client commands over WS
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
