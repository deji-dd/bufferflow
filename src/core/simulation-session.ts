import { BufferQueue } from './buffer-queue';
import { DeadLetterQueue } from './dlq';
import { IdempotencyStore } from './idempotency';
import { computePercentiles, MetricsCollector } from './metrics';
import { TokenBucketRateLimiter } from './rate-limiter';
import { TrafficClient } from './traffic-client';
import type {
  FullSuiteResults,
  IngressPayload,
  RoutingStrategy,
  StrategyBenchmark,
  SuiteProgress,
  SystemConfig,
} from './types';
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

      if (this.isSuiteRunning) {
        this.suitePeakIncomingRps = Math.max(this.suitePeakIncomingRps, frame.metrics.incomingRps);
        this.suitePeakAcceptedRps = Math.max(this.suitePeakAcceptedRps, frame.metrics.acceptedRps);
        this.suitePeakDrainedRps = Math.max(this.suitePeakDrainedRps, frame.metrics.drainedRps);
      }

      frame.burstProgress = this.trafficClient.getProgress();
      frame.suiteProgress = this.getSuiteProgress();
      frame.isServerRunningTest = this.isSuiteRunning;
      if (this.lastCompletedSuiteResults) {
        frame.suiteResults = this.lastCompletedSuiteResults;
      }

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
    this.lastCompletedSuiteResults = null;
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

    const runNextStep = () => {
      if (!this.isSuiteRunning) return;

      const currentStrat = SUITE_STRATEGIES[this.suiteStrategyIndexInLevel];
      const currentLevel = this.isMultiLevelRun
        ? this.suiteCurrentLevelIndex + 1
        : isObject && options.stressLevel
          ? options.stressLevel
          : 1;

      if (currentStrat) {
        this.recordCurrentStrategyBenchmark(currentStrat, currentLevel);
      }

      // CRITICAL SAFEGUARD: Purge buffer and reset workers between every strategy switch
      // so each algorithm begins on a pristine buffer baseline (depth 0, no inherited dwell lag)
      this.bufferQueue.clear();
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
        // Stop generating new ingress traffic immediately
        this.trafficClient.stop();

        // Allow active in-flight worker jobs to finish draining gracefully before final snapshot
        const drainAndFinalize = async () => {
          const startDrain = Date.now();
          const maxDrainWaitMs = 2500;
          while (
            (this.bufferQueue.getDepth() > 0 || this.workerPool.getActiveJobCount() > 0) &&
            Date.now() - startDrain < maxDrainWaitMs
          ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }

          this.compileFullSuiteResults('completed');
          this.isSuiteRunning = false;
        };

        drainAndFinalize();
        return;
      }

      const nextStrategy = SUITE_STRATEGIES[this.suiteStrategyIndexInLevel];
      this.config.routingStrategy = nextStrategy;
      this.workerPool.updateConfig({ routingStrategy: nextStrategy });

      this.suiteStepTimer = setTimeout(runNextStep, this.suiteStepDurationSec * 1000);
    };

    this.suiteStepTimer = setTimeout(runNextStep, this.suiteStepDurationSec * 1000);

    const totalBenchmarks = this.isMultiLevelRun
      ? SUITE_STRATEGIES.length * 4
      : SUITE_STRATEGIES.length;
    const totalDurationSec = totalBenchmarks * this.suiteStepDurationSec;

    const message = this.isMultiLevelRun
      ? `Server Automated Matrix Test started: cycling through all 4 difficulty levels × 7 strategies (${totalBenchmarks} benchmarks total, ${this.suiteStepDurationSec}s each, ${totalDurationSec}s total). Buffer purged between steps.`
      : `Server stress test started: cycling through all ${SUITE_STRATEGIES.length} routing strategies (${this.suiteStepDurationSec}s each, ${totalDurationSec}s total). Buffer purged between steps.`;

    return {
      success: true,
      message,
      totalDurationSec,
    };
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
        peakIncomingRps: this.suitePeakIncomingRps || this.suiteTargetRps,
        peakAcceptedRps: this.suitePeakAcceptedRps || this.suiteTargetRps,
        peakDrainedRps: this.suitePeakDrainedRps || this.suiteTargetRps,
        p50LatencyMs: totals.p50LatencyMs,
        p95LatencyMs: totals.p95LatencyMs,
        p99LatencyMs: totals.p99LatencyMs,
        finalBufferDepth: this.bufferQueue.getDepth(),
        finalDlqSize: this.dlq.size(),
      },
      workers: currentWorkers.map((w) => ({ ...w })),
    };

    this.lastCompletedSuiteResults = results;
    return results;
  }

  public stopFullSuiteTest(
    reason: FullSuiteResults['completedReason'] = 'stopped_by_user'
  ): FullSuiteResults | null {
    if (this.suiteStepTimer) {
      clearTimeout(this.suiteStepTimer);
      this.suiteStepTimer = null;
    }
    if (!this.isSuiteRunning) return this.lastCompletedSuiteResults;

    this.isSuiteRunning = false;
    this.trafficClient.stop();
    const currentStrat = SUITE_STRATEGIES[this.suiteStrategyIndexInLevel];
    const currentLevel = this.isMultiLevelRun ? this.suiteCurrentLevelIndex + 1 : 1;
    if (currentStrat) {
      this.recordCurrentStrategyBenchmark(currentStrat, currentLevel);
    }
    const results = this.compileFullSuiteResults(reason);
    return results;
  }

  public getLastSuiteResults(): FullSuiteResults | null {
    return this.lastCompletedSuiteResults;
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

  public destroy() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.stopFullSuiteTest();
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
