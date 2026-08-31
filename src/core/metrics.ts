import type { BufferQueue } from './buffer-queue';
import type { DeadLetterQueue } from './dlq';
import type { RoutingStrategy, TelemetryFrame, WorkerInfo } from './types';

export function computePercentiles(samples: number[]): { p50: number; p95: number; p99: number } {
  if (!samples || samples.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const len = sorted.length;
  return {
    p50: Number((sorted[Math.floor(len * 0.5)] ?? 0).toFixed(2)),
    p95: Number((sorted[Math.floor(len * 0.95)] ?? 0).toFixed(2)),
    p99: Number((sorted[Math.floor(len * 0.99)] ?? 0).toFixed(2)),
  };
}

export class MetricsCollector {
  // Rolling counts for the current window
  private windowIncoming: number = 0;
  private windowAccepted: number = 0;
  private windowRateLimited: number = 0;
  private windowDuplicates: number = 0;
  private windowDrained: number = 0;

  // Latency samples for percentile calculation (ms)
  private latencySamples: number[] = [];
  private cumulativeSamples: number[] = [];
  private maxLatencySamples: number = 2000;
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

  public recordIngress(_latencyMs: number): void {
    this.windowIncoming++;
    this.totalIngressed++;
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

  public recordJobProcessed(success: boolean, latencyMs?: number): void {
    this.windowDrained++;
    if (success) {
      this.totalProcessed++;
    } else {
      this.totalFailed++;
    }
    if (latencyMs !== undefined && latencyMs > 0) {
      if (this.latencySamples.length < this.maxLatencySamples) {
        this.latencySamples.push(latencyMs);
      } else {
        const idx = Math.floor(Math.random() * this.maxLatencySamples);
        this.latencySamples[idx] = latencyMs;
      }

      if (this.cumulativeSamples.length < this.maxCumulativeSamples) {
        this.cumulativeSamples.push(latencyMs);
      } else {
        const idx = Math.floor(Math.random() * this.maxCumulativeSamples);
        this.cumulativeSamples[idx] = latencyMs;
      }
    }
  }

  /**
   * Called every 250ms tick to compute instantaneous RPS and percentiles.
   */
  public tick(
    bufferQueue: BufferQueue,
    dlq: DeadLetterQueue,
    workers: WorkerInfo[],
    routingStrategy: RoutingStrategy,
    trafficActive: boolean,
    targetRps: number
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

    if (this.latencySamples.length > 0) {
      const { p50, p95, p99 } = computePercentiles(this.latencySamples);
      this.p50Latency = p50;
      this.p95Latency = p95;
      this.p99Latency = p99;
      this.latencySamples = [];
    } else if (!trafficActive && this.currentIncomingRps === 0) {
      this.p50Latency = 0;
      this.p95Latency = 0;
      this.p99Latency = 0;
    }

    const bufferStats = bufferQueue.getStats();

    return {
      timestamp: Date.now(),
      trafficActive,
      activeTargetRps: trafficActive ? targetRps : 0,
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
    const { p50, p95, p99 } = computePercentiles(this.cumulativeSamples);
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
    this.latencySamples = [];
    this.p50Latency = 0;
    this.p95Latency = 0;
    this.p99Latency = 0;
  }

  public reset(): void {
    this.totalIngressed = 0;
    this.totalAccepted = 0;
    this.totalProcessed = 0;
    this.totalFailed = 0;
    this.latencySamples = [];
    this.cumulativeSamples = [];
    this.p50Latency = 0;
    this.p95Latency = 0;
    this.p99Latency = 0;
  }
}
