import type { BufferQueue } from './buffer-queue';
import type { DLQItem, IngressPayload } from './types';

export class DeadLetterQueue {
  private items: DLQItem[] = [];
  private maxCapacity: number;

  constructor(maxCapacity: number = 10000) {
    this.maxCapacity = maxCapacity;
  }

  public push(item: IngressPayload, errorReason: string): DLQItem {
    const dlqRecord: DLQItem = {
      id: item.id,
      idempotencyKey: item.idempotencyKey,
      originalPayload: item,
      errorReason,
      failedAt: Date.now(),
      attempts: item.attempts,
    };

    // If max capacity reached, remove oldest
    if (this.items.length >= this.maxCapacity) {
      this.items.shift();
    }

    this.items.unshift(dlqRecord); // newest first
    return dlqRecord;
  }

  public getItems(limit: number = 50, offset: number = 0): { items: DLQItem[]; total: number } {
    return {
      items: this.items.slice(offset, offset + limit),
      total: this.items.length,
    };
  }

  public getById(id: string): DLQItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  public replay(id: string, queue: BufferQueue): boolean {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return false;

    const record = this.items[index];
    // Reset attempts and timestamp for replaying
    const replayedPayload: IngressPayload = {
      ...record.originalPayload,
      attempts: 0,
      enqueuedAt: Date.now(),
    };

    // Only remove the DLQ record once the payload is safely in the buffer.
    // Otherwise a full buffer would silently destroy the dead-letter entry.
    if (!queue.enqueue(replayedPayload)) return false;

    this.items.splice(index, 1);
    return true;
  }

  public replayAll(queue: BufferQueue): number {
    let replayedCount = 0;
    // Array is newest-first, so pop() replays oldest-first (FIFO).
    while (this.items.length > 0) {
      const record = this.items[this.items.length - 1];
      if (!record) break;

      const replayedPayload: IngressPayload = {
        ...record.originalPayload,
        attempts: 0,
        enqueuedAt: Date.now(),
      };

      // Stop on backpressure and keep the remaining records in the DLQ.
      if (!queue.enqueue(replayedPayload)) break;

      this.items.pop();
      replayedCount++;
    }
    return replayedCount;
  }

  public purge(): number {
    const count = this.items.length;
    this.items = [];
    return count;
  }

  public size(): number {
    return this.items.length;
  }
}
