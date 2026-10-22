import { describe, expect, it } from 'bun:test';

import {
  API_TOKEN_ENV,
  DEFAULT_MAX_BODY_BYTES,
  extractApiToken,
  getMaxRequestBodyBytes,
  isAuthorized,
  isProtectedPath,
  isRequestBodyTooLarge,
  MAX_BODY_BYTES_ENV,
} from '../src/core/auth';
import { BufferQueue } from '../src/core/buffer-queue';
import { DeadLetterQueue } from '../src/core/dlq';
import { computePercentiles, MetricsCollector } from '../src/core/metrics';
import { SimulationSession } from '../src/core/simulation-session';
import { TrafficClient } from '../src/core/traffic-client';
import type { IngressPayload, RoutingStrategy } from '../src/core/types';
import { WorkerPool } from '../src/core/worker-pool';
import { deriveLevelsTested, toTestRunRecord } from '../src/db/repository';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makePayload(id: string, overrides: Partial<IngressPayload> = {}): IngressPayload {
  return {
    id,
    idempotencyKey: `key-${id}`,
    enqueuedAt: Date.now(),
    schemaType: 'test',
    data: {},
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

function makePool(options: {
  routingStrategy?: RoutingStrategy;
  failureRate?: number;
  latency?: number;
  threshold?: number;
  maxAttempts?: number;
}): WorkerPool {
  return new WorkerPool({
    workerCount: 1,
    routingStrategy: options.routingStrategy ?? 'LEAST_CONNECTIONS',
    circuitFailureThreshold: options.threshold ?? 100,
    circuitRecoveryTimeMs: 1000,
    maxRetries: options.maxAttempts ?? 3,
    mockDownstreamLatencyMs: options.latency ?? 2,
    mockDownstreamFailureRate: options.failureRate ?? 0,
    maxConcurrencyPerWorker: 5,
  });
}

describe('Bufferflow Regression Suite', () => {
  describe('Idempotency + backpressure', () => {
    it('does not burn the idempotency key when the buffer returns 503', () => {
      const session = new SimulationSession('idem-regression', 3001);
      session.bufferQueue.setCapacity(1);
      session.bufferQueue.enqueue(makePayload('filler'));

      const rejected = session.handleIngress('retry-me', 'test', {});
      expect(rejected.status).toBe(503);

      // Space frees up; the same key must now be accepted, not rejected as a duplicate.
      session.bufferQueue.clear();
      const retried = session.handleIngress('retry-me', 'test', {});
      expect(retried.status).toBe(202);

      session.destroy();
    });
  });

  describe('Dead-letter queue replay safety', () => {
    it('keeps a DLQ item when the buffer is full and replays it after space frees up', () => {
      const dlq = new DeadLetterQueue(10);
      const buffer = new BufferQueue(1);
      dlq.push(makePayload('a', { attempts: 3 }), 'error');

      buffer.enqueue(makePayload('full'));
      expect(dlq.replay('a', buffer)).toBe(false);
      expect(dlq.getById('a')).toBeDefined();

      buffer.clear();
      expect(dlq.replay('a', buffer)).toBe(true);
      expect(dlq.getById('a')).toBeUndefined();
      expect(buffer.getDepth()).toBe(1);
    });

    it('replayAll stops on backpressure and preserves the remaining records', () => {
      const dlq = new DeadLetterQueue(10);
      const buffer = new BufferQueue(2);
      dlq.push(makePayload('a', { attempts: 3 }), 'error');
      dlq.push(makePayload('b', { attempts: 3 }), 'error');

      buffer.enqueue(makePayload('full-1'));
      buffer.enqueue(makePayload('full-2'));
      expect(dlq.replayAll(buffer)).toBe(0);
      expect(dlq.size()).toBe(2);

      buffer.clear();
      expect(dlq.replayAll(buffer)).toBe(2);
      expect(dlq.size()).toBe(0);

      // Oldest-first (FIFO) replay order.
      expect(buffer.dequeue()?.id).toBe('a');
      expect(buffer.dequeue()?.id).toBe('b');
    });
  });

  describe('Retry + terminal accounting', () => {
    it('routes an item to the DLQ when its retry cannot be enqueued (buffer full)', async () => {
      const pool = makePool({ failureRate: 100, maxAttempts: 2 });
      const queue = new BufferQueue(1);
      const dlq = new DeadLetterQueue(10);

      pool.start(queue, dlq);
      queue.enqueue(makePayload('retry-full', { maxAttempts: 2 }));

      // Let the first attempt fail and schedule the retry, then remove buffer space.
      await sleep(20);
      queue.setCapacity(0);
      await sleep(250);

      expect(dlq.size()).toBe(1);
      expect(dlq.getItems().items[0]?.errorReason).toContain('Buffer full during retry');
      pool.stop();
    });

    it('reports only terminal outcomes to the metrics callback', async () => {
      const events: boolean[] = [];
      const pool = makePool({ failureRate: 0 });
      pool.setEventProcessedCallback((_item, success) => events.push(success));

      const queue = new BufferQueue(10);
      const dlq = new DeadLetterQueue(10);
      pool.start(queue, dlq);
      queue.enqueue(makePayload('ok'));

      await sleep(80);
      expect(events).toEqual([true]);
      expect(dlq.size()).toBe(0);
      expect(pool.getWorkers()[0]?.totalProcessed).toBe(1);
      pool.stop();
    });

    it('counts one failure after retries are exhausted, not one per attempt', async () => {
      const events: boolean[] = [];
      const pool = makePool({ failureRate: 100, maxAttempts: 2 });
      pool.setEventProcessedCallback((_item, success) => events.push(success));

      const queue = new BufferQueue(10);
      const dlq = new DeadLetterQueue(10);
      pool.start(queue, dlq);
      queue.enqueue(makePayload('always-fails', { maxAttempts: 2 }));

      await sleep(350);
      expect(events).toEqual([false]);
      expect(dlq.size()).toBe(1);
      expect(pool.getWorkers()[0]?.totalFailed).toBe(1);
      expect(pool.getWorkers()[0]?.totalProcessed).toBe(0);
      pool.stop();
    });

    it('still trips the circuit breaker on attempts before the terminal outcome', async () => {
      const pool = makePool({ failureRate: 100, threshold: 1, maxAttempts: 5 });
      const queue = new BufferQueue(10);
      const dlq = new DeadLetterQueue(10);

      pool.start(queue, dlq);
      queue.enqueue(makePayload('trip', { maxAttempts: 5 }));
      await sleep(40);

      const worker = pool.getWorkers()[0];
      expect(worker?.circuitState).toBe('OPEN');
      expect(worker?.totalFailed).toBe(0); // not terminal yet
      pool.stop();
    });
  });

  describe('Metrics semantics', () => {
    it('uses nearest-rank percentiles', () => {
      expect(computePercentiles([1, 2, 3, 4])).toEqual({ p50: 2, p95: 4, p99: 4 });
      const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(computePercentiles(hundred)).toEqual({ p50: 50, p95: 95, p99: 99 });
    });

    it('reports ingress latency, not downstream processing latency, in the frame', () => {
      const metrics = new MetricsCollector();
      metrics.recordIngress(2);
      metrics.recordIngress(4);
      metrics.recordIngress(6);
      metrics.recordJobProcessed(true, 80);

      const frame = metrics.tick(
        new BufferQueue(10),
        new DeadLetterQueue(10),
        [],
        'LEAST_CONNECTIONS',
        true,
        1000,
        25
      );

      expect(frame.metrics.p95LatencyMs).toBe(6);
      expect(frame.metrics.p95LatencyMs).not.toBe(80);
      expect(frame.maxConcurrencyPerWorker).toBe(25);
    });

    it('fully resets counters, RPS windows and latency samples', () => {
      const metrics = new MetricsCollector();
      for (let i = 0; i < 100; i++) metrics.recordIngress(1);
      metrics.recordJobProcessed(true, 50);

      metrics.reset();
      const frame = metrics.tick(
        new BufferQueue(10),
        new DeadLetterQueue(10),
        [],
        'LEAST_CONNECTIONS',
        true,
        1000,
        25
      );

      expect(frame.metrics.incomingRps).toBe(0);
      expect(frame.metrics.p95LatencyMs).toBe(0);
      expect(metrics.getCumulativeTotals().totalIngressed).toBe(0);
      expect(metrics.getCumulativeTotals().totalProcessed).toBe(0);
    });

    it('snapshot does not consume the metrics window', () => {
      const metrics = new MetricsCollector();
      metrics.recordIngress(3);
      metrics.recordIngress(5);
      const buffer = new BufferQueue(10);
      const dlq = new DeadLetterQueue(10);

      const snapshot = metrics.snapshot(buffer, dlq, [], 'LEAST_CONNECTIONS', true, 1000, 25);
      expect(snapshot.metrics.totalIngressed).toBe(2);

      const rolled = metrics.tick(buffer, dlq, [], 'LEAST_CONNECTIONS', true, 1000, 25);
      expect(rolled.metrics.incomingRps).toBeGreaterThan(0);
    });
  });

  describe('TrafficClient config safety', () => {
    it('ignores explicit undefined fields and keeps pacing', async () => {
      const dispatched: string[] = [];
      const client = new TrafficClient('http://127.0.0.1:3001/api/ingress', 'test', (key) => {
        dispatched.push(key);
      });

      client.start({ targetRps: 500, durationSec: 0, isUnlimited: true, failureRate: 8 });
      await sleep(30);

      const targetBefore = client.getConfig().targetRps;
      client.updateConfig({
        targetRps: undefined,
        durationSec: undefined,
        failureRate: undefined,
        isUnlimited: undefined,
        schemaType: undefined,
        downstreamLatencyMs: undefined,
        idempotencyCollisionRate: undefined,
      });

      expect(client.getConfig().targetRps).toBe(targetBefore);
      const countBefore = dispatched.length;
      await sleep(60);
      expect(dispatched.length).toBeGreaterThan(countBefore);
      client.stop();
    });
  });

  describe('Session runtime config', () => {
    it('applies failure, latency, worker count, strategy and concurrency on start', () => {
      const session = new SimulationSession('start-config', 3001);
      const result = session.startManualRun({
        failureRate: 42,
        downstreamLatencyMs: 37,
        workerCount: 4,
        routingStrategy: 'ROUND_ROBIN',
        maxConcurrencyPerWorker: 11,
      });

      expect(result.success).toBe(true);
      expect(session.config.mockDownstreamFailureRate).toBe(42);
      expect(session.config.mockDownstreamLatencyMs).toBe(37);
      expect(session.workerPool.getWorkers().length).toBe(4);
      expect(session.workerPool.getRoutingStrategy()).toBe('ROUND_ROBIN');
      expect(session.workerPool.getOptions().maxConcurrencyPerWorker).toBe(11);

      session.trafficClient.stop();
      session.destroy();
    });

    it('applies partial patches without wiping unrelated fields and clamps worker count', () => {
      const session = new SimulationSession('patch-config', 3001);
      session.applyConfigPatch({ failureRate: 25, downstreamLatencyMs: 30 });

      session.applyConfigPatch({ workerCount: 0 });
      expect(session.config.mockDownstreamFailureRate).toBe(25);
      expect(session.config.mockDownstreamLatencyMs).toBe(30);
      expect(session.workerPool.getWorkers().length).toBe(1);

      session.applyConfigPatch({ workerCount: 3, routingStrategy: 'NOPE' as any });
      expect(session.workerPool.getWorkers().length).toBe(3);
      expect(session.workerPool.getRoutingStrategy()).toBe('LEAST_CONNECTIONS');
      session.destroy();
    });
  });

  describe('Suite lifecycle', () => {
    it('returns null from stopFullSuiteTest when no suite is running', () => {
      const session = new SimulationSession('suite-none', 3001);
      expect(session.stopFullSuiteTest()).toBeNull();
      session.destroy();
    });

    it('drains accepted work between strategy steps instead of purging it', async () => {
      const session = new SimulationSession('suite-drain', 3001);
      session.startFullSuiteTest({ stepDurationSec: 2, stressLevel: 1 });

      // Wait for the first step boundary (2s + bounded drain + restart). Poll
      // rather than relying on a fixed sleep so CI load cannot make this flaky.
      const deadline = Date.now() + 8000;
      let progress = session.getSuiteProgress();
      while (Date.now() < deadline && progress?.currentStrategy === 'LEAST_CONNECTIONS') {
        await sleep(100);
        progress = session.getSuiteProgress();
      }

      expect(progress).toBeDefined();
      expect(progress?.currentStrategy).not.toBe('LEAST_CONNECTIONS');
      expect(session.bufferQueue.getDepth()).toBe(0);

      const totals = session.metricsCollector.getCumulativeTotals();
      expect(totals.totalAccepted).toBeGreaterThan(0);
      // Terminal outcomes should account for essentially all accepted work
      // (only in-flight jobs from the current step remain).
      expect(totals.totalAccepted - totals.totalProcessed - totals.totalFailed).toBeLessThan(3000);

      const results = session.stopFullSuiteTest();
      expect(results).not.toBeNull();
      session.destroy();
    });

    it('restores the pre-suite config and rejects a manual start while a suite runs', () => {
      const session = new SimulationSession('suite-restore', 3001);
      session.applyConfigPatch({
        failureRate: 9,
        downstreamLatencyMs: 21,
        workerCount: 6,
        routingStrategy: 'RANDOM',
      });

      const started = session.startFullSuiteTest({ stepDurationSec: 2, stressLevel: 4 });
      expect(started.success).toBe(true);

      // The suite temporarily applies Level 4 settings.
      expect(session.config.mockDownstreamFailureRate).toBe(28);
      expect(session.config.mockDownstreamLatencyMs).toBe(95);
      expect(session.startManualRun({}).success).toBe(false);

      const results = session.stopFullSuiteTest('stopped_by_user');
      expect(results).not.toBeNull();
      expect(session.config.mockDownstreamFailureRate).toBe(9);
      expect(session.config.mockDownstreamLatencyMs).toBe(21);
      expect(session.workerPool.getWorkers().length).toBe(6);
      expect(session.workerPool.getRoutingStrategy()).toBe('RANDOM');
      session.destroy();
    });
  });

  describe('API auth and request limits', () => {
    it('is disabled when no token is configured', () => {
      const previous = process.env[API_TOKEN_ENV];
      delete process.env[API_TOKEN_ENV];
      try {
        expect(isAuthorized({})).toBe(true);
      } finally {
        if (previous !== undefined) process.env[API_TOKEN_ENV] = previous;
      }
    });

    it('accepts bearer, x-api-token and query tokens when enabled', () => {
      const previous = process.env[API_TOKEN_ENV];
      process.env[API_TOKEN_ENV] = 'secret-token';
      try {
        expect(isAuthorized({})).toBe(false);
        expect(isAuthorized({ authorization: 'Bearer secret-token' })).toBe(true);
        expect(isAuthorized({ authorization: 'bearer secret-token' })).toBe(true);
        expect(isAuthorized({ apiToken: 'secret-token' })).toBe(true);
        expect(isAuthorized({ queryToken: 'secret-token' })).toBe(true);
        expect(isAuthorized({ authorization: 'Bearer wrong' })).toBe(false);
        expect(isAuthorized({ authorization: 'Basic c2VjcmV0' })).toBe(false);
        expect(extractApiToken({ authorization: 'Basic c2VjcmV0' })).toBeNull();
      } finally {
        if (previous === undefined) delete process.env[API_TOKEN_ENV];
        else process.env[API_TOKEN_ENV] = previous;
      }
    });

    it('protects API and websocket paths but not static assets', () => {
      expect(isProtectedPath('/api/config')).toBe(true);
      expect(isProtectedPath('/ws')).toBe(true);
      expect(isProtectedPath('/assets/index.js')).toBe(false);
      expect(isProtectedPath('/')).toBe(false);
    });

    it('enforces the configurable request body limit', () => {
      const previous = process.env[MAX_BODY_BYTES_ENV];
      process.env[MAX_BODY_BYTES_ENV] = '2048';
      try {
        expect(getMaxRequestBodyBytes()).toBe(2048);
        expect(isRequestBodyTooLarge('2048', 2048)).toBe(false);
        expect(isRequestBodyTooLarge('2049', 2048)).toBe(true);
        expect(isRequestBodyTooLarge(null, 2048)).toBe(false);
      } finally {
        if (previous === undefined) delete process.env[MAX_BODY_BYTES_ENV];
        else process.env[MAX_BODY_BYTES_ENV] = previous;
      }
      expect(getMaxRequestBodyBytes()).toBe(
        previous === undefined ? DEFAULT_MAX_BODY_BYTES : Number(previous)
      );
    });
  });

  describe('History record mapping', () => {
    it('stores manual runs as STANDARD and suites as FULL_SUITE', () => {
      const standard = toTestRunRecord({
        runId: 'run-manual',
        summary: {},
        config: { targetRps: 2000, workerCount: 8 },
      });
      expect(standard.testType).toBe('STANDARD');

      const suite = toTestRunRecord({
        runId: 'run-suite',
        testType: 'FULL_SUITE',
        summary: {},
        config: { targetRps: 2500, workerCount: 8 },
      });
      expect(suite.testType).toBe('FULL_SUITE');
    });

    it('derives tested levels from multi-level breakdowns', () => {
      expect(deriveLevelsTested({ levelBreakdowns: { 1: {}, 2: {}, 3: {} } })).toEqual([1, 2, 3]);
      expect(deriveLevelsTested({ levelsTested: [3, 1, 2] })).toEqual([1, 2, 3]);
      expect(deriveLevelsTested({})).toBeUndefined();
    });
  });
});
