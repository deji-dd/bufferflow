import { describe, expect, it } from 'bun:test';
import { BufferQueue } from '../src/core/buffer-queue';
import { DeadLetterQueue } from '../src/core/dlq';
import { IdempotencyStore } from '../src/core/idempotency';
import { TokenBucketRateLimiter } from '../src/core/rate-limiter';
import type { IngressPayload } from '../src/core/types';
import { WorkerPool } from '../src/core/worker-pool';

describe('Bufferflow Core Engine Test Suite', () => {
  describe('1. Token Bucket Rate Limiter', () => {
    it('allows burst up to capacity and rejects excess', () => {
      const limiter = new TokenBucketRateLimiter(100, 5);
      // Consume 5 tokens
      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume(1)).toBe(true);
      }
      // 6th should be rejected immediately
      expect(limiter.tryConsume(1)).toBe(false);
    });

    it('refills tokens over time', async () => {
      const limiter = new TokenBucketRateLimiter(1000, 2); // 1000/sec = 1 per ms
      expect(limiter.tryConsume(2)).toBe(true);
      expect(limiter.tryConsume(1)).toBe(false);

      await new Promise((r) => setTimeout(r, 10)); // 10ms should refill capacity
      expect(limiter.tryConsume(1)).toBe(true);
    });
  });

  describe('2. Idempotency Deduplication Store', () => {
    it('detects duplicate keys and allows unique ones', () => {
      const store = new IdempotencyStore(1000, 5000);
      const res1 = store.checkAndRecord('tx-order-001');
      expect(res1.isDuplicate).toBe(false);

      const res2 = store.checkAndRecord('tx-order-001');
      expect(res2.isDuplicate).toBe(true);

      const res3 = store.checkAndRecord('tx-order-002');
      expect(res3.isDuplicate).toBe(false);
    });
  });

  describe('3. Shock Absorber Buffer Queue', () => {
    it('enqueues and dequeues in FIFO order and computes queue lag', () => {
      const buffer = new BufferQueue(10);
      const p1: IngressPayload = {
        id: '1',
        idempotencyKey: 'k1',
        enqueuedAt: Date.now() - 50,
        schemaType: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
      };
      const p2: IngressPayload = {
        id: '2',
        idempotencyKey: 'k2',
        enqueuedAt: Date.now(),
        schemaType: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
      };

      buffer.enqueue(p1);
      buffer.enqueue(p2);

      expect(buffer.getDepth()).toBe(2);
      expect(buffer.getQueueLagMs()).toBeGreaterThanOrEqual(40);

      const deq1 = buffer.dequeue();
      expect(deq1?.id).toBe('1');
      const deq2 = buffer.dequeue();
      expect(deq2?.id).toBe('2');
      expect(buffer.getDepth()).toBe(0);
    });

    it('enforces capacity backpressure', () => {
      const buffer = new BufferQueue(2);
      const dummy: IngressPayload = {
        id: 'd',
        idempotencyKey: 'k',
        enqueuedAt: Date.now(),
        schemaType: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
      };

      expect(buffer.enqueue(dummy)).toBe(true);
      expect(buffer.enqueue(dummy)).toBe(true);
      expect(buffer.enqueue(dummy)).toBe(false); // Backpressure drop
    });
  });

  describe('4. Dead-Letter Queue (DLQ) & Replay', () => {
    it('stores failed payloads and replays them back into buffer', () => {
      const dlq = new DeadLetterQueue(100);
      const buffer = new BufferQueue(100);

      const failedPayload: IngressPayload = {
        id: 'failed-99',
        idempotencyKey: 'key-99',
        enqueuedAt: Date.now(),
        schemaType: 'test',
        data: { reason: 'network timeout' },
        attempts: 3,
        maxAttempts: 3,
      };

      dlq.push(failedPayload, 'Simulated 500 error');
      expect(dlq.size()).toBe(1);

      const item = dlq.getById('failed-99');
      expect(item).toBeDefined();
      expect(item?.errorReason).toContain('Simulated 500 error');

      // Replay
      const replayed = dlq.replay('failed-99', buffer);
      expect(replayed).toBe(true);
      expect(dlq.size()).toBe(0);
      expect(buffer.getDepth()).toBe(1);

      const reinjected = buffer.dequeue();
      expect(reinjected?.id).toBe('failed-99');
      expect(reinjected?.attempts).toBe(0); // reset attempts on replay
    });
  });

  describe('5. Worker Pool & Circuit Breaker', () => {
    it('dispatches to workers with least connections routing', () => {
      const pool = new WorkerPool({
        workerCount: 4,
        routingStrategy: 'LEAST_CONNECTIONS',
        circuitFailureThreshold: 3,
        circuitRecoveryTimeMs: 1000,
        maxRetries: 3,
        mockDownstreamLatencyMs: 5,
        mockDownstreamFailureRate: 0,
      });

      const workers = pool.getWorkers();
      expect(workers.length).toBe(4);
      expect(workers[0].circuitState).toBe('CLOSED');
    });
  });
});
