import type { TrafficConfig } from './types';

export class TrafficClient {
  private isRunning: boolean = false;
  private intervalTimer: any = null;
  private autoStopTimer: any = null;
  private targetUrl: string;

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

  constructor(targetUrl: string = 'http://127.0.0.1:3001/api/ingress') {
    this.targetUrl = targetUrl;
  }

  public start(config: Partial<TrafficConfig> = {}): { success: boolean; message: string } {
    if (this.isRunning) {
      this.stop();
    }

    this.currentConfig = { ...this.currentConfig, ...config };
    this.isRunning = true;
    this.sentCount = 0;
    this.recentKeys = [];

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

  private dispatchBatch(batchSize: number): void {
    for (let i = 0; i < batchSize; i++) {
      this.sendSingleRequest();
    }
  }

  private async sendSingleRequest(): Promise<void> {
    this.sentCount++;
    const { key, payload } = this.generatePayload();

    try {
      // Direct high-speed loopback HTTP POST
      fetch(this.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'X-Simulate-Failure-Rate': String(this.currentConfig.failureRate),
          'X-Simulate-Downstream-Latency': String(this.currentConfig.downstreamLatencyMs),
        },
        body: JSON.stringify(payload),
      }).catch(() => {
        // Ignore loopback client disconnects during burst teardowns
      });
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
      // Re-use an existing key to test idempotency deduplication
      const randomIndex = Math.floor(Math.random() * this.recentKeys.length);
      key = this.recentKeys[randomIndex];
    } else {
      key = `tx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      if (this.recentKeys.length >= this.maxKeyHistory) {
        this.recentKeys.shift();
      }
      this.recentKeys.push(key);
    }

    let data: Record<string, any>;
    const schema = this.currentConfig.schemaType;

    if (schema === 'fintech') {
      data = {
        transactionId: key,
        accountFrom: `acc_${Math.floor(100000 + Math.random() * 900000)}`,
        accountTo: `acc_${Math.floor(100000 + Math.random() * 900000)}`,
        amount: Number((Math.random() * 15000).toFixed(2)),
        currency: 'USD',
        channel: 'SWIFT_ISO20022',
        timestamp: Date.now(),
      };
    } else if (schema === 'iot') {
      data = {
        deviceId: `sensor-${Math.floor(1 + Math.random() * 50)}`,
        telemetry: {
          temperatureC: Number((18 + Math.random() * 35).toFixed(2)),
          pressureKPa: Number((98 + Math.random() * 12).toFixed(2)),
          vibrationHz: Number((50 + Math.random() * 120).toFixed(1)),
        },
        firmware: 'v2.4.1',
        timestamp: Date.now(),
      };
    } else {
      // ecommerce
      data = {
        orderId: key,
        customerId: `cust_${Math.floor(1000 + Math.random() * 9000)}`,
        items: [
          { sku: 'ITEM-X9', qty: Math.floor(1 + Math.random() * 4), price: 49.99 },
          { sku: 'ITEM-Z1', qty: 1, price: 129.50 },
        ],
        totalAmount: Number((179.49 + Math.random() * 200).toFixed(2)),
        status: 'PENDING_CHECKOUT',
        timestamp: Date.now(),
      };
    }

    return {
      key,
      payload: {
        schemaType: schema,
        data,
      },
    };
  }
}
