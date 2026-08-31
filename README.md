# Bufferflow

> **High-Throughput Ingress Gateway & Shock Absorber Buffer Engine**  
> Sub-10ms Ingress • In-Memory Queue Buffer • Circuit Breaking Worker Pool • DLQ Replay • Live 250ms WebSockets Telemetry

Bufferflow protects downstream microservices and databases from catastrophic failure during high-volume traffic bursts. It acts as an elastic shock absorber by accepting incoming requests in `<10ms`, performing fast token-bucket rate limiting and idempotency deduplication, buffering payloads in memory, and dispatching tasks to downstream workers using dynamic routing strategies (Least Connections, Weighted Round-Robin, Power of Two Choices, Weighted Least Connections, Random, Consistent Hashing) with automated circuit breakers, Dead-Letter Queue (DLQ), and instant JSON telemetry export.

---

## Key Architecture & Features

```mermaid
flowchart LR
    subgraph ClientLayer ["Traffic Client (Local Spawner)"]
        TC["Concurrent HTTP POSTs<br/>(Target: 100 - 5,000 req/s)"]
    end

    subgraph Gateway ["Elysia Ingress Gateway (Port 3001)"]
        RL["Token Bucket Rate Limiter"]
        IDEM["Idempotency Deduplicator (LRU Cache)"]
        ACK["202 Accepted (&lt;10ms)"]
    end

    subgraph BufferEngine ["Bufferflow Shock Absorber"]
        MEMQ["In-Memory FIFO Queue Buffer<br/>(Elastic Capacity &amp; Lag Tracker)"]
    end

    subgraph WorkerLayer ["Dynamic Worker Pool"]
        ROUTER["Router: 7 Dynamic Strategies"]
        W1["Worker 1 (Circuit Breaker)"]
        W2["Worker 2 (Circuit Breaker)"]
        WN["Worker N (Circuit Breaker)"]
    end

    subgraph Downstream ["Downstream &amp; DLQ"]
        MOCK["Downstream Mock API/DB<br/>(Simulated Latency &amp; Outages)"]
        DLQ["Dead-Letter Queue (DLQ)<br/>(Live Inspection &amp; Replay API)"]
    end

    TC -->|POST /api/ingress| RL
    RL -->|Pass / 429| IDEM
    IDEM -->|Pass / 409| ACK
    IDEM -->|Enqueue| MEMQ
    MEMQ -->|Dispatch| ROUTER
    ROUTER --> W1 & W2 & WN
    W1 & W2 & WN -->|Execute| MOCK
    W1 & W2 & WN -->|Exhausted Retries| DLQ
    DLQ -.->|Manual Replay| MEMQ
```

- **Sub-10ms Ingress SLA**: Evaluates rate-limiting rules and checks payload deduplication keys (`Idempotency-Key`), instantly returning `202 Accepted` to release the client connection.
- **In-Memory Shock Absorber**: Absorbs high-concurrency bursts (up to 50,000+ queue capacity) and shields downstream services from resource exhaustion.
- **Dynamic Routing Policies**:
  - **Least Connections**: Dynamically assigns jobs to the worker with the lowest active in-flight count.
  - **Weighted Round-Robin**: Balances tasks according to worker weight tiers.
  - **Standard Round-Robin**: Cyclic uniform task distribution.
  - **Power of Two Choices (P2C)**: Selects two random workers and routes to the one with lower load.
  - **Weighted Least Connections**: Balances active connections normalized by worker weight capacity.
  - **Random Selection**: Uniform randomized worker assignment.
  - **Consistent Hashing**: Deterministically routes by payload idempotency key for session affinity.
- **Live Ops Control Synchronization**: Runtime parameter adjustments (RPS, worker pool size, error rate, downstream latency, collision rate, routing algorithm) take effect immediately during active traffic runs.
- **Unlimited Duration Mode & Safety Fallbacks**: Support for continuous load runs with automated safety safeguards that halt traffic if the browser window or tab loses focus, becomes hidden, or closes.
- **Results Export & Copy Console**: Automated modal summary popup after run conclusion with one-click JSON copy and file download.
- **Circuit Breaker State Machine**:
  - `CLOSED`: Normal operation.
  - `OPEN`: Trips after consecutive downstream failures exceed threshold, halting traffic to the impaired worker.
  - `HALF_OPEN`: Periodically admits canary requests to verify downstream recovery.
- **Dead-Letter Queue (DLQ)**: Failed tasks exhausting retries are captured with root-cause error reasons and can be replayed back into the active buffer individually or in bulk.
- **Real-Time Telemetry & 250ms WebSocket Broadcast**:
  - Incoming RPS, Accepted RPS, Rate-Limited RPS, Drained RPS.
  - Ingress Gateway Latency (P50, P95, P99).
  - Buffer Depth, Utilization %, Queue Lag (ms).
  - Worker node statuses and circuit breaker indicators.
- **Antigravity Glassmorphic Dashboard**: Sleek cyberpunk dark UI with an interactive Canvas DAG particle stream, live rolling charts, runtime parameter controls, and randomized load presets.

---

## Quickstart

### Prerequisites
- [Bun](https://bun.sh) (v1.2+) or Docker

### 1. Install Dependencies
```bash
bun install
```

### 2. Run Test Suite
```bash
bun test
```

### 3. Start Development Server
```bash
bun run dev
```

Open your browser to:
```
http://localhost:3001
```

---

## Docker Deployment

### Run with Docker Compose
```bash
docker compose up -d --build
```

View logs:
```bash
docker compose logs -f bufferflow
```

---

## API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/ingress` | `POST` | High-speed ingress gateway returning `202 Accepted` (<10ms). Accepts optional `Idempotency-Key` header. |
| `/api/traffic/start` | `POST` | Start in-process concurrent traffic generator client. Clears prior run history. |
| `/api/traffic/stop` | `POST` / `GET` | Halt active traffic generator. |
| `/api/traffic/status` | `GET` | Get traffic generator status and current target RPS. |
| `/api/dlq` | `GET` | Paginated listing of dead-letter queue records. |
| `/api/dlq/replay` | `POST` | Replay single item (`{ "id": "..." }`) or all items back to buffer. |
| `/api/dlq` | `DELETE` | Purge dead-letter queue. |
| `/api/config` | `GET` / `POST` | Inspect or dynamically reconfigure runtime cluster parameters live. |
| `/api/metrics` | `GET` | Instantaneous system metrics snapshot. |
| `/api/metrics/reset` | `POST` | Reset cumulative counters and metrics. |
| `/ws` | `WebSocket` | Real-time 250ms telemetry broadcast stream. |
