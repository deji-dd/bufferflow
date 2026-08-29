import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { BurstProgress, TelemetryFrame } from '../../src/core/types';
import { AuditLog, type LogItem } from './components/AuditLog';
import { ControlMatrix, type TrafficConfig } from './components/ControlMatrix';
import { DagPipeline } from './components/DagPipeline';
import { DlqModal } from './components/DlqModal';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { KpiGrid } from './components/KpiGrid';
import { type ChartDataPoint, ThroughputChart } from './components/ThroughputChart';
import { WorkerGrid } from './components/WorkerGrid';

const SESSION_ID = (() => {
  if (typeof window === 'undefined') return 'default';
  let id = sessionStorage.getItem('bufferflow_session_id');
  if (!id) {
    id = `sess_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem('bufferflow_session_id', id);
  }
  return id;
})();

const INITIAL_METRICS: TelemetryFrame['metrics'] = {
  incomingRps: 0,
  acceptedRps: 0,
  rateLimitedRps: 0,
  duplicateRps: 0,
  drainedRps: 0,
  bufferDepth: 0,
  bufferCapacity: 50000,
  bufferUtilizationPct: 0,
  queueLagMs: 0,
  p50LatencyMs: 0,
  p95LatencyMs: 0,
  p99LatencyMs: 0,
  dlqSize: 0,
  totalIngressed: 0,
  totalAccepted: 0,
  totalProcessed: 0,
  totalFailed: 0,
};

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [metrics, setMetrics] = useState<TelemetryFrame['metrics']>(INITIAL_METRICS);
  const [workers, setWorkers] = useState<TelemetryFrame['workers']>([]);
  const [routingStrategy, setRoutingStrategy] = useState<string>('LEAST_CONNECTIONS');
  const [trafficActive, setTrafficActive] = useState<boolean>(false);
  const [burstProgress, setBurstProgress] = useState<BurstProgress | undefined>(undefined);
  const [dlqModalOpen, setDlqModalOpen] = useState<boolean>(false);
  const [logs, setLogs] = useState<LogItem[]>([]);

  const [trafficConfig, setTrafficConfig] = useState<TrafficConfig>({
    targetRps: 2000,
    durationSec: 15,
    schemaType: 'ecommerce',
    failureRate: 8,
    downstreamLatencyMs: 15,
    idempotencyCollisionRate: 4,
    workerCount: 8,
    routingStrategy: 'LEAST_CONNECTIONS',
  });

  const [chartData, setChartData] = useState<ChartDataPoint[]>(() =>
    Array.from({ length: 25 }, (_, i) => ({
      time: `-${25 - i}s`,
      incoming: 0,
      accepted: 0,
      drained: 0,
      bufferDepth: 0,
      p95Latency: 0,
    }))
  );

  const previousWorkerStates = useRef<Map<string, string>>(new Map());

  // Initialize theme from HTML/storage
  useEffect(() => {
    const isLight = document.documentElement.classList.contains('light');
    setTheme(isLight ? 'light' : 'dark');
  }, []);

  const handleToggleTheme = () => {
    const isCurrentlyLight = document.documentElement.classList.toggle('light');
    const newTheme = isCurrentlyLight ? 'light' : 'dark';
    localStorage.setItem('bufferflow_theme', newTheme);
    setTheme(newTheme);
  };

  const addLog = (text: string, colorClass = 'text-[#00f0ff]') => {
    const time = new Date().toISOString().split('T')[1].slice(0, 8);
    const item: LogItem = {
      id: `${Date.now()}-${Math.random()}`,
      time,
      text,
      colorClass,
    };
    setLogs((prev) => [item, ...prev].slice(0, 80));
  };

  // WebSocket Connection per Session
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const isDev = window.location.port === '5173';
      const wsHost = isDev ? `${window.location.hostname}:3001` : window.location.host;
      const wsUrl = `${proto}//${wsHost}/ws?session=${SESSION_ID}`;

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        addLog(`Connected to isolated telemetry stream [${SESSION_ID}].`, 'text-[#10b981]');
      };

      ws.onmessage = (event) => {
        try {
          const frame: TelemetryFrame = JSON.parse(event.data);
          setMetrics(frame.metrics);
          setWorkers(frame.workers);
          setRoutingStrategy(frame.routingStrategy);
          setTrafficActive(frame.trafficActive);
          if (frame.burstProgress) {
            setBurstProgress(frame.burstProgress);
          }

          // Update chart rolling history smoothly
          const timeStr = new Date().toLocaleTimeString();
          setChartData((prev) => {
            const next = [
              ...prev,
              {
                time: timeStr,
                incoming: frame.metrics.incomingRps,
                accepted: frame.metrics.acceptedRps,
                drained: frame.metrics.drainedRps,
                bufferDepth: frame.metrics.bufferDepth,
                p95Latency: frame.metrics.p95LatencyMs,
              },
            ];
            return next.slice(-25);
          });

          // Circuit breaker logs
          for (const w of frame.workers) {
            const prev = previousWorkerStates.current.get(w.id);
            if (prev && prev !== w.circuitState) {
              if (w.circuitState === 'OPEN') {
                addLog(
                  `Circuit breaker TRIPPED for ${w.name}: consecutive errors exceeded limit!`,
                  'text-[#f43f5e]'
                );
              } else if (w.circuitState === 'HALF_OPEN') {
                addLog(
                  `Circuit breaker entered HALF-OPEN for ${w.name}: testing canary requests...`,
                  'text-[#f59e0b]'
                );
              } else if (w.circuitState === 'CLOSED' && prev === 'HALF_OPEN') {
                addLog(
                  `Circuit breaker RECOVERED for ${w.name}: normal routing restored.`,
                  'text-[#10b981]'
                );
              }
            }
            previousWorkerStates.current.set(w.id, w.circuitState);
          }
        } catch {
          // Ignored
        }
      };

      ws.onclose = () => {
        reconnectTimeout = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      ws?.close();
    };
  }, []);

  const handleConfigChange = (updated: Partial<TrafficConfig>) => {
    const nextConfig = { ...trafficConfig, ...updated };
    setTrafficConfig(nextConfig);

    // Sync to server if runtime cluster parameters changed
    if (
      'workerCount' in updated ||
      'routingStrategy' in updated ||
      'failureRate' in updated ||
      'downstreamLatencyMs' in updated
    ) {
      fetch('/api/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': SESSION_ID,
        },
        body: JSON.stringify({
          workerCount: nextConfig.workerCount,
          routingStrategy: nextConfig.routingStrategy,
          mockDownstreamFailureRate: nextConfig.failureRate,
          mockDownstreamLatencyMs: nextConfig.downstreamLatencyMs,
        }),
      }).catch(() => {});
    }
  };

  const handleStartTraffic = async () => {
    setTrafficActive(true);
    setBurstProgress({
      active: true,
      elapsedSec: 0,
      durationSec: trafficConfig.durationSec,
      pct: 0,
    });
    try {
      const res = await fetch('/api/traffic/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': SESSION_ID,
        },
        body: JSON.stringify(trafficConfig),
      });
      const data = await res.json();
      addLog(data.message || 'Traffic burst initiated.', 'text-[#00f0ff]');
    } catch (err: any) {
      setTrafficActive(false);
      setBurstProgress(undefined);
      addLog(`Failed to start traffic: ${err.message}`, 'text-[#f43f5e]');
    }
  };

  const handleStopTraffic = async () => {
    setTrafficActive(false);
    setBurstProgress(undefined);
    try {
      const res = await fetch('/api/traffic/stop', {
        method: 'POST',
        headers: { 'X-Session-Id': SESSION_ID },
      });
      const data = await res.json();
      addLog(`Traffic stopped. Total sent: ${data.totalSent ?? 0}`, 'text-[#f59e0b]');
    } catch (err: any) {
      addLog(`Failed to stop traffic: ${err.message}`, 'text-[#f43f5e]');
    }
  };

  const handleRandomize = () => {
    const randomRps = [1500, 2200, 3000, 3800, 4500][Math.floor(Math.random() * 5)];
    const randomDuration = [10, 15, 20, 30][Math.floor(Math.random() * 4)];
    const randomFailure = [4, 8, 14, 22][Math.floor(Math.random() * 4)];
    const randomLatency = [8, 14, 25, 45][Math.floor(Math.random() * 4)];
    const randomDupe = [2, 4, 8, 12][Math.floor(Math.random() * 4)];
    const schemas = ['ecommerce', 'fintech', 'iot'];
    const randomSchema = schemas[Math.floor(Math.random() * schemas.length)];
    const randomWorkers = [4, 8, 12, 16][Math.floor(Math.random() * 4)];
    const strategies = ['LEAST_CONNECTIONS', 'WEIGHTED_ROUND_ROBIN', 'ROUND_ROBIN'];
    const randomStrategy = strategies[Math.floor(Math.random() * strategies.length)];

    const randomized: TrafficConfig = {
      ...trafficConfig,
      targetRps: randomRps,
      durationSec: randomDuration,
      failureRate: randomFailure,
      downstreamLatencyMs: randomLatency,
      idempotencyCollisionRate: randomDupe,
      schemaType: randomSchema,
      workerCount: randomWorkers,
      routingStrategy: randomStrategy,
    };

    setTrafficConfig(randomized);

    fetch('/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': SESSION_ID,
      },
      body: JSON.stringify({
        workerCount: randomized.workerCount,
        routingStrategy: randomized.routingStrategy,
        mockDownstreamFailureRate: randomized.failureRate,
        mockDownstreamLatencyMs: randomized.downstreamLatencyMs,
      }),
    }).catch(() => {});

    addLog(
      `Randomized runtime parameters: ${randomRps.toLocaleString()} RPS / ${randomDuration}s / ${randomStrategy.replace('_', ' ')} / ${randomWorkers} workers`,
      'text-[#00f0ff]'
    );
  };

  const handleReplaySingle = async (id: string) => {
    try {
      const res = await fetch('/api/dlq/replay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': SESSION_ID,
        },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.success) {
        addLog(`Replayed DLQ task ${id} back to Buffer.`, 'text-[#10b981]');
      }
    } catch (err: any) {
      addLog(`Failed to replay item: ${err.message}`, 'text-[#f43f5e]');
    }
  };

  const handleReplayAll = async () => {
    try {
      const res = await fetch('/api/dlq/replay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': SESSION_ID,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      addLog(
        `Replayed ${data.replayedCount} dead-letter items back into Buffer.`,
        'text-[#10b981]'
      );
    } catch (err: any) {
      addLog(`Failed to replay DLQ: ${err.message}`, 'text-[#f43f5e]');
    }
  };

  const handlePurgeDlq = async () => {
    try {
      const res = await fetch('/api/dlq', {
        method: 'DELETE',
        headers: { 'X-Session-Id': SESSION_ID },
      });
      const data = await res.json();
      addLog(`Purged ${data.purgedCount} items from DLQ.`, 'text-[#f59e0b]');
    } catch (err: any) {
      addLog(`Failed to purge DLQ: ${err.message}`, 'text-[#f43f5e]');
    }
  };

  return (
    <>
      {/* Ambient glow background */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="ambient-orb absolute -top-[150px] left-[10%] w-[550px] h-[550px] rounded-full bg-[#00f0ff] opacity-15 blur-[140px]" />
        <div className="ambient-orb absolute bottom-[5%] right-[15%] w-[600px] h-[600px] rounded-full bg-[#a855f7] opacity-15 blur-[140px]" />
        <div className="ambient-orb absolute top-[40%] left-[70%] w-[450px] h-[450px] rounded-full bg-[#f43f5e] opacity-10 blur-[140px]" />
      </div>

      <div className="relative z-10 max-w-[1560px] mx-auto p-6 flex flex-col gap-6">
        <Header
          p95LatencyMs={metrics.p95LatencyMs}
          bufferCapacity={metrics.bufferCapacity}
          theme={theme}
          onToggleTheme={handleToggleTheme}
        />

        <KpiGrid
          metrics={metrics}
          trafficActive={trafficActive}
          activeTargetRps={trafficConfig.targetRps}
          workerCount={workers.length || trafficConfig.workerCount}
          onOpenDlq={() => setDlqModalOpen(true)}
        />

        <DagPipeline
          metrics={metrics}
          workers={workers}
          trafficActive={trafficActive}
          routingStrategy={routingStrategy}
        />

        <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">
          <ControlMatrix
            config={trafficConfig}
            trafficActive={trafficActive}
            burstProgress={burstProgress}
            onChange={handleConfigChange}
            onStart={handleStartTraffic}
            onStop={handleStopTraffic}
            onRandomize={handleRandomize}
          />
          <ThroughputChart
            data={chartData}
            targetRps={trafficConfig.targetRps}
            durationSec={trafficConfig.durationSec}
            downstreamLatencyMs={trafficConfig.downstreamLatencyMs}
            bufferCapacity={metrics.bufferCapacity}
          />
        </div>

        <WorkerGrid workers={workers} routingStrategy={routingStrategy} />

        <AuditLog logs={logs} onClear={() => setLogs([])} />

        <Footer />
      </div>

      <DlqModal
        isOpen={dlqModalOpen}
        sessionId={SESSION_ID}
        onClose={() => setDlqModalOpen(false)}
        onReplaySingle={handleReplaySingle}
        onReplayAll={handleReplayAll}
        onPurge={handlePurgeDlq}
      />
    </>
  );
};
