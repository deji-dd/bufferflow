export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type RoutingStrategy =
  | 'LEAST_CONNECTIONS'
  | 'WEIGHTED_ROUND_ROBIN'
  | 'ROUND_ROBIN'
  | 'RANDOM'
  | 'POWER_OF_TWO_CHOICES'
  | 'WEIGHTED_LEAST_CONNECTIONS'
  | 'CONSISTENT_HASH';

export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = [
  'LEAST_CONNECTIONS',
  'WEIGHTED_ROUND_ROBIN',
  'ROUND_ROBIN',
  'RANDOM',
  'POWER_OF_TWO_CHOICES',
  'WEIGHTED_LEAST_CONNECTIONS',
  'CONSISTENT_HASH',
];

export function isRoutingStrategy(value: unknown): value is RoutingStrategy {
  return typeof value === 'string' && (ROUTING_STRATEGIES as readonly string[]).includes(value);
}

export type WorkerState = 'IDLE' | 'BUSY' | 'CIRCUIT_OPEN' | 'HALF_OPEN';

export interface IngressPayload {
  id: string;
  idempotencyKey: string;
  enqueuedAt: number;
  schemaType: string;
  data: Record<string, any>;
  attempts: number;
  maxAttempts: number;
}

export interface WorkerInfo {
  id: string;
  name: string;
  weight: number;
  state: WorkerState;
  activeJobs: number;
  totalProcessed: number;
  totalFailed: number;
  circuitState: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  circuitTrippedAt?: number;
}

export interface DLQItem {
  id: string;
  idempotencyKey: string;
  originalPayload: IngressPayload;
  errorReason: string;
  failedAt: number;
  attempts: number;
}

export interface TrafficConfig {
  targetRps: number;
  durationSec: number; // 0 = unlimited
  isUnlimited?: boolean;
  schemaType?: string;
  failureRate: number; // 0 to 100 percentage of downstream failures
  downstreamLatencyMs: number; // downstream simulated latency
  idempotencyCollisionRate: number; // percentage of requests that reuse keys
}

export interface SystemConfig {
  rateLimitPerSec: number;
  rateLimitBurst: number;
  bufferCapacity: number;
  workerCount: number;
  routingStrategy: RoutingStrategy;
  circuitFailureThreshold: number;
  circuitRecoveryTimeMs: number;
  maxRetries: number;
  mockDownstreamLatencyMs: number;
  mockDownstreamFailureRate: number; // 0-100%
  maxConcurrencyPerWorker: number;
}

/**
 * Runtime patch accepted by the config/start endpoints. It combines system
 * settings with traffic-generator settings so a single validated patch can be
 * applied consistently. Unknown fields are rejected by the HTTP layer.
 */
export interface ConfigPatch extends Partial<SystemConfig> {
  targetRps?: number;
  durationSec?: number;
  isUnlimited?: boolean;
  schemaType?: string;
  failureRate?: number;
  downstreamLatencyMs?: number;
  idempotencyCollisionRate?: number;
}

export interface BurstProgress {
  active: boolean;
  elapsedSec: number;
  durationSec: number;
  pct: number;
  isUnlimited?: boolean;
}

export interface SuiteProgress {
  active: boolean;
  currentStrategy: RoutingStrategy;
  currentLevel?: number;
  totalLevels?: number;
  currentIndex: number;
  totalStrategies: number;
  stepDurationSec: number;
  totalDurationSec: number;
  elapsedSec: number;
  pct: number;
  strategyResults?: Record<
    string,
    {
      totalProcessed: number;
      totalFailed: number;
      avgDrainedRps: number;
    }
  >;
}

export interface StrategyBenchmark {
  strategy: RoutingStrategy;
  durationSec: number;
  ingressed: number;
  accepted: number;
  processed: number;
  failed: number;
  avgThroughputRps: number;
  p95LatencyMs: number;
  workerDistribution: Record<string, number>;
}

export interface FullSuiteResults {
  testType: 'FULL_SUITE';
  runId: string;
  sessionId: string;
  startedAt: string;
  completedAt: string;
  durationSec: number;
  isMultiLevel?: boolean;
  levelsTested?: number[];
  levelBreakdowns?: Record<number, Record<string, StrategyBenchmark>>;
  completedReason:
    'completed' | 'stopped_by_user' | 'safety_fallback_blur' | 'safety_fallback_unload';
  config: {
    targetRps: number;
    durationSec: number;
    isUnlimited?: boolean;
    schemaType?: string;
    failureRate: number;
    downstreamLatencyMs: number;
    idempotencyCollisionRate: number;
    workerCount: number;
    routingStrategy: string;
  };
  strategiesTested: RoutingStrategy[];
  strategyBreakdown: Record<string, StrategyBenchmark>;
  summary: {
    totalIngressed: number;
    totalAccepted: number;
    totalProcessed: number;
    totalFailed: number;
    peakIncomingRps: number;
    peakAcceptedRps: number;
    peakDrainedRps: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    finalBufferDepth: number;
    finalDlqSize: number;
  };
  workers: WorkerInfo[];
}

export interface TelemetryFrame {
  timestamp: number;
  trafficActive: boolean;
  activeTargetRps: number;
  maxConcurrencyPerWorker: number;
  burstProgress?: BurstProgress;
  suiteProgress?: SuiteProgress;
  isServerRunningTest?: boolean;
  metrics: {
    incomingRps: number;
    acceptedRps: number;
    rateLimitedRps: number;
    duplicateRps: number;
    drainedRps: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    bufferDepth: number;
    bufferCapacity: number;
    bufferUtilizationPct: number;
    queueLagMs: number;
    dlqSize: number;
    totalIngressed: number;
    totalAccepted: number;
    totalProcessed: number;
    totalFailed: number;
  };
  workers: WorkerInfo[];
  routingStrategy: RoutingStrategy;
}
