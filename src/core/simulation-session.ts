import { BufferQueue } from './buffer-queue';
import { DeadLetterQueue } from './dlq';
import { IdempotencyStore } from './idempotency';
import { MetricsCollector } from './metrics';
import { TokenBucketRateLimiter } from './rate-limiter';
import { TrafficClient } from './traffic-client';
import type { IngressPayload, SystemConfig } from './types';
import { WorkerPool } from './worker-pool';

const DEFAULT_CONFIG: SystemConfig = {
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

export class SimulationSession {
  public id: string;
  public config: SystemConfig;
  public rateLimiter: TokenBucketRateLimiter;
  public idempotencyStore: IdempotencyStore;
  public bufferQueue: BufferQueue;
  public dlq: DeadLetterQueue;
  public metricsCollector: MetricsCollector;
  public trafficClient: TrafficClient;
  public workerPool: WorkerPool;
  public lastActive: number = Date.now();
  public sockets: Set<any> = new Set();
  private tickTimer: any = null;

  constructor(id: string, port: number) {
    this.id = id;
    this.config = { ...DEFAULT_CONFIG };
    this.rateLimiter = new TokenBucketRateLimiter(
      this.config.rateLimitPerSec,
      this.config.rateLimitBurst
    );
    this.idempotencyStore = new IdempotencyStore(100000, 60000);
    this.bufferQueue = new BufferQueue(this.config.bufferCapacity);
    this.dlq = new DeadLetterQueue(10000);
    this.metricsCollector = new MetricsCollector();

    // High-performance in-memory dispatch handler eliminates TCP socket pool starvation
    this.trafficClient = new TrafficClient(
      `http://127.0.0.1:${port}/api/ingress`,
      id,
      (key, payload) => {
        this.handleIngress(key, payload.schemaType, payload.data || payload);
      }
    );

    this.workerPool = new WorkerPool({
      workerCount: this.config.workerCount,
      routingStrategy: this.config.routingStrategy,
      circuitFailureThreshold: this.config.circuitFailureThreshold,
      circuitRecoveryTimeMs: this.config.circuitRecoveryTimeMs,
      maxRetries: this.config.maxRetries,
      mockDownstreamLatencyMs: this.config.mockDownstreamLatencyMs,
      mockDownstreamFailureRate: this.config.mockDownstreamFailureRate,
    });

    this.workerPool.setEventProcessedCallback((_item, success) => {
      this.metricsCollector.recordJobProcessed(success);
    });

    this.workerPool.start(this.bufferQueue, this.dlq);

    // 250ms Telemetry Broadcast Loop for this session
    this.tickTimer = setInterval(() => {
      if (this.sockets.size === 0) return;
      this.lastActive = Date.now();

      const frame = this.metricsCollector.tick(
        this.bufferQueue,
        this.dlq,
        this.workerPool.getWorkers(),
        this.workerPool.getRoutingStrategy(),
        this.trafficClient.isActive(),
        this.trafficClient.getConfig().targetRps
      );

      frame.burstProgress = this.trafficClient.getProgress();

      const str = JSON.stringify(frame);
      for (const ws of this.sockets) {
        try {
          ws.send(str);
        } catch {
          this.sockets.delete(ws);
        }
      }
    }, 250);
  }

  public handleIngress(
    idempotencyKey: string,
    schemaType: string,
    data: any,
    maxRetries?: number
  ): { status: number; body: any } {
    const startTime = performance.now();

    // 1. Rate Limiting Check (<0.1ms)
    if (!this.rateLimiter.tryConsume(1)) {
      this.metricsCollector.recordIngress(Math.max(0.12, performance.now() - startTime));
      this.metricsCollector.recordRateLimited();
      return {
        status: 429,
        body: {
          error: 'Too Many Requests',
          code: 'RATE_LIMITED',
          message: 'Ingress threshold exceeded. Token bucket depleted.',
        },
      };
    }

    // 2. Idempotency Key Deduplication Check (<0.1ms)
    const { isDuplicate } = this.idempotencyStore.checkAndRecord(idempotencyKey);
    if (isDuplicate) {
      this.metricsCollector.recordIngress(Math.max(0.12, performance.now() - startTime));
      this.metricsCollector.recordDuplicate();
      return {
        status: 409,
        body: {
          error: 'Conflict: Duplicate Request',
          code: 'DUPLICATE_IDEMPOTENCY_KEY',
          idempotencyKey,
          message: 'Payload with identical Idempotency-Key previously registered.',
        },
      };
    }

    // 3. Build Enqueued Ingress Event
    const payload: IngressPayload = {
      id: `ev_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      idempotencyKey,
      enqueuedAt: Date.now(),
      schemaType: schemaType || 'generic',
      data: data || {},
      attempts: 0,
      maxAttempts: maxRetries ?? this.config.maxRetries,
    };

    // 4. Enqueue into Shock Absorber Buffer
    const enqueued = this.bufferQueue.enqueue(payload);
    const elapsedLatency = Math.max(0.12, performance.now() - startTime);
    this.metricsCollector.recordIngress(elapsedLatency);

    if (!enqueued) {
      return {
        status: 503,
        body: {
          error: 'Buffer Overflow',
          code: 'QUEUE_CAPACITY_EXCEEDED',
          message: 'Shock absorber queue buffer is at maximum capacity.',
        },
      };
    }

    this.metricsCollector.recordAccepted();
    return {
      status: 202,
      body: {
        status: 'accepted',
        id: payload.id,
        idempotencyKey: payload.idempotencyKey,
        enqueuedAt: payload.enqueuedAt,
        bufferDepth: this.bufferQueue.getDepth(),
        ingressLatencyMs: Number(elapsedLatency.toFixed(3)),
      },
    };
  }

  public touch() {
    this.lastActive = Date.now();
  }

  public destroy() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.trafficClient.stop();
    this.workerPool.stop();
    this.sockets.clear();
  }
}

export class SessionManager {
  private sessions: Map<string, SimulationSession> = new Map();
  private port: number;

  constructor(port: number) {
    this.port = port;

    // Cleanup stale sessions after 15 minutes of inactivity
    setInterval(() => {
      const cutoff = Date.now() - 15 * 60 * 1000;
      for (const [id, session] of this.sessions.entries()) {
        if (session.sockets.size === 0 && session.lastActive < cutoff) {
          session.destroy();
          this.sessions.delete(id);
        }
      }
    }, 60000);
  }

  public getOrCreate(id: string = 'default'): SimulationSession {
    const cleanId = id.trim() || 'default';
    let session = this.sessions.get(cleanId);
    if (!session) {
      session = new SimulationSession(cleanId, this.port);
      this.sessions.set(cleanId, session);
    }
    session.touch();
    return session;
  }
}
