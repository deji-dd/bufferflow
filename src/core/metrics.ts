import type { BufferQueue } from './buffer-queue';
import type { DeadLetterQueue } from './dlq';
import type { RoutingStrategy, TelemetryFrame, WorkerInfo } from './types';

/**
 * Nearest-rank percentile. Using floor(len * p) biases the result upward
 * (e.g. p50 of [1..100] would be 51 instead of 50).
 */
export function computePercentiles(samples: number[]): { p50: number; p95: number; p99: number } {
  if (!samples || samples.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const len = sorted.length;

  const at = (p: number) => {
    const index = Math.min(len - 1, Math.max(0, Math.ceil(p * len) - 1));
    return Number((sorted[index] ?? 0).toFixed(2));
  };

  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

export class MetricsCollector {
  // Rolling counts for the current window
  private windowIncoming: number = 0;
  private windowAccepted: number = 0;
  private windowRateLimited: number = 0;
  private windowDuplicates: number = 0;
  private windowDrained: number = 0;

  // Gateway ingress latency samples for the current window (ms). These feed the
  // p50/p95/p99 values shown as "Gateway P95" in the dashboard.
  private ingressSamples: number[] = [];
  private maxIngressSamples: number = 5000;

  // Downstream processing latency (enqueue -> terminal outcome). These feed the
  // cumulative/suite benchmarks and are intentionally separate from ingress.
  private processingSamples: number[] = [];
  private cumulativeProcessingSamples: number[] = [];
  private maxProcessingSamples: number = 2000;
  private maxCumulativeSamples: number = 5000;

  // Cumulative counters
  private totalIngressed: number = 0;
  private totalAccepted: number = 0;
  private totalProcessed: number = 0;
  private totalFailed: number = 0;

  // Last computed RPS values
  private currentIncomingRps: number = 0;
  private currentAcceptedRps: number = 0;
  private currentRateLimitedRps: number = 0;
  private currentDuplicateRps: number = 0;
  private currentDrainedRps: number = 0;

  private p50Latency: number = 0;
  private p95Latency: number = 0;
  private p99Latency: number = 0;

  private lastTickTime: number = performance.now();

  private recordSample(samples: number[], value: number, max: number): void {
    if (!(value > 0) || !Number.isFinite(value)) return;
    if (samples.length < max) {
      samples.push(value);
      return;
    }
    samples[Math.floor(Math.random() * max)] = value;
  }

  /**
   * Records one ingress request and its gateway latency. Called for accepted,
   * rate-limited and duplicate requests alike.
   */
  public recordIngress(latencyMs: number): void {
    this.windowIncoming++;
    this.totalIngressed++;
    this.recordSample(this.ingressSamples, latencyMs, this.maxIngressSamples);
  }

  public recordAccepted(): void {
    this.windowAccepted++;
    this.totalAccepted++;
  }

  public recordRateLimited(): void {
    this.windowRateLimited++;
  }

  public recordDuplicate(): void {
    this.windowDuplicates++;
  }

  /**
   * Records a terminal job outcome (success or exhausted retries). Retryable
   * failures are not reported here, so processed + failed <= accepted.
   */
  public recordJobProcessed(success: boolean, latencyMs?: number): void {
    this.windowDrained++;
    if (success) {
      this.totalProcessed++;
    } else {
      this.totalFailed++;
    }

    if (latencyMs !== undefined) {
      this.recordSample(this.processingSamples, latencyMs, this.maxProcessingSamples);
      this.recordSample(this.cumulativeProcessingSamples, latencyMs, this.maxCumulativeSamples);
    }
  }

  /**
   * Rolls the current 250ms/1s window: computes RPS + ingress percentiles and
   * resets the window counters. Only the session scheduler should call this.
   */
  public tick(
    bufferQueue: BufferQueue,
    dlq: DeadLetterQueue,
    workers: WorkerInfo[],
    routingStrategy: RoutingStrategy,
    trafficActive: boolean,
    targetRps: number,
    maxConcurrencyPerWorker: number
  ): TelemetryFrame {
    const now = performance.now();
    const elapsedSec = Math.max(0.001, (now - this.lastTickTime) / 1000);
    this.lastTickTime = now;

    // Calculate RPS for this window
    this.currentIncomingRps = Math.round(this.windowIncoming / elapsedSec);
    this.currentAcceptedRps = Math.round(this.windowAccepted / elapsedSec);
    this.currentRateLimitedRps = Math.round(this.windowRateLimited / elapsedSec);
    this.currentDuplicateRps = Math.round(this.windowDuplicates / elapsedSec);
    this.currentDrainedRps = Math.round(this.windowDrained / elapsedSec);

    // Reset window counters
    this.windowIncoming = 0;
    this.windowAccepted = 0;
    this.windowRateLimited = 0;
    this.windowDuplicates = 0;
    this.windowDrained = 0;

    if (this.ingressSamples.length > 0) {
      const { p50, p95, p99 } = computePercentiles(this.ingressSamples);
      this.p50Latency = p50;
      this.p95Latency = p95;
      this.p99Latency = p99;
      this.ingressSamples = [];
    } else if (!trafficActive && this.currentIncomingRps === 0) {
      this.p50Latency = 0;
      this.p95Latency = 0;
      this.p99Latency = 0;
    }

    return this.buildFrame(
      bufferQueue,
      dlq,
      workers,
      routingStrategy,
      trafficActive,
      targetRps,
      maxConcurrencyPerWorker
    );
  }

  /**
   * Returns the current telemetry frame WITHOUT rolling the window. Safe for
   * multiple consumers (WS connect, REST /api/metrics) because it never steals
   * samples from the scheduler.
   */
  public snapshot(
    bufferQueue: BufferQueue,
    dlq: DeadLetterQueue,
    workers: WorkerInfo[],
    routingStrategy: RoutingStrategy,
    trafficActive: boolean,
    targetRps: number,
    maxConcurrencyPerWorker: number
  ): TelemetryFrame {
    return this.buildFrame(
      bufferQueue,
      dlq,
      workers,
      routingStrategy,
      trafficActive,
      targetRps,
      maxConcurrencyPerWorker
    );
  }

  private buildFrame(
    bufferQueue: BufferQueue,
    dlq: DeadLetterQueue,
    workers: WorkerInfo[],
    routingStrategy: RoutingStrategy,
    trafficActive: boolean,
    targetRps: number,
    maxConcurrencyPerWorker: number
  ): TelemetryFrame {
    const bufferStats = bufferQueue.getStats();

    return {
      timestamp: Date.now(),
      trafficActive,
      activeTargetRps: trafficActive ? targetRps : 0,
      maxConcurrencyPerWorker,
      metrics: {
        incomingRps: this.currentIncomingRps,
        acceptedRps: this.currentAcceptedRps,
        rateLimitedRps: this.currentRateLimitedRps,
        duplicateRps: this.currentDuplicateRps,
        drainedRps: this.currentDrainedRps,
        p50LatencyMs: this.p50Latency,
        p95LatencyMs: this.p95Latency,
        p99LatencyMs: this.p99Latency,
        bufferDepth: bufferStats.depth,
        bufferCapacity: bufferStats.capacity,
        bufferUtilizationPct: Number(bufferStats.utilizationPct.toFixed(1)),
        queueLagMs: bufferStats.lagMs,
        dlqSize: dlq.size(),
        totalIngressed: this.totalIngressed,
        totalAccepted: this.totalAccepted,
        totalProcessed: this.totalProcessed,
        totalFailed: this.totalFailed,
      },
      workers,
      routingStrategy,
    };
  }

  public getCumulativeTotals() {
    const { p50, p95, p99 } = computePercentiles(this.cumulativeProcessingSamples);
    return {
      totalIngressed: this.totalIngressed,
      totalAccepted: this.totalAccepted,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      p50LatencyMs: p50 || this.p50Latency,
      p95LatencyMs: p95 || this.p95Latency,
      p99LatencyMs: p99 || this.p99Latency,
    };
  }

  public resetLatencySamples(): void {
    this.ingressSamples = [];
    this.processingSamples = [];
    this.p50Latency = 0;
    this.p95Latency = 0;
    this.p99Latency = 0;
  }

  public reset(): void {
    this.windowIncoming = 0;
    this.windowAccepted = 0;
    this.windowRateLimited = 0;
    this.windowDuplicates = 0;
    this.windowDrained = 0;
    this.currentIncomingRps = 0;
    this.currentAcceptedRps = 0;
    this.currentRateLimitedRps = 0;
    this.currentDuplicateRps = 0;
    this.currentDrainedRps = 0;
    this.totalIngressed = 0;
    this.totalAccepted = 0;
    this.totalProcessed = 0;
    this.totalFailed = 0;
    this.ingressSamples = [];
    this.processingSamples = [];
    this.cumulativeProcessingSamples = [];
    this.p50Latency = 0;
    this.p95Latency = 0;
    this.p99Latency = 0;
    this.lastTickTime = performance.now();
  }
}
