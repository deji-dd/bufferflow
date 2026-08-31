import type { BufferQueue } from './buffer-queue';
import type { DeadLetterQueue } from './dlq';
import type { IngressPayload, RoutingStrategy, WorkerInfo } from './types';

export interface WorkerPoolOptions {
  workerCount: number;
  routingStrategy: RoutingStrategy;
  circuitFailureThreshold: number;
  circuitRecoveryTimeMs: number;
  maxRetries: number;
  mockDownstreamLatencyMs: number;
  mockDownstreamFailureRate: number;
  maxConcurrencyPerWorker?: number;
}

export class WorkerPool {
  private workers: WorkerInfo[] = [];
  private routingStrategy: RoutingStrategy;
  private circuitFailureThreshold: number;
  private circuitRecoveryTimeMs: number;
  private maxRetries: number;
  private mockLatencyMs: number;
  private mockFailureRate: number;
  private maxConcurrencyPerWorker: number;

  private isRunning: boolean = false;
  private dispatchTimer: any = null;
  private isDispatchPending: boolean = false;
  private activeQueue: BufferQueue | null = null;
  private activeDlq: DeadLetterQueue | null = null;
  private rrCounter: number = 0;
  private weightedCounter: number = 0;

  private onEventProcessed?: (item: IngressPayload, success: boolean, workerId: string) => void;

  constructor(options: WorkerPoolOptions) {
    this.routingStrategy = options.routingStrategy;
    this.circuitFailureThreshold = options.circuitFailureThreshold;
    this.circuitRecoveryTimeMs = options.circuitRecoveryTimeMs;
    this.maxRetries = options.maxRetries;
    this.mockLatencyMs = options.mockDownstreamLatencyMs;
    this.mockFailureRate = options.mockDownstreamFailureRate;
    this.maxConcurrencyPerWorker = options.maxConcurrencyPerWorker ?? 25;

    this.initWorkers(options.workerCount);
  }

  public setEventProcessedCallback(
    cb: (item: IngressPayload, success: boolean, workerId: string) => void
  ) {
    this.onEventProcessed = cb;
  }

  public initWorkers(count: number): void {
    const newWorkers: WorkerInfo[] = [];
    for (let i = 0; i < count; i++) {
      const existing = this.workers[i];
      if (existing) {
        newWorkers.push(existing);
      } else {
        // Assign diverse weights (1 to 3) for weighted round-robin demonstration
        const weight = (i % 3) + 1;
        newWorkers.push({
          id: `worker-${i + 1}`,
          name: `Worker Node ${i + 1}`,
          weight,
          state: 'IDLE',
          activeJobs: 0,
          totalProcessed: 0,
          totalFailed: 0,
          circuitState: 'CLOSED',
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
        });
      }
    }
    this.workers = newWorkers;
  }

  public updateConfig(config: Partial<WorkerPoolOptions>): void {
    if (config.workerCount !== undefined && config.workerCount !== this.workers.length) {
      this.initWorkers(config.workerCount);
    }
    if (config.routingStrategy !== undefined) {
      this.routingStrategy = config.routingStrategy;
    }
    if (config.circuitFailureThreshold !== undefined) {
      this.circuitFailureThreshold = config.circuitFailureThreshold;
    }
    if (config.circuitRecoveryTimeMs !== undefined) {
      this.circuitRecoveryTimeMs = config.circuitRecoveryTimeMs;
    }
    if (config.maxRetries !== undefined) {
      this.maxRetries = config.maxRetries;
    }
    if (config.mockDownstreamLatencyMs !== undefined) {
      this.mockLatencyMs = config.mockDownstreamLatencyMs;
    }
    if (config.mockDownstreamFailureRate !== undefined) {
      this.mockFailureRate = config.mockDownstreamFailureRate;
    }
    if (config.maxConcurrencyPerWorker !== undefined) {
      this.maxConcurrencyPerWorker = config.maxConcurrencyPerWorker;
    }
  }

  public wake(): void {
    if (!this.isRunning || !this.activeQueue || !this.activeDlq) return;
    if (this.isDispatchPending) return;

    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }

    this.isDispatchPending = true;
    queueMicrotask(() => {
      this.isDispatchPending = false;
      this.dispatch();
    });
  }

  public start(queue: BufferQueue, dlq: DeadLetterQueue): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.activeQueue = queue;
    this.activeDlq = dlq;

    // Wake dispatch loop whenever new work is enqueued
    queue.setOnEnqueueCallback(() => {
      this.wake();
    });

    this.dispatch();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    if (this.activeQueue) {
      this.activeQueue.setOnEnqueueCallback(() => {});
      this.activeQueue = null;
    }
    this.activeDlq = null;
  }

  public hasEligibleWorkers(): boolean {
    return this.workers.some((w) => {
      if (w.circuitState === 'OPEN') return false;
      if (w.circuitState === 'HALF_OPEN') return w.activeJobs === 0;
      return w.activeJobs < this.maxConcurrencyPerWorker;
    });
  }

  private dispatch(): void {
    if (!this.isRunning || !this.activeQueue || !this.activeDlq) return;

    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }

    this.evaluateCircuits();
    this.drainQueue(this.activeQueue, this.activeDlq);

    const queueDepth = this.activeQueue.getDepth();
    const hasEligible = this.hasEligibleWorkers();

    if (queueDepth > 0 && hasEligible) {
      // More items in queue and workers ready -> rapid micro-tick
      this.dispatchTimer = setTimeout(() => this.dispatch(), 0);
      return;
    }

    // Check if any circuits are in OPEN state to schedule earliest recovery transition
    let earliestRecoveryDelay: number | null = null;
    const now = Date.now();
    for (const worker of this.workers) {
      if (worker.circuitState === 'OPEN' && worker.circuitTrippedAt) {
        const remaining = Math.max(10, worker.circuitTrippedAt + this.circuitRecoveryTimeMs - now);
        if (earliestRecoveryDelay === null || remaining < earliestRecoveryDelay) {
          earliestRecoveryDelay = remaining;
        }
      }
    }

    if (earliestRecoveryDelay !== null) {
      this.dispatchTimer = setTimeout(() => this.dispatch(), earliestRecoveryDelay);
      return;
    }

    // When idle (0 items, 0 eligible or idle workers, no open circuits),
    // sleep with a relaxed 1000ms safety heartbeat. Any enqueue or job completion calls wake().
    this.dispatchTimer = setTimeout(() => this.dispatch(), 1000);
  }

  /**
   * Evaluate circuit breaker states and transitions (OPEN -> HALF_OPEN).
   */
  private evaluateCircuits(): void {
    const now = Date.now();
    for (const worker of this.workers) {
      if (worker.circuitState === 'OPEN' && worker.circuitTrippedAt) {
        if (now - worker.circuitTrippedAt >= this.circuitRecoveryTimeMs) {
          worker.circuitState = 'HALF_OPEN';
          worker.consecutiveSuccesses = 0;
          worker.state = 'HALF_OPEN';
        }
      }
    }
  }

  /**
   * Reset worker counters when starting a new test run.
   */
  public resetCounters(): void {
    this.rrCounter = 0;
    this.weightedCounter = 0;
    for (const worker of this.workers) {
      worker.totalProcessed = 0;
      worker.totalFailed = 0;
      worker.consecutiveFailures = 0;
      worker.consecutiveSuccesses = 0;
      worker.circuitState = 'CLOSED';
      worker.state = worker.activeJobs > 0 ? 'BUSY' : 'IDLE';
      worker.circuitTrippedAt = undefined;
    }
  }

  /**
   * Cleans up transient failures and resets rotation counters when switching strategy phases.
   */
  public resetStrategyWindow(): void {
    this.rrCounter = 0;
    this.weightedCounter = 0;
    for (const worker of this.workers) {
      worker.consecutiveFailures = 0;
      worker.consecutiveSuccesses = 0;
      if (worker.circuitState !== 'CLOSED') {
        worker.circuitState = 'CLOSED';
        worker.state = worker.activeJobs > 0 ? 'BUSY' : 'IDLE';
        worker.circuitTrippedAt = undefined;
      }
    }
  }

  public getActiveJobCount(): number {
    return this.workers.reduce((sum, w) => sum + w.activeJobs, 0);
  }

  /**
   * Selects an available worker according to the active routing strategy.
   */
  private selectWorker(item?: IngressPayload): WorkerInfo | null {
    // Eligible workers:
    // - If circuit is CLOSED: activeJobs < concurrency limit
    // - If circuit is HALF_OPEN: only 1 probe job at a time (activeJobs === 0)
    // - If circuit is OPEN: ineligible
    const eligible = this.workers.filter((w) => {
      if (w.circuitState === 'OPEN') return false;
      if (w.circuitState === 'HALF_OPEN') return w.activeJobs === 0;
      return w.activeJobs < this.maxConcurrencyPerWorker;
    });

    if (eligible.length === 0) return null;

    switch (this.routingStrategy) {
      case 'LEAST_CONNECTIONS': {
        let best = eligible[0];
        for (let i = 1; i < eligible.length; i++) {
          if (eligible[i].activeJobs < best.activeJobs) {
            best = eligible[i];
          }
        }
        return best;
      }

      case 'WEIGHTED_ROUND_ROBIN': {
        // Build weighted pool or select using smooth weighted distribution
        const totalWeight = eligible.reduce((sum, w) => sum + w.weight, 0);
        let randomWeight = this.weightedCounter++ % totalWeight;
        for (const worker of eligible) {
          if (randomWeight < worker.weight) {
            return worker;
          }
          randomWeight -= worker.weight;
        }
        return eligible[0];
      }

      case 'WEIGHTED_LEAST_CONNECTIONS': {
        // Balances active connections by worker weight capacity
        let best = eligible[0];
        let bestScore = best.activeJobs / Math.max(1, best.weight);
        for (let i = 1; i < eligible.length; i++) {
          const score = eligible[i].activeJobs / Math.max(1, eligible[i].weight);
          if (score < bestScore) {
            best = eligible[i];
            bestScore = score;
          }
        }
        return best;
      }

      case 'POWER_OF_TWO_CHOICES': {
        // Mitzenmacher's P2C: pick 2 random workers, select the least loaded
        if (eligible.length <= 2) {
          return eligible[0].activeJobs <= (eligible[1]?.activeJobs ?? Infinity)
            ? eligible[0]
            : eligible[1];
        }
        const idx1 = Math.floor(Math.random() * eligible.length);
        let idx2 = Math.floor(Math.random() * (eligible.length - 1));
        if (idx2 >= idx1) idx2++;
        const w1 = eligible[idx1];
        const w2 = eligible[idx2];
        return w1.activeJobs <= w2.activeJobs ? w1 : w2;
      }

      case 'RANDOM': {
        // Uniform random selection among healthy workers
        return eligible[Math.floor(Math.random() * eligible.length)];
      }

      case 'CONSISTENT_HASH': {
        // Deterministic hash mod eligible workers for key/session affinity
        const key = item?.idempotencyKey || item?.id || 'default';
        let hash = 0;
        for (let i = 0; i < key.length; i++) {
          hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
        }
        return eligible[hash % eligible.length];
      }

      case 'ROUND_ROBIN': {
        const worker = eligible[this.rrCounter % eligible.length];
        this.rrCounter = (this.rrCounter + 1) >>> 0;
        return worker;
      }

      default: {
        const worker = eligible[this.rrCounter % eligible.length];
        this.rrCounter = (this.rrCounter + 1) >>> 0;
        return worker;
      }
    }
  }

  /**
   * Drains ready items from the buffer queue and dispatches them to selected workers.
   */
  private drainQueue(queue: BufferQueue, dlq: DeadLetterQueue): void {
    // Process up to 50 items per dispatch cycle to prevent starvation
    let iterations = 0;
    while (queue.getDepth() > 0 && iterations < 50) {
      const item = queue.peek();
      if (!item) break;

      const worker = this.selectWorker(item);
      if (!worker) break; // All workers busy or in OPEN circuit

      queue.dequeue();
      this.executeJob(worker, item, queue, dlq);
      iterations++;
    }
  }

  /**
   * Execute job against simulated mock downstream endpoint.
   */
  private async executeJob(
    worker: WorkerInfo,
    item: IngressPayload,
    queue: BufferQueue,
    dlq: DeadLetterQueue
  ): Promise<void> {
    worker.activeJobs++;
    worker.state = worker.circuitState === 'HALF_OPEN' ? 'HALF_OPEN' : 'BUSY';

    // Simulate mock downstream network latency with jitter
    const jitter = Math.floor(Math.random() * 8) - 4;
    const latency = Math.max(2, this.mockLatencyMs + jitter);

    await new Promise((resolve) => setTimeout(resolve, latency));

    // Simulate downstream error based on configured failure rate
    const isFailure = Math.random() * 100 < this.mockFailureRate;

    worker.activeJobs--;
    if (worker.activeJobs === 0 && worker.circuitState !== 'OPEN') {
      worker.state = worker.circuitState === 'HALF_OPEN' ? 'HALF_OPEN' : 'IDLE';
    }

    try {
      if (isFailure) {
        this.handleFailure(
          worker,
          item,
          queue,
          dlq,
          'Downstream 500 Internal Server Error (Simulated Outage)'
        );
        if (this.onEventProcessed) this.onEventProcessed(item, false, worker.id);
      } else {
        this.handleSuccess(worker, item);
        if (this.onEventProcessed) this.onEventProcessed(item, true, worker.id);
      }
    } finally {
      this.wake();
    }
  }

  private handleSuccess(worker: WorkerInfo, _item: IngressPayload): void {
    worker.totalProcessed++;
    worker.consecutiveFailures = 0;

    if (worker.circuitState === 'HALF_OPEN') {
      worker.consecutiveSuccesses++;
      if (worker.consecutiveSuccesses >= 2) {
        // Fully recover circuit to CLOSED
        worker.circuitState = 'CLOSED';
        worker.state = worker.activeJobs > 0 ? 'BUSY' : 'IDLE';
        worker.circuitTrippedAt = undefined;
        worker.consecutiveFailures = 0;
      }
    }
  }

  private handleFailure(
    worker: WorkerInfo,
    item: IngressPayload,
    queue: BufferQueue,
    dlq: DeadLetterQueue,
    reason: string
  ): void {
    worker.totalFailed++;
    worker.consecutiveFailures++;
    worker.consecutiveSuccesses = 0;

    // Circuit Breaker check
    if (
      worker.circuitState === 'HALF_OPEN' ||
      worker.consecutiveFailures >= this.circuitFailureThreshold
    ) {
      worker.circuitState = 'OPEN';
      worker.state = 'CIRCUIT_OPEN';
      worker.circuitTrippedAt = Date.now();
    }

    // Retry handling
    item.attempts++;
    if (item.attempts < this.maxRetries) {
      // Re-enqueue with small exponential backoff
      const backoffDelay = Math.min(1000, 50 * 2 ** item.attempts);
      setTimeout(() => {
        queue.enqueue(item);
      }, backoffDelay);
    } else {
      // Retries exhausted -> route to DLQ!
      dlq.push(item, `${reason} (Exhausted ${item.attempts} retries)`);
    }
  }

  public getWorkers(): WorkerInfo[] {
    return this.workers.map((w) => ({ ...w }));
  }

  public getRoutingStrategy(): RoutingStrategy {
    return this.routingStrategy;
  }
}
