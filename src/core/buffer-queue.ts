import type { IngressPayload } from './types';

export class BufferQueue {
  private queue: IngressPayload[];
  private capacity: number;
  private totalEnqueued: number = 0;
  private totalDequeued: number = 0;
  private totalDropped: number = 0;

  private onEnqueueCallback?: () => void;

  constructor(capacity: number = 50000) {
    this.capacity = capacity;
    this.queue = [];
  }

  public setOnEnqueueCallback(cb: () => void): void {
    this.onEnqueueCallback = cb;
  }

  public enqueue(item: IngressPayload): boolean {
    if (this.queue.length >= this.capacity) {
      this.totalDropped++;
      return false; // Backpressure drop
    }
    this.queue.push(item);
    this.totalEnqueued++;
    if (this.onEnqueueCallback) {
      this.onEnqueueCallback();
    }
    return true;
  }

  public dequeue(): IngressPayload | undefined {
    const item = this.queue.shift();
    if (item) {
      this.totalDequeued++;
    }
    return item;
  }

  public peek(): IngressPayload | undefined {
    return this.queue[0];
  }

  public getDepth(): number {
    return this.queue.length;
  }

  public getCapacity(): number {
    return this.capacity;
  }

  public setCapacity(newCapacity: number): void {
    this.capacity = newCapacity;
  }

  public getUtilizationPct(): number {
    if (this.capacity === 0) return 0;
    return Math.min(100, (this.queue.length / this.capacity) * 100);
  }

  /**
   * Queue lag in ms: how long the oldest waiting item in the queue has been queued.
   */
  public getQueueLagMs(): number {
    const oldest = this.queue[0];
    if (!oldest) return 0;
    return Math.max(0, Date.now() - oldest.enqueuedAt);
  }

  public getStats() {
    return {
      depth: this.queue.length,
      capacity: this.capacity,
      utilizationPct: this.getUtilizationPct(),
      lagMs: this.getQueueLagMs(),
      totalEnqueued: this.totalEnqueued,
      totalDequeued: this.totalDequeued,
      totalDropped: this.totalDropped,
    };
  }

  public clear(): void {
    this.queue = [];
  }
}
