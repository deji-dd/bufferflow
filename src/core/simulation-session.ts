import { historyRepository } from '../db/repository';
import { BufferQueue } from './buffer-queue';
import { DeadLetterQueue } from './dlq';
import { IdempotencyStore } from './idempotency';
import { computePercentiles, MetricsCollector } from './metrics';
import { TokenBucketRateLimiter } from './rate-limiter';
import { TrafficClient } from './traffic-client';
import type {
  ConfigPatch,
  FullSuiteResults,
  IngressPayload,
  RoutingStrategy,
  StrategyBenchmark,
  SuiteProgress,
  SystemConfig,
  TelemetryFrame,
  TrafficConfig,
} from './types';
import { isRoutingStrategy } from './types';
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
  maxConcurrencyPerWorker: 25,
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const SUITE_STRATEGIES: RoutingStrategy[] = [
  'LEAST_CONNECTIONS',
  'WEIGHTED_ROUND_ROBIN',
  'ROUND_ROBIN',
  'POWER_OF_TWO_CHOICES',
  'WEIGHTED_LEAST_CONNECTIONS',
  'RANDOM',
  'CONSISTENT_HASH',
];

export const SUITE_LEVEL_CONFIGS: Record<
  number,
  {
    targetRps: number;
    downstreamLatencyMs: number;
    failureRate: number;
    title: string;
  }
> = {
  1: { targetRps: 2500, downstreamLatencyMs: 15, failureRate: 5, title: 'Level 1: Moderate' },
  2: { targetRps: 4200, downstreamLatencyMs: 40, failureRate: 12, title: 'Level 2: High Pressure' },
  3: {
    targetRps: 5800,
    downstreamLatencyMs: 65,
    failureRate: 20,
    title: 'Level 3: Extreme Stress',
  },
  4: {
    targetRps: 7500,
    downstreamLatencyMs: 95,
    failureRate: 28,
    title: 'Level 4: Catastrophic Surge',
  },
};

export interface FullSuiteStressOptions {
  stepDurationSec?: number;
  targetRps?: number;
  downstreamLatencyMs?: number;
  failureRate?: number;
  idempotencyCollisionRate?: number;
  workerCount?: number;
  stressLevel?: number;
  runAllLevels?: boolean;
}

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

  // Server-managed Full Suite Stress Test state
  private isSuiteRunning: boolean = false;
  private isMultiLevelRun: boolean = false;
  private suiteCurrentLevelIndex: number = 0;
  private suiteStrategyIndexInLevel: number = 0;
  private suiteStepTimer: any = null;
  private suiteStartTime: number = 0;
  private suiteStepDurationSec: number = 5;
  private suiteTargetRps: number = 2500;
  private suitePeakIncomingRps: number = 0;
  private suitePeakAcceptedRps: number = 0;
  private suitePeakDrainedRps: number = 0;
  private suiteStepBaseline = {
    ingressed: 0,
    accepted: 0,
    processed: 0,
    failed: 0,
    timestamp: 0,
    workerProcessed: new Map<string, number>(),
  };
  private suiteStrategyBreakdown: Record<string, StrategyBenchmark> = {};
  private suiteLevelBreakdowns: Record<number, Record<string, StrategyBenchmark>> = {};
  private suiteStrategyLatencies: Map<string, number[]> = new Map();
  public lastCompletedSuiteResults: FullSuiteResults | null = null;

  // Snapshot taken when a suite starts, restored when it ends so a completed
  // benchmark never contaminates the next manual run.
  private preSuiteConfig: SystemConfig | null = null;
  private preSuiteTrafficConfig: TrafficConfig | null = null;
  private suiteGeneration: number = 0;

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
      maxConcurrencyPerWorker: this.config.maxConcurrencyPerWorker,
    });

    this.workerPool.setEventProcessedCallback((item, success) => {
      const now = Date.now();
      const latencyMs = item?.enqueuedAt
        ? Math.max(0.5, now - item.enqueuedAt)
        : this.config.mockDownstreamLatencyMs;

      this.metricsCollector.recordJobProcessed(success, latencyMs);

      if (this.isSuiteRunning) {
        const currentStrat = SUITE_STRATEGIES[this.suiteStrategyIndexInLevel];
        const currentLevel = this.isMultiLevelRun ? this.suiteCurrentLevelIndex + 1 : 1;
        if (currentStrat) {
          const latencyKey = `${currentLevel}_${currentStrat}`;
          let list = this.suiteStrategyLatencies.get(latencyKey);
          if (!list) {
            list = [];
            this.suiteStrategyLatencies.set(latencyKey, list);
          }
          if (list.length < 2000) {
            list.push(latencyMs);
          } else {
            list[Math.floor(Math.random() * 2000)] = latencyMs;
          }
        }
      }
    });

    this.workerPool.start(this.bufferQueue, this.dlq);
  }

  public addSocket(ws: any): void {
    this.sockets.add(ws);
    this.touch();
    this.scheduleNextTick();
  }

  public removeSocket(ws: any): void {
    this.sockets.delete(ws);
    // The scheduler decides whether ticking should continue (it may still be
    // needed for an API-only run or a running suite).
    this.scheduleNextTick();
  }

  public scheduleNextTick(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    const isBusy =
      this.trafficClient.isActive() ||
      this.isSuiteRunning ||
      this.bufferQueue.getDepth() > 0 ||
      this.workerPool.getActiveJobCount() > 0;

    // Keep sampling while work is happening even without a browser connected,
    // so suite peaks and /api/metrics are accurate for API-only runs.
    if (this.sockets.size === 0 && !isBusy) return;

    const delay = isBusy ? 250 : 1000;

    this.tickTimer = setTimeout(() => {
      this.broadcastTelemetry();
      this.scheduleNextTick();
    }, delay);
  }

  /**
   * Builds the current frame without rolling the metrics window. Used by the
   * initial WebSocket frame and by GET /api/metrics so they cannot distort the
   * scheduler's 250ms measurements.
   */
  public getTelemetrySnapshot(): TelemetryFrame {
    const frame = this.metricsCollector.snapshot(
      this.bufferQueue,
      this.dlq,
      this.workerPool.getWorkers(),
      this.workerPool.getRoutingStrategy(),
      this.trafficClient.isActive(),
      this.trafficClient.getConfig().targetRps,
      this.workerPool.getMaxConcurrencyPerWorker()
    );

    frame.burstProgress = this.trafficClient.getProgress();
    frame.suiteProgress = this.getSuiteProgress();
    frame.isServerRunningTest = this.isSuiteRunning;
    return frame;
  }

  public broadcastTelemetry(): void {
    this.lastActive = Date.now();

    // The scheduler is the single owner of window rollover.
    const frame = this.metricsCollector.tick(
      this.bufferQueue,
      this.dlq,
      this.workerPool.getWorkers(),
      this.workerPool.getRoutingStrategy(),
      this.trafficClient.isActive(),
      this.trafficClient.getConfig().targetRps,
      this.workerPool.getMaxConcurrencyPerWorker()
    );

    if (this.isSuiteRunning) {
      this.suitePeakIncomingRps = Math.max(this.suitePeakIncomingRps, frame.metrics.incomingRps);
      this.suitePeakAcceptedRps = Math.max(this.suitePeakAcceptedRps, frame.metrics.acceptedRps);
      this.suitePeakDrainedRps = Math.max(this.suitePeakDrainedRps, frame.metrics.drainedRps);
    }

    frame.burstProgress = this.trafficClient.getProgress();
    frame.suiteProgress = this.getSuiteProgress();
    frame.isServerRunningTest = this.isSuiteRunning;
    // Suite results are deliberately NOT broadcast every frame; the client
    // fetches them on demand when a run completes.

    if (this.sockets.size > 0) {
      const str = JSON.stringify(frame);
      for (const ws of this.sockets) {
        try {
          ws.send(str);
        } catch {
          this.sockets.delete(ws);
        }
      }
    }
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
      const elapsed = Number(Math.max(0.01, performance.now() - startTime).toFixed(3));
      this.metricsCollector.recordIngress(elapsed);
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
      const elapsed = Number(Math.max(0.01, performance.now() - startTime).toFixed(3));
      this.metricsCollector.recordIngress(elapsed);
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
    const elapsedLatency = Number(Math.max(0.01, performance.now() - startTime).toFixed(3));
    this.metricsCollector.recordIngress(elapsedLatency);

    if (!enqueued) {
      // Roll back the idempotency record: the request was rejected with 503, so
      // the client must be able to retry with the same Idempotency-Key later.
      this.idempotencyStore.remove(idempotencyKey);
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

  /**
   * Applies a validated runtime patch. Only defined fields are touched; numeric
   * values are clamped and unknown routing strategies are ignored. Returns the
   * effective system config.
   */
  public applyConfigPatch(patch: ConfigPatch = {}): SystemConfig {
    const next = this.config;
    const trafficPatch: Partial<TrafficConfig> = {};

    let ratesChanged = false;
    let bufferChanged = false;

    if (isFiniteNumber(patch.rateLimitPerSec)) {
      next.rateLimitPerSec = clampNumber(patch.rateLimitPerSec, 1, 1_000_000);
      ratesChanged = true;
    }
    if (isFiniteNumber(patch.rateLimitBurst)) {
      next.rateLimitBurst = clampNumber(patch.rateLimitBurst, 1, 1_000_000);
      ratesChanged = true;
    }
    if (isFiniteNumber(patch.bufferCapacity)) {
      next.bufferCapacity = clampNumber(patch.bufferCapacity, 1, 10_000_000);
      bufferChanged = true;
    }
    if (isFiniteNumber(patch.workerCount)) {
      next.workerCount = clampNumber(patch.workerCount, 1, 64);
    }
    if (isRoutingStrategy(patch.routingStrategy)) {
      next.routingStrategy = patch.routingStrategy;
    }
    if (isFiniteNumber(patch.circuitFailureThreshold)) {
      next.circuitFailureThreshold = clampNumber(patch.circuitFailureThreshold, 1, 1_000_000);
    }
    if (isFiniteNumber(patch.circuitRecoveryTimeMs)) {
      next.circuitRecoveryTimeMs = clampNumber(patch.circuitRecoveryTimeMs, 10, 3_600_000);
    }
    if (isFiniteNumber(patch.maxRetries)) {
      next.maxRetries = clampNumber(patch.maxRetries, 1, 10);
    }
    if (isFiniteNumber(patch.maxConcurrencyPerWorker)) {
      next.maxConcurrencyPerWorker = clampNumber(patch.maxConcurrencyPerWorker, 1, 1000);
    }

    // `failureRate`/`downstreamLatencyMs` are the traffic-generator names;
    // `mockDownstream*` are the system-config names. Accept both.
    const effectiveFailure =
      patch.failureRate !== undefined ? patch.failureRate : patch.mockDownstreamFailureRate;
    if (isFiniteNumber(effectiveFailure)) {
      const clamped = clampNumber(effectiveFailure, 0, 100);
      next.mockDownstreamFailureRate = clamped;
      trafficPatch.failureRate = clamped;
    }

    const effectiveLatency =
      patch.downstreamLatencyMs !== undefined
        ? patch.downstreamLatencyMs
        : patch.mockDownstreamLatencyMs;
    if (isFiniteNumber(effectiveLatency)) {
      const clamped = clampNumber(effectiveLatency, 0, 5000);
      next.mockDownstreamLatencyMs = clamped;
      trafficPatch.downstreamLatencyMs = clamped;
    }

    if (isFiniteNumber(patch.targetRps)) {
      trafficPatch.targetRps = clampNumber(patch.targetRps, 10, 20_000);
    }
    if (isFiniteNumber(patch.durationSec)) {
      trafficPatch.durationSec = clampNumber(patch.durationSec, 0, 86_400);
    }
    if (typeof patch.isUnlimited === 'boolean') {
      trafficPatch.isUnlimited = patch.isUnlimited;
    }
    if (typeof patch.schemaType === 'string' && patch.schemaType.trim()) {
      trafficPatch.schemaType = patch.schemaType.trim();
    }
    if (isFiniteNumber(patch.idempotencyCollisionRate)) {
      trafficPatch.idempotencyCollisionRate = clampNumber(patch.idempotencyCollisionRate, 0, 100);
    }

    if (ratesChanged) {
      this.rateLimiter.updateConfig(next.rateLimitPerSec, next.rateLimitBurst);
    }
    if (bufferChanged) {
      this.bufferQueue.setCapacity(next.bufferCapacity);
    }

    this.workerPool.updateConfig({
      workerCount: next.workerCount,
      routingStrategy: next.routingStrategy,
      circuitFailureThreshold: next.circuitFailureThreshold,
      circuitRecoveryTimeMs: next.circuitRecoveryTimeMs,
      maxRetries: next.maxRetries,
      mockDownstreamLatencyMs: next.mockDownstreamLatencyMs,
      mockDownstreamFailureRate: next.mockDownstreamFailureRate,
      maxConcurrencyPerWorker: next.maxConcurrencyPerWorker,
    });

    if (Object.keys(trafficPatch).length > 0) {
      this.trafficClient.updateConfig(trafficPatch);
    }

    return { ...next };
  }

  /**
   * Starts a manual load run, applying the requested runtime config first so
   * the dashboard's failure/latency/worker/strategy controls take effect on
   * start (not only when a slider is moved).
   */
  public startManualRun(config: ConfigPatch = {}): { success: boolean; message: string } {
    if (this.isSuiteRunning) {
      return {
        success: false,
        message: 'A full suite stress test is already running. Stop it first.',
      };
    }

    this.applyConfigPatch(config);
    this.resetRunHistory();
    this.clearLastSuiteResults();
    const result = this.trafficClient.start({});
    this.scheduleNextTick();
    return result;
  }

  public clearLastSuiteResults(): void {
    this.lastCompletedSuiteResults = null;
  }

  /**
   * Restores the config snapshot captured before a suite started, so an
   * automated benchmark cannot leak Level 4 latency/failure settings into the
   * next manual run.
   */
  private restorePreSuiteConfig(): void {
    const snapshot = this.preSuiteConfig;
    const trafficSnapshot = this.preSuiteTrafficConfig;
    this.preSuiteConfig = null;
    this.preSuiteTrafficConfig = null;
    if (!snapshot) return;

    Object.assign(this.config, snapshot);
    this.rateLimiter.updateConfig(snapshot.rateLimitPerSec, snapshot.rateLimitBurst);
    this.bufferQueue.setCapacity(snapshot.bufferCapacity);
    this.workerPool.updateConfig({
      workerCount: snapshot.workerCount,
      routingStrategy: snapshot.routingStrategy,
      circuitFailureThreshold: snapshot.circuitFailureThreshold,
      circuitRecoveryTimeMs: snapshot.circuitRecoveryTimeMs,
      maxRetries: snapshot.maxRetries,
      mockDownstreamLatencyMs: snapshot.mockDownstreamLatencyMs,
      mockDownstreamFailureRate: snapshot.mockDownstreamFailureRate,
      maxConcurrencyPerWorker: snapshot.maxConcurrencyPerWorker,
    });
    if (trafficSnapshot) {
      this.trafficClient.updateConfig(trafficSnapshot);
    }
  }

  public startFullSuiteTest(
    options: number | FullSuiteStressOptions = 5,
    legacyTargetRps = 2500
  ): {
    success: boolean;
    message: string;
    totalDurationSec: number;
  } {
    this.stopFullSuiteTest();
    this.resetRunHistory();

    // Snapshot the user's config before the suite mutates latency/failure/
    // worker settings per level, so it can be restored afterwards.
    this.preSuiteConfig = { ...this.config };
    this.preSuiteTrafficConfig = this.trafficClient.getConfig();
    this.suiteGeneration++;
    const suiteGeneration = this.suiteGeneration;

    const isObject = typeof options === 'object' && options !== null;
    const runAllLevels = isObject && !!options.runAllLevels;
    this.isMultiLevelRun = runAllLevels;
    this.suiteCurrentLevelIndex = 0;
    this.suiteStrategyIndexInLevel = 0;
    this.suiteLevelBreakdowns = { 1: {}, 2: {}, 3: {}, 4: {} };

    let stepDurationSec = 5;
    let targetRps = 2500;
    let downstreamLatencyMs = this.config.mockDownstreamLatencyMs;
    let failureRate = this.config.mockDownstreamFailureRate;
    let idempotencyCollisionRate = 3;
    let workerCount = this.config.workerCount;

    if (typeof options === 'number') {
      stepDurationSec = Math.max(2, options);
      targetRps = Math.max(500, legacyTargetRps);
    } else if (isObject) {
      stepDurationSec = Math.max(2, options.stepDurationSec ?? (runAllLevels ? 3 : 5));

      if (runAllLevels) {
        const lvl1 = SUITE_LEVEL_CONFIGS[1];
        targetRps = lvl1.targetRps;
        downstreamLatencyMs = lvl1.downstreamLatencyMs;
        failureRate = lvl1.failureRate;
      } else {
        const chosenLevel = options.stressLevel ?? 2;
        const lvlConfig = SUITE_LEVEL_CONFIGS[chosenLevel] || SUITE_LEVEL_CONFIGS[2];
        targetRps = options.targetRps ?? lvlConfig.targetRps;
        downstreamLatencyMs = options.downstreamLatencyMs ?? lvlConfig.downstreamLatencyMs;
        failureRate = options.failureRate ?? lvlConfig.failureRate;
      }

      if (options.idempotencyCollisionRate !== undefined) {
        idempotencyCollisionRate = options.idempotencyCollisionRate;
      }
      if (options.workerCount !== undefined) {
        workerCount = options.workerCount;
      }
    }

    // Apply stress test parameters to session and worker pool
    this.config.mockDownstreamLatencyMs = downstreamLatencyMs;
    this.config.mockDownstreamFailureRate = failureRate;
    if (workerCount !== this.config.workerCount) {
      this.config.workerCount = workerCount;
      this.workerPool.updateConfig({ workerCount });
    }
    this.workerPool.updateConfig({
      mockDownstreamLatencyMs: downstreamLatencyMs,
      mockDownstreamFailureRate: failureRate,
    });
    this.trafficClient.updateConfig({
      idempotencyCollisionRate,
      failureRate,
      downstreamLatencyMs,
    });

    this.isSuiteRunning = true;
    this.suiteStartTime = Date.now();
    this.suiteStepDurationSec = stepDurationSec;
    this.suiteTargetRps = targetRps;
    this.suitePeakIncomingRps = 0;
    this.suitePeakAcceptedRps = 0;
    this.suitePeakDrainedRps = 0;
    this.suiteStrategyBreakdown = {};
    this.clearLastSuiteResults();
    this.suiteStrategyLatencies.clear();

    const firstStrategy = SUITE_STRATEGIES[0];
    this.config.routingStrategy = firstStrategy;
    this.workerPool.resetStrategyWindow();
    this.workerPool.updateConfig({ routingStrategy: firstStrategy });
    this.bufferQueue.clear();

    const currentWorkers = this.workerPool.getWorkers();
    this.suiteStepBaseline = {
      ingressed: 0,
      accepted: 0,
      processed: 0,
      failed: 0,
      timestamp: Date.now(),
      workerProcessed: new Map(currentWorkers.map((w) => [w.id, w.totalProcessed])),
    };

    this.trafficClient.start({
      targetRps,
      durationSec: 0,
      isUnlimited: true,
      schemaType: 'ecommerce',
      failureRate,
      downstreamLatencyMs,
      idempotencyCollisionRate,
    });
    this.scheduleNextTick();

    const runNextStep = async () => {
      if (!this.isSuiteRunning || this.suiteGeneration !== suiteGeneration) return;

      const currentStrat = SUITE_STRATEGIES[this.suiteStrategyIndexInLevel];
      const currentLevel = this.isMultiLevelRun
        ? this.suiteCurrentLevelIndex + 1
        : isObject && options.stressLevel
          ? options.stressLevel
          : 1;

      // Stop generating new ingress, then let every accepted item finish under
      // the current strategy. Nothing is purged: leftover work (only possible
      // if the bounded drain times out) carries over to the next strategy.
      this.trafficClient.stop();
      await this.drainSuiteWork(5000, suiteGeneration);

      if (!this.isSuiteRunning || this.suiteGeneration !== suiteGeneration) return;

      if (currentStrat) {
        this.recordCurrentStrategyBenchmark(currentStrat, currentLevel);
      }

      // Workers are idle after a successful drain; reset circuit/rotation state
      // so the next strategy starts from a clean router state.
      this.workerPool.resetStrategyWindow();
      this.metricsCollector.resetLatencySamples();

      // Advance strategy pointer
      this.suiteStrategyIndexInLevel++;
      let isDone = false;

      if (this.suiteStrategyIndexInLevel >= SUITE_STRATEGIES.length) {
        if (this.isMultiLevelRun && this.suiteCurrentLevelIndex < 3) {
          // Advance to next difficulty level (e.g. Level 1 -> 2 -> 3 -> 4)
          this.suiteCurrentLevelIndex++;
          this.suiteStrategyIndexInLevel = 0;
          const nextLevel = this.suiteCurrentLevelIndex + 1;
          const nextCfg = SUITE_LEVEL_CONFIGS[nextLevel];
          if (nextCfg) {
            this.config.mockDownstreamLatencyMs = nextCfg.downstreamLatencyMs;
            this.config.mockDownstreamFailureRate = nextCfg.failureRate;
            this.workerPool.updateConfig({
              mockDownstreamLatencyMs: nextCfg.downstreamLatencyMs,
              mockDownstreamFailureRate: nextCfg.failureRate,
            });
            this.trafficClient.updateConfig({
              targetRps: nextCfg.targetRps,
              downstreamLatencyMs: nextCfg.downstreamLatencyMs,
              failureRate: nextCfg.failureRate,
            });
            this.suiteTargetRps = nextCfg.targetRps;
          }
        } else {
          isDone = true;
        }
      }

      if (isDone) {
        this.compileFullSuiteResults('completed');
        this.restorePreSuiteConfig();
        this.isSuiteRunning = false;
        this.scheduleNextTick();
        return;
      }

      const nextStrategy = SUITE_STRATEGIES[this.suiteStrategyIndexInLevel];
      this.config.routingStrategy = nextStrategy;
      this.workerPool.updateConfig({ routingStrategy: nextStrategy });

      // Restart traffic for the next strategy. The benchmark baseline was reset
      // by recordCurrentStrategyBenchmark() after the drain completed.
      this.trafficClient.start({});
      this.scheduleNextTick();
      this.suiteStepTimer = setTimeout(() => {
        void runNextStep();
      }, this.suiteStepDurationSec * 1000);
    };

    this.suiteStepTimer = setTimeout(() => {
      void runNextStep();
    }, this.suiteStepDurationSec * 1000);

    const totalBenchmarks = this.isMultiLevelRun
      ? SUITE_STRATEGIES.length * 4
      : SUITE_STRATEGIES.length;
    const totalDurationSec = totalBenchmarks * this.suiteStepDurationSec;

    const message = this.isMultiLevelRun
      ? `Server Automated Matrix Test started: cycling through all 4 difficulty levels × 7 strategies (${totalBenchmarks} benchmarks total, ${this.suiteStepDurationSec}s each, ${totalDurationSec}s total). Traffic drained between steps.`
      : `Server stress test started: cycling through all ${SUITE_STRATEGIES.length} routing strategies (${this.suiteStepDurationSec}s each, ${totalDurationSec}s total). Traffic drained between steps.`;

    return {
      success: true,
      message,
      totalDurationSec,
    };
  }

  /**
   * Waits for the buffer and in-flight worker jobs to settle before switching
   * strategies. Bounded so a stuck downstream cannot stall the suite forever;
   * any leftover work is carried forward rather than purged.
   */
  private async drainSuiteWork(maxWaitMs: number, generation: number): Promise<void> {
    const startedAt = Date.now();
    while (
      this.isSuiteRunning &&
      this.suiteGeneration === generation &&
      (this.bufferQueue.getDepth() > 0 || this.workerPool.getActiveJobCount() > 0) &&
      Date.now() - startedAt < maxWaitMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (
      this.isSuiteRunning &&
      this.suiteGeneration === generation &&
      (this.bufferQueue.getDepth() > 0 || this.workerPool.getActiveJobCount() > 0)
    ) {
      console.warn(
        `[Bufferflow Suite] Drain wait exceeded ${maxWaitMs}ms; carrying ${this.bufferQueue.getDepth()} queued item(s) into the next strategy.`
      );
    }
  }

  private recordCurrentStrategyBenchmark(strat: RoutingStrategy, level: number = 1): void {
    const totals = this.metricsCollector.getCumulativeTotals();
    const now = Date.now();
    const elapsedStepSec = Math.max(1, Math.round((now - this.suiteStepBaseline.timestamp) / 1000));
    const ingressed = Math.max(0, totals.totalIngressed - this.suiteStepBaseline.ingressed);
    const accepted = Math.max(0, totals.totalAccepted - this.suiteStepBaseline.accepted);
    const processed = Math.max(0, totals.totalProcessed - this.suiteStepBaseline.processed);
    const failed = Math.max(0, totals.totalFailed - this.suiteStepBaseline.failed);
    const currentWorkers = this.workerPool.getWorkers();
    const workerDistribution: Record<string, number> = {};
    for (const w of currentWorkers) {
      const prev = this.suiteStepBaseline.workerProcessed.get(w.id) || 0;
      workerDistribution[w.id] = Math.max(0, w.totalProcessed - prev);
    }

    const latencyKey = `${level}_${strat}`;
    const samples = this.suiteStrategyLatencies.get(latencyKey) || [];
    const { p95 } = computePercentiles(samples);

    const benchmark: StrategyBenchmark = {
      strategy: strat,
      durationSec: elapsedStepSec,
      ingressed,
      accepted,
      processed,
      failed,
      avgThroughputRps: Math.round(processed / elapsedStepSec),
      p95LatencyMs: p95 > 0 ? p95 : totals.p95LatencyMs,
      workerDistribution,
    };

    this.suiteStrategyBreakdown[strat] = benchmark;
    if (!this.suiteLevelBreakdowns[level]) {
      this.suiteLevelBreakdowns[level] = {};
    }
    this.suiteLevelBreakdowns[level][strat] = benchmark;

    this.suiteStepBaseline = {
      ingressed: totals.totalIngressed,
      accepted: totals.totalAccepted,
      processed: totals.totalProcessed,
      failed: totals.totalFailed,
      timestamp: now,
      workerProcessed: new Map(currentWorkers.map((w) => [w.id, w.totalProcessed])),
    };
  }

  private compileFullSuiteResults(
    completedReason: FullSuiteResults['completedReason'] = 'completed'
  ): FullSuiteResults {
    const totals = this.metricsCollector.getCumulativeTotals();
    const currentWorkers = this.workerPool.getWorkers();
    const tested = Object.keys(this.suiteStrategyBreakdown) as RoutingStrategy[];
    const now = Date.now();
    const durationSec = Math.max(1, Math.round((now - this.suiteStartTime) / 1000));
    const totalBenchmarks = this.isMultiLevelRun
      ? SUITE_STRATEGIES.length * 4
      : SUITE_STRATEGIES.length;

    const rootStrategyBreakdown: Record<string, StrategyBenchmark> = {};

    if (this.isMultiLevelRun) {
      for (const strat of SUITE_STRATEGIES) {
        let totalDurationSec = 0;
        let totalIngressed = 0;
        let totalAccepted = 0;
        let totalProcessed = 0;
        let totalFailed = 0;
        const combinedWorkerDist: Record<string, number> = {};
        const combinedLatencySamples: number[] = [];

        for (const lvl of [1, 2, 3, 4]) {
          const lvlBench = this.suiteLevelBreakdowns[lvl]?.[strat];
          if (lvlBench) {
            totalDurationSec += lvlBench.durationSec;
            totalIngressed += lvlBench.ingressed;
            totalAccepted += lvlBench.accepted;
            totalProcessed += lvlBench.processed;
            totalFailed += lvlBench.failed;

            for (const [wId, count] of Object.entries(lvlBench.workerDistribution || {})) {
              combinedWorkerDist[wId] = (combinedWorkerDist[wId] || 0) + count;
            }
          }

          const samples = this.suiteStrategyLatencies.get(`${lvl}_${strat}`) || [];
          combinedLatencySamples.push(...samples);
        }

        if (totalDurationSec > 0) {
          const { p95 } = computePercentiles(combinedLatencySamples);
          rootStrategyBreakdown[strat] = {
            strategy: strat,
            durationSec: totalDurationSec,
            ingressed: totalIngressed,
            accepted: totalAccepted,
            processed: totalProcessed,
            failed: totalFailed,
            avgThroughputRps: Math.round(totalProcessed / Math.max(1, totalDurationSec)),
            p95LatencyMs: p95 > 0 ? p95 : totals.p95LatencyMs,
            workerDistribution: combinedWorkerDist,
          };
        }
      }
    } else {
      Object.assign(rootStrategyBreakdown, this.suiteStrategyBreakdown);
    }

    const results: FullSuiteResults = {
      testType: 'FULL_SUITE',
      runId: `suite_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      sessionId: this.id,
      startedAt: new Date(this.suiteStartTime).toISOString(),
      completedAt: new Date(now).toISOString(),
      durationSec,
      isMultiLevel: this.isMultiLevelRun,
      levelsTested: this.isMultiLevelRun ? [1, 2, 3, 4] : undefined,
      levelBreakdowns: this.isMultiLevelRun ? { ...this.suiteLevelBreakdowns } : undefined,
      completedReason,
      config: {
        targetRps: this.suiteTargetRps,
        durationSec: this.suiteStepDurationSec * totalBenchmarks,
        isUnlimited: false,
        failureRate: this.config.mockDownstreamFailureRate,
        downstreamLatencyMs: this.config.mockDownstreamLatencyMs,
        idempotencyCollisionRate: this.trafficClient.getConfig().idempotencyCollisionRate || 3,
        workerCount: this.config.workerCount,
        routingStrategy: this.isMultiLevelRun ? 'ALL_4_LEVELS_28_BENCHMARKS' : 'ALL_7_STRATEGIES',
      },
      strategiesTested: tested.length > 0 ? tested : [...SUITE_STRATEGIES],
      strategyBreakdown: rootStrategyBreakdown,
      summary: {
        totalIngressed: totals.totalIngressed,
        totalAccepted: totals.totalAccepted,
        totalProcessed: totals.totalProcessed,
        totalFailed: totals.totalFailed,
        peakIncomingRps: this.suitePeakIncomingRps,
        peakAcceptedRps: this.suitePeakAcceptedRps,
        peakDrainedRps: this.suitePeakDrainedRps,
        p50LatencyMs: totals.p50LatencyMs,
        p95LatencyMs: totals.p95LatencyMs,
        p99LatencyMs: totals.p99LatencyMs,
        finalBufferDepth: this.bufferQueue.getDepth(),
        finalDlqSize: this.dlq.size(),
      },
      workers: currentWorkers.map((w) => ({ ...w })),
    };

    this.lastCompletedSuiteResults = results;
    historyRepository.saveTestRun(results).catch((err) => {
      console.warn(`[Bufferflow History] Failed to save suite results: ${err?.message}`);
    });
    return results;
  }

  public stopFullSuiteTest(
    reason: FullSuiteResults['completedReason'] = 'stopped_by_user'
  ): FullSuiteResults | null {
    if (this.suiteStepTimer) {
      clearTimeout(this.suiteStepTimer);
      this.suiteStepTimer = null;
    }
    // Returning cached results here made a plain manual-run stop look like a
    // suite run. Callers that want the last result use getLastSuiteResults().
    if (!this.isSuiteRunning) return null;

    this.isSuiteRunning = false;
    this.trafficClient.stop();
    const currentStrat = SUITE_STRATEGIES[this.suiteStrategyIndexInLevel];
    const currentLevel = this.isMultiLevelRun ? this.suiteCurrentLevelIndex + 1 : 1;
    if (currentStrat && this.suiteStrategyIndexInLevel < SUITE_STRATEGIES.length) {
      this.recordCurrentStrategyBenchmark(currentStrat, currentLevel);
    }
    const results = this.compileFullSuiteResults(reason);
    this.restorePreSuiteConfig();
    this.scheduleNextTick();
    return results;
  }

  public getLastSuiteResults(): FullSuiteResults | null {
    return this.lastCompletedSuiteResults;
  }

  /**
   * Safety fallback for the last browser socket going away. Stops both the
   * suite and manual traffic so no orphaned timer keeps running with no client.
   */
  public stopForDisconnect(
    reason: FullSuiteResults['completedReason'] = 'safety_fallback_unload'
  ): void {
    this.stopFullSuiteTest(reason);
    this.trafficClient.stop();
    this.scheduleNextTick();
  }

  public isServerRunningSuite(): boolean {
    return this.isSuiteRunning;
  }

  public getSuiteProgress(): SuiteProgress | undefined {
    if (!this.isSuiteRunning) return undefined;

    const elapsed = Math.floor((Date.now() - this.suiteStartTime) / 1000);
    const totalBenchmarks = this.isMultiLevelRun
      ? SUITE_STRATEGIES.length * 4
      : SUITE_STRATEGIES.length;
    const totalDuration = totalBenchmarks * this.suiteStepDurationSec;
    const currentStrategy = SUITE_STRATEGIES[this.suiteStrategyIndexInLevel] || SUITE_STRATEGIES[0];
    const currentIndex = this.isMultiLevelRun
      ? this.suiteCurrentLevelIndex * SUITE_STRATEGIES.length + this.suiteStrategyIndexInLevel
      : this.suiteStrategyIndexInLevel;
    const pct = Math.min(100, Math.round((elapsed / totalDuration) * 100));

    return {
      active: true,
      currentStrategy,
      currentLevel: this.isMultiLevelRun ? this.suiteCurrentLevelIndex + 1 : undefined,
      totalLevels: this.isMultiLevelRun ? 4 : undefined,
      currentIndex,
      totalStrategies: totalBenchmarks,
      stepDurationSec: this.suiteStepDurationSec,
      totalDurationSec: totalDuration,
      elapsedSec: elapsed,
      pct,
    };
  }

  public resetRunHistory(): void {
    this.metricsCollector.reset();
    this.workerPool.resetCounters();
    this.bufferQueue.clear();
  }

  public touch() {
    this.lastActive = Date.now();
  }

  public destroy(reason: FullSuiteResults['completedReason'] = 'stopped_by_user') {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.stopFullSuiteTest(reason);
    // An API-only run (no sockets) must not keep pacing into a destroyed pool.
    this.trafficClient.stop();
    this.workerPool.stop();
    this.sockets.clear();
  }
}

export class SessionManager {
  private sessions: Map<string, SimulationSession> = new Map();
  private port: number;
  private maxSessions: number;

  constructor(port: number, maxSessions: number = 100) {
    this.port = port;
    this.maxSessions = maxSessions;

    // Cleanup stale sessions after 15 minutes of inactivity
    setInterval(() => {
      const cutoff = Date.now() - 15 * 60 * 1000;
      for (const [id, session] of this.sessions.entries()) {
        if (session.sockets.size === 0 && session.lastActive < cutoff) {
          session.destroy('safety_fallback_unload');
          this.sessions.delete(id);
        }
      }
    }, 60000);
  }

  private evictOldestIdleSession(): void {
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, session] of this.sessions.entries()) {
      if (session.sockets.size > 0) continue;
      if (session.lastActive < oldestAt) {
        oldestAt = session.lastActive;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.sessions.get(oldestId)?.destroy();
      this.sessions.delete(oldestId);
    }
  }

  public getOrCreate(id: string = 'default'): SimulationSession {
    const cleanId = id.trim() || 'default';
    let session = this.sessions.get(cleanId);
    if (!session) {
      if (this.sessions.size >= this.maxSessions) {
        this.evictOldestIdleSession();
      }
      session = new SimulationSession(cleanId, this.port);
      this.sessions.set(cleanId, session);
    }
    session.touch();
    return session;
  }
}
