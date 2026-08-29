export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type RoutingStrategy = 'LEAST_CONNECTIONS' | 'WEIGHTED_ROUND_ROBIN' | 'ROUND_ROBIN';

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
  durationSec: number;
  schemaType: 'fintech' | 'iot' | 'ecommerce';
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
}

export interface BurstProgress {
  active: boolean;
  elapsedSec: number;
  durationSec: number;
  pct: number;
}

export interface TelemetryFrame {
  timestamp: number;
  trafficActive: boolean;
  activeTargetRps: number;
  burstProgress?: BurstProgress;
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
