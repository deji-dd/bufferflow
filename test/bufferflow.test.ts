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

  describe('5. Worker Pool & Routing Strategies', () => {
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

    it('supports all extended routing strategies without error', async () => {
      const strategies = [
        'LEAST_CONNECTIONS',
        'WEIGHTED_ROUND_ROBIN',
        'ROUND_ROBIN',
        'RANDOM',
        'POWER_OF_TWO_CHOICES',
        'WEIGHTED_LEAST_CONNECTIONS',
        'CONSISTENT_HASH',
      ] as const;

      for (const strategy of strategies) {
        const pool = new WorkerPool({
          workerCount: 4,
          routingStrategy: strategy,
          circuitFailureThreshold: 3,
          circuitRecoveryTimeMs: 1000,
          maxRetries: 3,
          mockDownstreamLatencyMs: 2,
          mockDownstreamFailureRate: 0,
        });

        const queue = new BufferQueue(10);
        const dlq = new DeadLetterQueue(10);

        queue.enqueue({
          id: `item-${strategy}`,
          idempotencyKey: `key-${strategy}`,
          enqueuedAt: Date.now(),
          schemaType: 'ecommerce',
          data: { test: true },
          attempts: 0,
          maxAttempts: 3,
        });

        pool.start(queue, dlq);
        await new Promise((r) => setTimeout(r, 20));
        pool.stop();

        expect(queue.getDepth()).toBe(0);
      }
    });

    it('resets worker counters with resetCounters()', async () => {
      const pool = new WorkerPool({
        workerCount: 2,
        routingStrategy: 'ROUND_ROBIN',
        circuitFailureThreshold: 3,
        circuitRecoveryTimeMs: 1000,
        maxRetries: 3,
        mockDownstreamLatencyMs: 2,
        mockDownstreamFailureRate: 0,
      });
      const queue = new BufferQueue(10);
      const dlq = new DeadLetterQueue(10);
      pool.start(queue, dlq);

      for (let i = 0; i < 5; i++) {
        queue.enqueue({
          id: `reset-${i}`,
          idempotencyKey: `reset-key-${i}`,
          enqueuedAt: Date.now(),
          schemaType: 'test',
          data: {},
          attempts: 0,
          maxAttempts: 3,
        });
      }
      await new Promise((r) => setTimeout(r, 80));

      const before = pool.getWorkers();
      expect(before.reduce((sum, w) => sum + w.totalProcessed, 0)).toBeGreaterThan(0);

      pool.resetCounters();
      const resetWorkers = pool.getWorkers();
      expect(resetWorkers[0].totalProcessed).toBe(0);
      expect(resetWorkers[0].totalFailed).toBe(0);
      expect(resetWorkers.reduce((sum, w) => sum + w.totalProcessed, 0)).toBe(0);
      pool.stop();
    });
  });

  describe('6. Traffic Client Dynamics & Unlimited Mode', () => {
    it('supports unlimited duration and live config updates', async () => {
      const dispatched: any[] = [];
      const { TrafficClient } = await import('../src/core/traffic-client');
      const client = new TrafficClient('http://127.0.0.1:3001/api/ingress', 'test', (k, p) => {
        dispatched.push({ k, p });
      });

      // Start with unlimited duration (durationSec = 0)
      client.start({ targetRps: 200, durationSec: 0, isUnlimited: true });
      expect(client.isActive()).toBe(true);

      const progress = client.getProgress();
      expect(progress.isUnlimited).toBe(true);

      // Live update targetRps
      client.updateConfig({ targetRps: 400 });
      expect(client.getConfig().targetRps).toBe(400);

      await new Promise((r) => setTimeout(r, 50));
      expect(dispatched.length).toBeGreaterThan(0);

      const stopResult = client.stop();
      expect(stopResult.success).toBe(true);
      expect(client.isActive()).toBe(false);
    });
  });

  describe('7. Server Full Suite Stress Test', () => {
    it('executes server suite test across strategies and tracks progress', async () => {
      const { SimulationSession } = await import('../src/core/simulation-session');
      const session = new SimulationSession('suite-test', 3001);

      // Start full suite test with fast step duration (1s per step)
      const res = session.startFullSuiteTest(1, 500);
      expect(res.success).toBe(true);
      expect(session.isServerRunningSuite()).toBe(true);

      const progress = session.getSuiteProgress();
      expect(progress).toBeDefined();
      expect(progress?.active).toBe(true);
      expect(progress?.totalStrategies).toBe(7);
      expect(progress?.currentStrategy).toBe('LEAST_CONNECTIONS');

      // Stop suite test and verify compiled results
      const suiteResults = session.stopFullSuiteTest();
      expect(session.isServerRunningSuite()).toBe(false);
      expect(session.getSuiteProgress()).toBeUndefined();
      expect(suiteResults).toBeDefined();
      expect(suiteResults?.testType).toBe('FULL_SUITE');
      expect(suiteResults?.strategiesTested).toContain('LEAST_CONNECTIONS');
      expect(suiteResults?.strategyBreakdown.LEAST_CONNECTIONS).toBeDefined();
      expect(suiteResults?.config.routingStrategy).toBe('ALL_7_STRATEGIES');
      expect(suiteResults?.config.targetRps).toBe(500);
      session.destroy();
    });

    it('executes server suite test with custom stress intensity options', async () => {
      const { SimulationSession } = await import('../src/core/simulation-session');
      const session = new SimulationSession('suite-stress-test', 3001);

      const res = session.startFullSuiteTest({
        stepDurationSec: 1,
        targetRps: 4000,
        downstreamLatencyMs: 40,
        failureRate: 15,
        stressLevel: 2,
      });
      expect(res.success).toBe(true);
      expect(session.isServerRunningSuite()).toBe(true);

      const suiteResults = session.stopFullSuiteTest();
      expect(suiteResults?.config.targetRps).toBe(4000);
      expect(suiteResults?.config.downstreamLatencyMs).toBe(40);
      expect(suiteResults?.config.failureRate).toBe(15);
      session.destroy();
    });

    it('supports automated matrix test across all 4 levels and drains between steps', async () => {
      const { SimulationSession } = await import('../src/core/simulation-session');
      const session = new SimulationSession('matrix-test', 3001);

      const res = session.startFullSuiteTest({
        stepDurationSec: 2,
        runAllLevels: true,
      });
      expect(res.success).toBe(true);
      expect(session.isServerRunningSuite()).toBe(true);

      const progress = session.getSuiteProgress();
      expect(progress?.totalLevels).toBe(4);
      expect(progress?.totalStrategies).toBe(28);
      expect(progress?.currentLevel).toBe(1);

      const suiteResults = session.stopFullSuiteTest();
      expect(suiteResults?.isMultiLevel).toBe(true);
      expect(suiteResults?.levelsTested).toEqual([1, 2, 3, 4]);
      expect(suiteResults?.levelBreakdowns).toBeDefined();
      session.destroy();
    });
  });
});
