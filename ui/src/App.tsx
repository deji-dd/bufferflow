import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BurstProgress, SuiteProgress, TelemetryFrame } from '../../src/core/types';
import { ControlMatrix, type TrafficConfig } from './components/ControlMatrix';
import { DagPipeline } from './components/DagPipeline';
import { DlqModal } from './components/DlqModal';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { KpiGrid } from './components/KpiGrid';
import { ResultsModal, type TestRunResults } from './components/ResultsModal';
import { type ChartDataPoint, ThroughputChart } from './components/ThroughputChart';

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

const createEmptyChartData = (): ChartDataPoint[] =>
  Array.from({ length: 25 }, (_, i) => ({
    time: `-${25 - i}s`,
    incoming: 0,
    accepted: 0,
    drained: 0,
    bufferDepth: 0,
    p95Latency: 0,
  }));

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [metrics, setMetrics] = useState<TelemetryFrame['metrics']>(INITIAL_METRICS);
  const [workers, setWorkers] = useState<TelemetryFrame['workers']>([]);
  const [routingStrategy, setRoutingStrategy] = useState<string>('LEAST_CONNECTIONS');
  const [trafficActive, setTrafficActive] = useState<boolean>(false);
  const [burstProgress, setBurstProgress] = useState<BurstProgress | undefined>(undefined);
  const [suiteProgress, setSuiteProgress] = useState<SuiteProgress | undefined>(undefined);
  const [isServerRunningTest, setIsServerRunningTest] = useState<boolean>(false);
  const [dlqModalOpen, setDlqModalOpen] = useState<boolean>(false);
  const [resultsModalOpen, setResultsModalOpen] = useState<boolean>(false);
  const [latestResults, setLatestResults] = useState<TestRunResults | null>(null);

  const [trafficConfig, setTrafficConfig] = useState<TrafficConfig>({
    targetRps: 2000,
    durationSec: 15,
    isUnlimited: false,
    failureRate: 8,
    downstreamLatencyMs: 15,
    idempotencyCollisionRate: 4,
    workerCount: 8,
    routingStrategy: 'LEAST_CONNECTIONS',
  });

  const [chartData, setChartData] = useState<ChartDataPoint[]>(createEmptyChartData);

  const previousWorkerStates = useRef<Map<string, string>>(new Map());
  const trafficActiveRef = useRef<boolean>(false);
  const isSuiteRunActiveRef = useRef<boolean>(false);
  const lastSuiteResultsRef = useRef<any>(null);
  const trafficConfigRef = useRef<TrafficConfig>(trafficConfig);
  const metricsRef = useRef<TelemetryFrame['metrics']>(metrics);
  const workersRef = useRef<TelemetryFrame['workers']>(workers);
  const runStartTimeRef = useRef<number>(0);
  const peakIncomingRpsRef = useRef<number>(0);
  const peakAcceptedRpsRef = useRef<number>(0);
  const peakDrainedRpsRef = useRef<number>(0);

  // Keep refs in sync for event listeners
  trafficActiveRef.current = trafficActive;
  trafficConfigRef.current = trafficConfig;
  metricsRef.current = metrics;
  workersRef.current = workers;

  // Initialize theme and load any prior suite results on mount
  useEffect(() => {
    const isLight = document.documentElement.classList.contains('light');
    setTheme(isLight ? 'light' : 'dark');

    fetch(`/api/traffic/suite-results?session=${SESSION_ID}`, {
      headers: { 'X-Session-Id': SESSION_ID },
    })
      .then((r) => r.json())
      .then((res) => {
        if (res && !res.error && res.testType === 'FULL_SUITE') {
          setLatestResults(res);
        }
      })
      .catch(() => {});
  }, []);

  const handleToggleTheme = () => {
    const isCurrentlyLight = document.documentElement.classList.toggle('light');
    const newTheme = isCurrentlyLight ? 'light' : 'dark';
    localStorage.setItem('bufferflow_theme', newTheme);
    setTheme(newTheme);
  };

  const addLog = useCallback((text: string, _colorClass = 'text-[#00f0ff]') => {
    console.debug(`[Bufferflow] ${text}`);
  }, []);

  const buildRunResults = useCallback(
    (
      reason: TestRunResults['completedReason'],
      finalMetrics = metricsRef.current,
      finalWorkers = workersRef.current,
      cfg = trafficConfigRef.current
    ): TestRunResults => {
      const now = Date.now();
      const start = runStartTimeRef.current || now - 15000;
      const durationSec = Math.max(1, Math.round((now - start) / 1000));

      return {
        runId: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId: SESSION_ID,
        startedAt: new Date(start).toISOString(),
        completedAt: new Date(now).toISOString(),
        durationSec,
        completedReason: reason,
        config: { ...cfg },
        summary: {
          totalIngressed: finalMetrics.totalIngressed,
          totalAccepted: finalMetrics.totalAccepted,
          totalProcessed: finalMetrics.totalProcessed,
          totalFailed: finalMetrics.totalFailed,
          peakIncomingRps: Math.max(peakIncomingRpsRef.current, finalMetrics.incomingRps),
          peakAcceptedRps: Math.max(peakAcceptedRpsRef.current, finalMetrics.acceptedRps),
          peakDrainedRps: Math.max(peakDrainedRpsRef.current, finalMetrics.drainedRps),
          p50LatencyMs: finalMetrics.p50LatencyMs,
          p95LatencyMs: finalMetrics.p95LatencyMs,
          p99LatencyMs: finalMetrics.p99LatencyMs,
          finalBufferDepth: finalMetrics.bufferDepth,
          finalDlqSize: finalMetrics.dlqSize,
        },
        workers: finalWorkers.map((w) => ({ ...w })),
      };
    },
    []
  );

  const handleStopTraffic = useCallback(
    async (reason: TestRunResults['completedReason'] = 'stopped_by_user') => {
      if (!trafficActiveRef.current) return;
      const wasSuite = isSuiteRunActiveRef.current || !!lastSuiteResultsRef.current;
      trafficActiveRef.current = false;
      isSuiteRunActiveRef.current = false;
      setTrafficActive(false);
      setIsServerRunningTest(false);
      setBurstProgress(undefined);
      setSuiteProgress(undefined);

      try {
        const res = await fetch('/api/traffic/stop', {
          method: 'POST',
          headers: { 'X-Session-Id': SESSION_ID },
        });
        const data = await res.json();
        addLog(
          `Traffic stopped (${reason.replace(/_/g, ' ')}). Total sent: ${data.totalSent ?? 0}`,
          reason.startsWith('safety') ? 'text-[#f43f5e]' : 'text-[#f59e0b]'
        );

        if (wasSuite) {
          const suiteRes = data.suiteResults || lastSuiteResultsRef.current;
          if (suiteRes && (suiteRes.testType === 'FULL_SUITE' || suiteRes.strategyBreakdown)) {
            suiteRes.completedReason = reason;
            setLatestResults(suiteRes);
            setResultsModalOpen(true);
            return;
          }
        }
      } catch (err: any) {
        addLog(`Stop request completed: ${err.message}`, 'text-[#f59e0b]');
      }

      if (wasSuite && lastSuiteResultsRef.current) {
        lastSuiteResultsRef.current.completedReason = reason;
        setLatestResults(lastSuiteResultsRef.current);
        setResultsModalOpen(true);
        return;
      }

      // Generate results and open export modal
      const results = buildRunResults(reason);
      setLatestResults(results);
      setResultsModalOpen(true);
    },
    [addLog, buildRunResults]
  );

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

          // Track peak RPS during active run
          if (frame.trafficActive) {
            peakIncomingRpsRef.current = Math.max(
              peakIncomingRpsRef.current,
              frame.metrics.incomingRps
            );
            peakAcceptedRpsRef.current = Math.max(
              peakAcceptedRpsRef.current,
              frame.metrics.acceptedRps
            );
            peakDrainedRpsRef.current = Math.max(
              peakDrainedRpsRef.current,
              frame.metrics.drainedRps
            );
          }

          if (frame.suiteProgress) {
            setSuiteProgress(frame.suiteProgress);
          }
          if (typeof frame.isServerRunningTest === 'boolean') {
            setIsServerRunningTest(frame.isServerRunningTest);
            if (frame.isServerRunningTest) {
              isSuiteRunActiveRef.current = true;
            }
          }
          if (frame.suiteResults) {
            lastSuiteResultsRef.current = frame.suiteResults;
          }

          // Check for auto-completion (trafficActive was true, now false)
          if (trafficActiveRef.current && !frame.trafficActive) {
            const wasSuite =
              isSuiteRunActiveRef.current || !!frame.suiteResults || !!lastSuiteResultsRef.current;
            trafficActiveRef.current = false;
            setTrafficActive(false);
            setBurstProgress(undefined);
            setSuiteProgress(undefined);

            if (wasSuite) {
              const fetchSuiteResults = async (retries = 6) => {
                const suiteRes = frame.suiteResults || lastSuiteResultsRef.current;
                if (
                  suiteRes &&
                  (suiteRes.testType === 'FULL_SUITE' || suiteRes.strategyBreakdown)
                ) {
                  isSuiteRunActiveRef.current = false;
                  setIsServerRunningTest(false);
                  setLatestResults(suiteRes);
                  setResultsModalOpen(true);
                  addLog(
                    'Full suite stress test completed and benchmark compiled.',
                    'text-[#10b981]'
                  );
                  return;
                }

                try {
                  const r = await fetch(`/api/traffic/suite-results?session=${SESSION_ID}`, {
                    headers: { 'X-Session-Id': SESSION_ID },
                  });
                  const res = await r.json();
                  if (
                    res &&
                    !res.error &&
                    (res.testType === 'FULL_SUITE' || res.strategyBreakdown)
                  ) {
                    isSuiteRunActiveRef.current = false;
                    setIsServerRunningTest(false);
                    setLatestResults(res);
                    setResultsModalOpen(true);
                    addLog(
                      'Full suite stress test completed and benchmark compiled.',
                      'text-[#10b981]'
                    );
                    return;
                  }
                } catch {
                  // Retry
                }

                if (retries > 0) {
                  setTimeout(() => fetchSuiteResults(retries - 1), 500);
                } else {
                  isSuiteRunActiveRef.current = false;
                  setIsServerRunningTest(false);
                }
              };

              fetchSuiteResults();
            } else {
              setIsServerRunningTest(false);
              addLog('Traffic run completed.', 'text-[#10b981]');
              const results = buildRunResults('completed', frame.metrics, frame.workers);
              setLatestResults(results);
              setResultsModalOpen(true);
            }
          } else {
            setTrafficActive(frame.trafficActive);
            trafficActiveRef.current = frame.trafficActive;
          }

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

          // Circuit breaker state change logs
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
  }, [addLog, buildRunResults]);

  // Safety Fallbacks: Tab Visibility, Window Blur, and Page Unload
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && trafficActiveRef.current) {
        addLog(
          'Safety fallback triggered: window/tab lost visibility. Stopping traffic.',
          'text-[#f43f5e]'
        );
        handleStopTraffic('safety_fallback_blur');
      }
    };

    const handleBlur = () => {
      if (trafficActiveRef.current) {
        addLog('Safety fallback triggered: window lost focus. Stopping traffic.', 'text-[#f43f5e]');
        handleStopTraffic('safety_fallback_blur');
      }
    };

    const handleBeforeUnload = () => {
      if (trafficActiveRef.current) {
        navigator.sendBeacon(`/api/traffic/stop?session=${SESSION_ID}`);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [addLog, handleStopTraffic]);

  // Live Ops Configuration Change Handler
  const handleConfigChange = (updated: Partial<TrafficConfig>) => {
    const nextConfig = { ...trafficConfig, ...updated };
    setTrafficConfig(nextConfig);
    trafficConfigRef.current = nextConfig;

    // Controls affect ops live: Push full runtime configuration to server immediately
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
        targetRps: nextConfig.targetRps,
        durationSec: nextConfig.durationSec,
        isUnlimited: nextConfig.isUnlimited,
        idempotencyCollisionRate: nextConfig.idempotencyCollisionRate,
      }),
    }).catch(() => {});
  };

  const handleStartTraffic = async () => {
    // "History" clears on new test start:
    setChartData(createEmptyChartData());
    setMetrics({
      ...INITIAL_METRICS,
      bufferCapacity: metrics.bufferCapacity || 50000,
    });
    previousWorkerStates.current.clear();
    peakIncomingRpsRef.current = 0;
    peakAcceptedRpsRef.current = 0;
    peakDrainedRpsRef.current = 0;
    runStartTimeRef.current = Date.now();

    trafficActiveRef.current = true;
    isSuiteRunActiveRef.current = false;
    setTrafficActive(true);
    setBurstProgress({
      active: true,
      elapsedSec: 0,
      durationSec: trafficConfig.durationSec,
      pct: 0,
      isUnlimited: trafficConfig.isUnlimited,
    });

    addLog(
      `Starting test run: history cleared. Target: ${trafficConfig.targetRps.toLocaleString()} RPS / ${
        trafficConfig.isUnlimited ? 'Unlimited' : `${trafficConfig.durationSec}s`
      }`,
      'text-[#00f0ff]'
    );

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
      addLog(data.message || 'Traffic burst successfully initiated.', 'text-[#10b981]');
    } catch (err: any) {
      trafficActiveRef.current = false;
      isSuiteRunActiveRef.current = false;
      setTrafficActive(false);
      setBurstProgress(undefined);
      addLog(`Failed to start traffic: ${err.message}`, 'text-[#f43f5e]');
    }
  };

  const handleStartFullTest = async () => {
    // "History" clears on new test start:
    setChartData(createEmptyChartData());
    setMetrics({
      ...INITIAL_METRICS,
      bufferCapacity: metrics.bufferCapacity || 50000,
    });
    previousWorkerStates.current.clear();
    peakIncomingRpsRef.current = 0;
    peakAcceptedRpsRef.current = 0;
    peakDrainedRpsRef.current = 0;
    runStartTimeRef.current = Date.now();
    lastSuiteResultsRef.current = null;

    isSuiteRunActiveRef.current = true;
    setIsServerRunningTest(true);
    trafficActiveRef.current = true;
    setTrafficActive(true);

    addLog(
      'Initiating Fully Automated Benchmark Matrix: all 4 levels × 7 strategies (28 benchmarks total), buffer purged between steps...',
      'text-[#a855f7]'
    );

    try {
      const res = await fetch('/api/traffic/full-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': SESSION_ID,
        },
        body: JSON.stringify({
          stepDurationSec: 3,
          runAllLevels: true,
        }),
      });
      const data = await res.json();
      addLog(data.message || 'Server full suite stress test started.', 'text-[#a855f7]');
    } catch (err: any) {
      isSuiteRunActiveRef.current = false;
      setIsServerRunningTest(false);
      trafficActiveRef.current = false;
      setTrafficActive(false);
      addLog(`Failed to start server suite test: ${err.message}`, 'text-[#f43f5e]');
    }
  };

  const handleRandomize = () => {
    const randomRps = [1500, 2200, 3000, 3800, 4500][Math.floor(Math.random() * 5)];
    const randomDuration = [10, 15, 20, 30][Math.floor(Math.random() * 4)];
    const randomFailure = [4, 8, 14, 22][Math.floor(Math.random() * 4)];
    const randomLatency = [8, 14, 25, 45][Math.floor(Math.random() * 4)];
    const randomDupe = [2, 4, 8, 12][Math.floor(Math.random() * 4)];
    const randomWorkers = [4, 8, 12, 16][Math.floor(Math.random() * 4)];
    const strategies = [
      'LEAST_CONNECTIONS',
      'WEIGHTED_ROUND_ROBIN',
      'ROUND_ROBIN',
      'POWER_OF_TWO_CHOICES',
      'WEIGHTED_LEAST_CONNECTIONS',
      'RANDOM',
      'CONSISTENT_HASH',
    ];
    const randomStrategy = strategies[Math.floor(Math.random() * strategies.length)];

    const randomized: TrafficConfig = {
      ...trafficConfig,
      targetRps: randomRps,
      durationSec: randomDuration,
      isUnlimited: false,
      failureRate: randomFailure,
      downstreamLatencyMs: randomLatency,
      idempotencyCollisionRate: randomDupe,
      workerCount: randomWorkers,
      routingStrategy: randomStrategy,
    };

    setTrafficConfig(randomized);
    trafficConfigRef.current = randomized;

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
        targetRps: randomized.targetRps,
        durationSec: randomized.durationSec,
        isUnlimited: false,
        idempotencyCollisionRate: randomized.idempotencyCollisionRate,
      }),
    }).catch(() => {});

    addLog(
      `Randomized runtime parameters: ${randomRps.toLocaleString()} RPS / ${randomDuration}s / ${randomStrategy.replace(/_/g, ' ')} / ${randomWorkers} workers`,
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
          hasResults={!!latestResults}
          onOpenResults={() => setResultsModalOpen(true)}
          trafficActive={trafficActive}
          dlqSize={metrics.dlqSize}
          onOpenDlq={() => setDlqModalOpen(true)}
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

        <ControlMatrix
          config={trafficConfig}
          trafficActive={trafficActive}
          burstProgress={burstProgress}
          suiteProgress={suiteProgress}
          isServerRunningTest={isServerRunningTest}
          onChange={handleConfigChange}
          onStart={handleStartTraffic}
          onStartFullTest={handleStartFullTest}
          onStop={() => handleStopTraffic('stopped_by_user')}
          onRandomize={handleRandomize}
        />

        <ThroughputChart
          data={chartData}
          targetRps={trafficConfig.targetRps}
          durationSec={trafficConfig.durationSec}
          downstreamLatencyMs={trafficConfig.downstreamLatencyMs}
          bufferCapacity={metrics.bufferCapacity}
        />

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

      <ResultsModal
        isOpen={resultsModalOpen}
        results={latestResults}
        onClose={() => setResultsModalOpen(false)}
      />
    </>
  );
};
