import type { CircuitState, IngressPayload, RoutingStrategy, WorkerInfo, WorkerState } from './types';
import type { BufferQueue } from './buffer-queue';
import type { DeadLetterQueue } from './dlq';

export interface WorkerPoolOptions {
  workerCount: number;
  routingStrategy: RoutingStrategy;
  circuitFailureThreshold: number;
  circuitRecoveryTimeMs: number;
  maxRetries: number;
  mockDownstreamLatencyMs: number;
  mockDownstreamFailureRate: number;
}

export class WorkerPool {
  private workers: WorkerInfo[] = [];
  private routingStrategy: RoutingStrategy;
  private circuitFailureThreshold: number;
  private circuitRecoveryTimeMs: number;
  private maxRetries: number;
  private mockLatencyMs: number;
  private mockFailureRate: number;

  private isRunning: boolean = false;
  private dispatchTimer: any = null;
  private rrIndex: number = 0;
  private weightedCounter: number = 0;

  private onEventProcessed?: (item: IngressPayload, success: boolean, workerId: string) => void;

  constructor(options: WorkerPoolOptions) {
    this.routingStrategy = options.routingStrategy;
    this.circuitFailureThreshold = options.circuitFailureThreshold;
    this.circuitRecoveryTimeMs = options.circuitRecoveryTimeMs;
    this.maxRetries = options.maxRetries;
    this.mockLatencyMs = options.mockDownstreamLatencyMs;
    this.mockFailureRate = options.mockDownstreamFailureRate;

    this.initWorkers(options.workerCount);
  }

  public setEventProcessedCallback(cb: (item: IngressPayload, success: boolean, workerId: string) => void) {
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
  }

  public start(queue: BufferQueue, dlq: DeadLetterQueue): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // High frequency dispatch loop
    const dispatch = () => {
      if (!this.isRunning) return;

      this.evaluateCircuits();
      this.drainQueue(queue, dlq);

      // Schedule next dispatch tick rapidly (1ms) to handle bursts
      this.dispatchTimer = setTimeout(dispatch, 1);
    };

    dispatch();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
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
   * Selects an available worker according to the active routing strategy.
   */
  private selectWorker(): WorkerInfo | null {
    // Eligible workers: circuit is not OPEN and activeJobs < concurrency limit (e.g. 50 per worker)
    const eligible = this.workers.filter(
      (w) => w.circuitState !== 'OPEN' && w.activeJobs < 50
    );

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
        let randomWeight = (this.weightedCounter++ % totalWeight);
        for (const worker of eligible) {
          if (randomWeight < worker.weight) {
            return worker;
          }
          randomWeight -= worker.weight;
        }
        return eligible[0];
      }

      case 'ROUND_ROBIN':
      default: {
        const worker = eligible[this.rrIndex % eligible.length];
        this.rrIndex = (this.rrIndex + 1) % eligible.length;
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
      const worker = this.selectWorker();
      if (!worker) break; // All workers busy or in OPEN circuit

      const item = queue.dequeue();
      if (!item) break;

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

    if (isFailure) {
      this.handleFailure(worker, item, queue, dlq, 'Downstream 500 Internal Server Error (Simulated Outage)');
      if (this.onEventProcessed) this.onEventProcessed(item, false, worker.id);
    } else {
      this.handleSuccess(worker, item);
      if (this.onEventProcessed) this.onEventProcessed(item, true, worker.id);
    }
  }

  private handleSuccess(worker: WorkerInfo, item: IngressPayload): void {
    worker.totalProcessed++;
    worker.consecutiveFailures = 0;

    if (worker.circuitState === 'HALF_OPEN') {
      worker.consecutiveSuccesses++;
      if (worker.consecutiveSuccesses >= 3) {
        // Fully recover circuit
        worker.circuitState = 'CLOSED';
        worker.state = worker.activeJobs > 0 ? 'BUSY' : 'IDLE';
        worker.circuitTrippedAt = undefined;
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
    if (worker.circuitState === 'HALF_OPEN' || worker.consecutiveFailures >= this.circuitFailureThreshold) {
      worker.circuitState = 'OPEN';
      worker.state = 'CIRCUIT_OPEN';
      worker.circuitTrippedAt = Date.now();
    }

    // Retry handling
    item.attempts++;
    if (item.attempts < this.maxRetries) {
      // Re-enqueue with small exponential backoff
      const backoffDelay = Math.min(1000, 50 * Math.pow(2, item.attempts));
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
