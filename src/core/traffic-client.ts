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
    if (config.isUnlimited || this.currentConfig.durationSec <= 0) {
      this.currentConfig.durationSec = 0;
      this.currentConfig.isUnlimited = true;
    }
    this.isRunning = true;
    this.sentCount = 0;
    this.recentKeys = [];
    this.burstStartTime = Date.now();

    const targetRps = Math.max(10, this.currentConfig.targetRps);
    this.startPacer();

    // Auto-stop after durationSec if not unlimited
    if (this.currentConfig.durationSec > 0 && !this.currentConfig.isUnlimited) {
      this.autoStopTimer = setTimeout(() => {
        this.stop();
      }, this.currentConfig.durationSec * 1000);
    }

    const durationLabel =
      this.currentConfig.isUnlimited || this.currentConfig.durationSec <= 0
        ? 'unlimited duration'
        : `${this.currentConfig.durationSec}s`;

    return {
      success: true,
      message: `Traffic client started: targeting ${targetRps} req/s for ${durationLabel}`,
    };
  }

  private startPacer(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    let accumulatedTokens = 0;
    let lastTick = performance.now();
    const tickIntervalMs = 20;

    this.intervalTimer = setInterval(() => {
      if (!this.isRunning) return;
      const now = performance.now();
      const deltaSec = Math.max(0, (now - lastTick) / 1000);
      lastTick = now;
      accumulatedTokens += deltaSec * this.currentConfig.targetRps;
      const countToSend = Math.floor(accumulatedTokens);
      if (countToSend > 0) {
        accumulatedTokens -= countToSend;
        this.dispatchBatch(countToSend);
      }
    }, tickIntervalMs);
  }

  public updateConfig(config: Partial<TrafficConfig>): void {
    this.currentConfig = { ...this.currentConfig, ...config };

    if (config.isUnlimited !== undefined) {
      if (config.isUnlimited) {
        this.currentConfig.durationSec = 0;
        this.currentConfig.isUnlimited = true;
        if (this.autoStopTimer) {
          clearTimeout(this.autoStopTimer);
          this.autoStopTimer = null;
        }
      } else {
        this.currentConfig.isUnlimited = false;
      }
    }

    if (this.isRunning && config.targetRps !== undefined) {
      this.startPacer();
    }

    if (this.isRunning && config.durationSec !== undefined && !this.currentConfig.isUnlimited) {
      if (this.autoStopTimer) {
        clearTimeout(this.autoStopTimer);
        this.autoStopTimer = null;
      }
      if (config.durationSec > 0) {
        const elapsedMs = Date.now() - this.burstStartTime;
        const remainingMs = Math.max(0, config.durationSec * 1000 - elapsedMs);
        this.autoStopTimer = setTimeout(() => {
          this.stop();
        }, remainingMs);
      }
    }
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
    const isUnlimited = !!(this.currentConfig.isUnlimited || this.currentConfig.durationSec <= 0);
    if (!this.isRunning) {
      return {
        active: false,
        elapsedSec: 0,
        durationSec: this.currentConfig.durationSec,
        pct: 0,
        isUnlimited,
      };
    }
    const elapsed = Math.floor((Date.now() - this.burstStartTime) / 1000);
    const pct = isUnlimited
      ? 100
      : this.currentConfig.durationSec > 0
        ? Math.min(100, Math.round((elapsed / this.currentConfig.durationSec) * 100))
        : 100;
    return {
      active: true,
      elapsedSec: isUnlimited ? elapsed : Math.min(this.currentConfig.durationSec, elapsed),
      durationSec: this.currentConfig.durationSec,
      pct,
      isUnlimited,
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

    const schemaKey = ((this.currentConfig.schemaType as keyof typeof payloadByType) ||
      'ecommerce') as keyof typeof payloadByType;
    return {
      key,
      payload: {
        schemaType: schemaKey,
        timestamp: Date.now(),
        data: payloadByType[schemaKey] || payloadByType.ecommerce,
      },
    };
  }
}
