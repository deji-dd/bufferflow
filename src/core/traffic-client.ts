import type { BurstProgress, TrafficConfig } from './types';

export type IngressDispatchHandler = (
  key: string,
  payload: any,
  failureRate: number,
  downstreamLatencyMs: number
) => void;

export class TrafficClient {
  private isRunning: boolean = false;
  private intervalTimer: any = null;
  private autoStopTimer: any = null;
  private targetUrl: string;
  private burstStartTime: number = 0;

  private currentConfig: TrafficConfig = {
    targetRps: 2000,
    durationSec: 15,
    schemaType: 'ecommerce',
    failureRate: 5,
    downstreamLatencyMs: 15,
    idempotencyCollisionRate: 3,
  };

  private sentCount: number = 0;
  private recentKeys: string[] = [];
  private maxKeyHistory: number = 1000;
  private sessionId: string;
  private dispatchHandler?: IngressDispatchHandler;

  constructor(
    targetUrl: string = 'http://127.0.0.1:3001/api/ingress',
    sessionId: string = 'default',
    dispatchHandler?: IngressDispatchHandler
  ) {
    this.targetUrl = targetUrl;
    this.sessionId = sessionId;
    this.dispatchHandler = dispatchHandler;
  }

  public start(config: Partial<TrafficConfig> = {}): {
    success: boolean;
    message: string;
  } {
    if (this.isRunning) {
      this.stop();
    }

    this.currentConfig = { ...this.currentConfig, ...config };
    this.isRunning = true;
    this.sentCount = 0;
    this.recentKeys = [];
    this.burstStartTime = Date.now();

    const targetRps = Math.max(10, this.currentConfig.targetRps);
    // Dispatch every 25ms in batches: batchSize = targetRps * 0.025
    const tickIntervalMs = 25;
    const batchSize = Math.max(1, Math.round((targetRps * tickIntervalMs) / 1000));

    this.intervalTimer = setInterval(() => {
      if (!this.isRunning) return;
      this.dispatchBatch(batchSize);
    }, tickIntervalMs);

    // Auto-stop after durationSec
    if (this.currentConfig.durationSec > 0) {
      this.autoStopTimer = setTimeout(() => {
        this.stop();
      }, this.currentConfig.durationSec * 1000);
    }

    return {
      success: true,
      message: `Traffic client started: targeting ${targetRps} req/s for ${this.currentConfig.durationSec}s`,
    };
  }

  public stop(): { success: boolean; totalSent: number } {
    this.isRunning = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    return { success: true, totalSent: this.sentCount };
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public getConfig(): TrafficConfig {
    return { ...this.currentConfig };
  }

  public getProgress(): BurstProgress {
    if (!this.isRunning) {
      return {
        active: false,
        elapsedSec: 0,
        durationSec: this.currentConfig.durationSec,
        pct: 0,
      };
    }
    const elapsed = Math.min(
      this.currentConfig.durationSec,
      Math.floor((Date.now() - this.burstStartTime) / 1000)
    );
    const pct =
      this.currentConfig.durationSec > 0
        ? Math.min(100, Math.round((elapsed / this.currentConfig.durationSec) * 100))
        : 100;
    return {
      active: true,
      elapsedSec: elapsed,
      durationSec: this.currentConfig.durationSec,
      pct,
    };
  }

  private dispatchBatch(batchSize: number): void {
    for (let i = 0; i < batchSize; i++) {
      this.sendSingleRequest();
    }
  }

  private sendSingleRequest(): void {
    this.sentCount++;
    const { key, payload } = this.generatePayload();

    if (this.dispatchHandler) {
      this.dispatchHandler(
        key,
        payload,
        this.currentConfig.failureRate,
        this.currentConfig.downstreamLatencyMs
      );
      return;
    }

    try {
      fetch(this.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'X-Session-Id': this.sessionId,
          'X-Simulate-Failure-Rate': String(this.currentConfig.failureRate),
          'X-Simulate-Downstream-Latency': String(this.currentConfig.downstreamLatencyMs),
        },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch {
      // Ignored
    }
  }

  private generatePayload(): { key: string; payload: any } {
    let key: string;
    const shouldCollide =
      this.recentKeys.length > 20 &&
      Math.random() * 100 < this.currentConfig.idempotencyCollisionRate;

    if (shouldCollide) {
      const randomIndex = Math.floor(Math.random() * this.recentKeys.length);
      key = this.recentKeys[randomIndex];
    } else {
      key = `tx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      if (this.recentKeys.length >= this.maxKeyHistory) {
        this.recentKeys.shift();
      }
      this.recentKeys.push(key);
    }

    const payloadByType = {
      ecommerce: {
        eventType: 'ORDER_CHECKOUT',
        orderId: `ord_${Math.random().toString(36).substring(2, 8)}`,
        amount: Number((Math.random() * 250 + 10).toFixed(2)),
        currency: 'USD',
        customerId: `usr_${Math.floor(Math.random() * 10000)}`,
        items: [
          { sku: 'ITEM-ALPHA', qty: Math.floor(Math.random() * 3) + 1 },
          { sku: 'ITEM-BETA', qty: 1 },
        ],
      },
      fintech: {
        eventType: 'LEDGER_SETTLEMENT',
        transactionId: `txn_${Math.random().toString(36).substring(2, 10)}`,
        amount: Number((Math.random() * 50000 + 100).toFixed(2)),
        sourceAccount: `acc_${Math.floor(Math.random() * 900000 + 100000)}`,
        destinationAccount: `acc_${Math.floor(Math.random() * 900000 + 100000)}`,
        transferType: 'SWIFT_ACH_DIRECT',
      },
      iot: {
        eventType: 'TELEMETRY_SAMPLE',
        deviceId: `sensor_${Math.floor(Math.random() * 500)}`,
        temperatureCelsius: Number((Math.random() * 35 + 15).toFixed(1)),
        pressureHpa: Number((Math.random() * 50 + 980).toFixed(1)),
        batteryPct: Math.floor(Math.random() * 100),
      },
    };

    return {
      key,
      payload: {
        schemaType: this.currentConfig.schemaType,
        timestamp: Date.now(),
        data: payloadByType[this.currentConfig.schemaType],
      },
    };
  }
}
