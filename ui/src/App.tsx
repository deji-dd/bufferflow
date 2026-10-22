import type React from 'react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import type { BurstProgress, SuiteProgress, TelemetryFrame } from '../../src/core/types';
import { ControlMatrix, type TrafficConfig } from './components/ControlMatrix';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { KpiGrid } from './components/KpiGrid';
import type { TestRunResults } from './components/ResultsModal';
import type { ChartDataPoint } from './components/ThroughputChart';
import { apiFetch, clearStoredToken, getStoredToken, storeToken, withAuthQuery } from './lib/api';

// Heavy panels are split into their own chunks. They are always rendered, but
// charts + the React Flow/Dagre bundle no longer inflate the initial JS chunk.
const DagPipeline = lazy(() =>
  import('./components/DagPipeline').then((module) => ({ default: module.DagPipeline }))
);
const ThroughputChart = lazy(() =>
  import('./components/ThroughputChart').then((module) => ({ default: module.ThroughputChart }))
);
const DlqModal = lazy(() =>
  import('./components/DlqModal').then((module) => ({ default: module.DlqModal }))
);
const HistoryModal = lazy(() =>
  import('./components/HistoryModal').then((module) => ({ default: module.HistoryModal }))
);
const ResultsModal = lazy(() =>
  import('./components/ResultsModal').then((module) => ({ default: module.ResultsModal }))
);

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
  const [historyModalOpen, setHistoryModalOpen] = useState<boolean>(false);
  const [historyCount, setHistoryCount] = useState<number>(0);
  const [latestResults, setLatestResults] = useState<TestRunResults | null>(null);
  const [maxConcurrencyPerWorker, setMaxConcurrencyPerWorker] = useState<number>(25);

  // Optional bearer-token gate. The server exposes /api/auth/status publicly so
  // the dashboard can discover whether BUFFERFLOW_API_TOKEN is configured.
  const [authState, setAuthState] = useState<'loading' | 'required' | 'ready'>('loading');
  const [authError, setAuthError] = useState<string>('');
  const [tokenInput, setTokenInput] = useState<string>('');

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
  // True from start until the server reports both traffic and suite idle.
  const runActiveRef = useRef<boolean>(false);
  // Set only after an active frame is observed, to avoid an in-flight idle
  // frame completing a run immediately after pressing Start.
  const sawActiveFrameRef = useRef<boolean>(false);
  // Set after an explicit stop so late "still draining" frames cannot re-open
  // the results modal.
  const suppressAutoCompleteRef = useRef<boolean>(false);
  // True when the active run is a server-managed suite.
  const suiteWasActiveRef = useRef<boolean>(false);
  const trafficConfigRef = useRef<TrafficConfig>(trafficConfig);
  const metricsRef = useRef<TelemetryFrame['metrics']>(metrics);
  const workersRef = useRef<TelemetryFrame['workers']>(workers);
  const runStartTimeRef = useRef<number>(0);
  const peakIncomingRpsRef = useRef<number>(0);
  const peakAcceptedRpsRef = useRef<number>(0);
  const peakDrainedRpsRef = useRef<number>(0);

  const refreshHistoryCount = useCallback(() => {
    apiFetch('/api/history?limit=1')
      .then((r) => r.json())
      .then((data) => {
        if (data && typeof data.total === 'number') {
          setHistoryCount(data.total);
        }
      })
      .catch(() => {});
  }, []);

  // Seed the controls with the server's effective config, and re-sync after a
  // suite finishes so restored (pre-suite) values are shown again.
  const syncConfigFromServer = useCallback(async () => {
    try {
      const [statusRes, configRes] = await Promise.all([
        apiFetch(`/api/traffic/status?session=${SESSION_ID}`, {
          headers: { 'X-Session-Id': SESSION_ID },
        }),
        apiFetch(`/api/config?session=${SESSION_ID}`, {
          headers: { 'X-Session-Id': SESSION_ID },
        }),
      ]);
      const status = await statusRes.json();
      const cfg = await configRes.json();
      if (!cfg || cfg.error) return;

      const trafficCfg = status && !status.error && status.config ? status.config : {};
      setTrafficConfig((prev) => ({
        ...prev,
        targetRps: Number.isFinite(trafficCfg.targetRps) ? trafficCfg.targetRps : prev.targetRps,
        durationSec: Number.isFinite(trafficCfg.durationSec)
          ? trafficCfg.durationSec
          : prev.durationSec,
        isUnlimited: Boolean(trafficCfg.isUnlimited),
        idempotencyCollisionRate: Number.isFinite(trafficCfg.idempotencyCollisionRate)
          ? trafficCfg.idempotencyCollisionRate
          : prev.idempotencyCollisionRate,
        failureRate: Number.isFinite(cfg.mockDownstreamFailureRate)
          ? cfg.mockDownstreamFailureRate
          : prev.failureRate,
        downstreamLatencyMs: Number.isFinite(cfg.mockDownstreamLatencyMs)
          ? cfg.mockDownstreamLatencyMs
          : prev.downstreamLatencyMs,
        workerCount: Number.isFinite(cfg.workerCount) ? cfg.workerCount : prev.workerCount,
        routingStrategy:
          typeof cfg.routingStrategy === 'string' ? cfg.routingStrategy : prev.routingStrategy,
      }));
      if (Number.isFinite(cfg.maxConcurrencyPerWorker)) {
        setMaxConcurrencyPerWorker(cfg.maxConcurrencyPerWorker);
      }
    } catch {
      // Ignore transient fetch errors
    }
  }, []);

  // Poll for the compiled suite result. The server finishes its final drain
  // after traffic stops, so completion is not instantaneous.
  const fetchSuiteResults = useCallback(async (maxAttempts: number = 12): Promise<any | null> => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await apiFetch(`/api/traffic/status?session=${SESSION_ID}`, {
          headers: { 'X-Session-Id': SESSION_ID },
        });
        const data = await res.json();
        if (data && !data.error) {
          if (data.suiteResults) return data.suiteResults;
          if (!data.isServerRunningTest && !data.active && attempt >= 2) return null;
        }
      } catch {
        // Retry
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }, []);

  const handleSelectHistoricalRun = useCallback(async (runId: string) => {
    try {
      const res = await apiFetch(`/api/history/${encodeURIComponent(runId)}`);
      const data = await res.json();
      if (data && !data.error) {
        setLatestResults(data);
        setHistoryModalOpen(false);
        setResultsModalOpen(true);
      }
    } catch (err) {
      console.warn('Failed to load historical run:', err);
    }
  }, []);

  // Keep refs in sync for event listeners
  trafficConfigRef.current = trafficConfig;
  metricsRef.current = metrics;
  workersRef.current = workers;

  // Discover whether this deployment requires a token, and validate a stored one.
  useEffect(() => {
    let cancelled = false;
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();
        if (!data?.required) {
          if (!cancelled) setAuthState('ready');
          return;
        }

        const token = getStoredToken();
        if (!token) {
          if (!cancelled) setAuthState('required');
          return;
        }

        const verify = await apiFetch('/api/config', {
          headers: { 'X-Session-Id': SESSION_ID },
        });
        if (verify.status === 401) {
          clearStoredToken();
          if (!cancelled) {
            setAuthError('The stored API token is invalid.');
            setAuthState('required');
          }
          return;
        }
        if (!cancelled) setAuthState('ready');
      } catch {
        // If the status endpoint is unreachable, let normal requests surface
        // the error rather than trapping the user on the gate forever.
        if (!cancelled) setAuthState('ready');
      }
    };

    void checkAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTokenSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const token = tokenInput.trim();
    if (!token) {
      setAuthError('Enter an API token.');
      return;
    }

    storeToken(token);
    try {
      const res = await apiFetch('/api/config', {
        headers: { 'X-Session-Id': SESSION_ID },
      });
      if (res.status === 401) {
        clearStoredToken();
        setAuthError('Invalid API token.');
        return;
      }
      window.location.reload();
    } catch {
      clearStoredToken();
      setAuthError('Could not verify the token. Check the server and try again.');
    }
  };

  // Initialize theme, load any prior suite results, and seed live config
  useEffect(() => {
    const isLight = document.documentElement.classList.contains('light');
    setTheme(isLight ? 'light' : 'dark');

    // Do not fire protected requests until the token gate has resolved.
    if (authState !== 'ready') return;

    apiFetch(`/api/traffic/suite-results?session=${SESSION_ID}`, {
      headers: { 'X-Session-Id': SESSION_ID },
    })
      .then((r) => r.json())
      .then((res) => {
        if (res && !res.error && res.testType === 'FULL_SUITE') {
          setLatestResults(res);
        }
      })
      .catch(() => {});

    refreshHistoryCount();
    void syncConfigFromServer();
  }, [authState, refreshHistoryCount, syncConfigFromServer]);

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
        testType: 'STANDARD',
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
      if (!runActiveRef.current) return;
      const wasSuite = suiteWasActiveRef.current;
      const stopReason = reason === 'completed' ? ('stopped_by_user' as const) : reason;

      runActiveRef.current = false;
      sawActiveFrameRef.current = false;
      suppressAutoCompleteRef.current = true;
      suiteWasActiveRef.current = false;
      setTrafficActive(false);
      setIsServerRunningTest(false);
      setBurstProgress(undefined);
      setSuiteProgress(undefined);

      try {
        const res = await apiFetch('/api/traffic/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Id': SESSION_ID,
          },
          body: JSON.stringify({ reason: stopReason }),
        });
        const data = await res.json();
        addLog(
          `Traffic stopped (${reason.replace(/_/g, ' ')}). Total sent: ${data.totalSent ?? 0}`,
          reason.startsWith('safety') ? 'text-[#f43f5e]' : 'text-[#f59e0b]'
        );

        if (wasSuite) {
          // The stop response normally contains the compiled suite result. If
          // the server was mid-finalize, poll the status endpoint briefly.
          const suiteRes = data.suiteResults ?? (await fetchSuiteResults());
          if (suiteRes && (suiteRes.testType === 'FULL_SUITE' || suiteRes.strategyBreakdown)) {
            suiteRes.completedReason = reason;
            setLatestResults(suiteRes);
            setResultsModalOpen(true);
            await syncConfigFromServer();
            return;
          }
        }
      } catch (err: any) {
        addLog(`Stop request completed: ${err.message}`, 'text-[#f59e0b]');
      }

      // Manual run (or a suite whose results could not be loaded): build the
      // local execution summary from the latest telemetry frame.
      const results = buildRunResults(reason);
      setLatestResults(results);
      setResultsModalOpen(true);
      apiFetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(results),
      })
        .then(() => refreshHistoryCount())
        .catch(() => {});
      await syncConfigFromServer();
    },
    [addLog, buildRunResults, fetchSuiteResults, refreshHistoryCount, syncConfigFromServer]
  );

  // WebSocket Connection per Session
  useEffect(() => {
    if (authState !== 'ready') return;

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const isDev = window.location.port === '5173';
      const wsHost = isDev ? `${window.location.hostname}:3001` : window.location.host;
      const wsUrl = withAuthQuery(`${proto}//${wsHost}/ws?session=${SESSION_ID}`);

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

          if (typeof frame.maxConcurrencyPerWorker === 'number') {
            setMaxConcurrencyPerWorker(frame.maxConcurrencyPerWorker);
          }
          if (frame.suiteProgress) {
            setSuiteProgress(frame.suiteProgress);
          }
          if (typeof frame.isServerRunningTest === 'boolean') {
            setIsServerRunningTest(frame.isServerRunningTest);
            if (frame.isServerRunningTest) {
              suiteWasActiveRef.current = true;
            }
          }
          if (frame.trafficActive || frame.isServerRunningTest) {
            if (!suppressAutoCompleteRef.current) {
              runActiveRef.current = true;
              sawActiveFrameRef.current = true;
            }
          }

          // A run is only finished once traffic AND the suite (if any) are
          // idle. During a suite's final drain traffic is already false while
          // the suite is still finalizing, so waiting here avoids fetching
          // results too early or showing stale ones.
          const justFinished =
            !suppressAutoCompleteRef.current &&
            runActiveRef.current &&
            sawActiveFrameRef.current &&
            !frame.trafficActive &&
            !frame.isServerRunningTest;

          if (justFinished) {
            const wasSuite = suiteWasActiveRef.current;
            runActiveRef.current = false;
            sawActiveFrameRef.current = false;
            suiteWasActiveRef.current = false;
            setTrafficActive(false);
            setIsServerRunningTest(false);
            setBurstProgress(undefined);
            setSuiteProgress(undefined);

            if (wasSuite) {
              void fetchSuiteResults().then(async (suiteRes) => {
                if (
                  suiteRes &&
                  (suiteRes.testType === 'FULL_SUITE' || suiteRes.strategyBreakdown)
                ) {
                  setLatestResults(suiteRes);
                  setResultsModalOpen(true);
                  addLog(
                    'Full suite stress test completed and benchmark compiled.',
                    'text-[#10b981]'
                  );
                } else {
                  addLog('Suite completed, but results are not available yet.', 'text-[#f59e0b]');
                }
                await syncConfigFromServer();
              });
            } else {
              addLog('Traffic run completed.', 'text-[#10b981]');
              const results = buildRunResults('completed', frame.metrics, frame.workers);
              setLatestResults(results);
              setResultsModalOpen(true);
              apiFetch('/api/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(results),
              })
                .then(() => refreshHistoryCount())
                .catch(() => {});
              void syncConfigFromServer();
            }
          } else {
            setTrafficActive(frame.trafficActive);
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
        if (disposed) return;
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimeout);
      ws?.close();
    };
  }, [
    addLog,
    authState,
    buildRunResults,
    fetchSuiteResults,
    refreshHistoryCount,
    syncConfigFromServer,
  ]);

  // Safety Fallbacks: Tab Visibility, Window Blur, and Page Unload
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && runActiveRef.current) {
        addLog(
          'Safety fallback triggered: window/tab lost visibility. Stopping traffic.',
          'text-[#f43f5e]'
        );
        handleStopTraffic('safety_fallback_blur');
      }
    };

    const handleBlur = () => {
      if (runActiveRef.current) {
        addLog('Safety fallback triggered: window lost focus. Stopping traffic.', 'text-[#f43f5e]');
        handleStopTraffic('safety_fallback_blur');
      }
    };

    const handleBeforeUnload = () => {
      if (runActiveRef.current) {
        const body = new Blob([JSON.stringify({ reason: 'safety_fallback_unload' })], {
          type: 'application/json',
        });
        navigator.sendBeacon(withAuthQuery(`/api/traffic/stop?session=${SESSION_ID}`), body);
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
    apiFetch('/api/config', {
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

    runActiveRef.current = true;
    sawActiveFrameRef.current = false;
    suppressAutoCompleteRef.current = false;
    suiteWasActiveRef.current = false;
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
      const res = await apiFetch('/api/traffic/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': SESSION_ID,
        },
        body: JSON.stringify(trafficConfig),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.message || data.error || 'Server rejected the traffic start request.');
      }
      addLog(data.message || 'Traffic burst successfully initiated.', 'text-[#10b981]');
    } catch (err: any) {
      runActiveRef.current = false;
      sawActiveFrameRef.current = false;
      suppressAutoCompleteRef.current = false;
      suiteWasActiveRef.current = false;
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

    suiteWasActiveRef.current = true;
    runActiveRef.current = true;
    sawActiveFrameRef.current = false;
    suppressAutoCompleteRef.current = false;
    setIsServerRunningTest(true);
    setTrafficActive(true);

    addLog(
      'Initiating Fully Automated Benchmark Matrix: all 4 levels × 7 strategies (28 benchmarks total), traffic drained between steps...',
      'text-[#a855f7]'
    );

    try {
      const res = await apiFetch('/api/traffic/full-test', {
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
      if (!res.ok || data.success === false) {
        throw new Error(data.message || data.error || 'Server rejected the suite start request.');
      }
      addLog(data.message || 'Server full suite stress test started.', 'text-[#a855f7]');
    } catch (err: any) {
      suiteWasActiveRef.current = false;
      runActiveRef.current = false;
      sawActiveFrameRef.current = false;
      suppressAutoCompleteRef.current = false;
      setIsServerRunningTest(false);
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

    apiFetch('/api/config', {
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
      const res = await apiFetch('/api/dlq/replay', {
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
      const res = await apiFetch('/api/dlq/replay', {
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
      const res = await apiFetch('/api/dlq', {
        method: 'DELETE',
        headers: { 'X-Session-Id': SESSION_ID },
      });
      const data = await res.json();
      addLog(`Purged ${data.purgedCount} items from DLQ.`, 'text-[#f59e0b]');
    } catch (err: any) {
      addLog(`Failed to purge DLQ: ${err.message}`, 'text-[#f43f5e]');
    }
  };

  if (authState === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#07090e] text-[#94a3b8] font-mono text-sm">
        Checking authorization…
      </div>
    );
  }

  if (authState === 'required') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#07090e] p-6">
        <form
          onSubmit={handleTokenSubmit}
          className="glass-card rounded-2xl p-8 w-full max-w-md flex flex-col gap-4"
        >
          <div>
            <h1 className="text-lg font-bold tracking-wider text-white">BUFFERFLOW</h1>
            <p className="text-xs text-[#94a3b8] mt-1">
              This deployment requires an API token to access the control plane.
            </p>
          </div>

          <label
            htmlFor="bufferflow-api-token"
            className="text-[10px] font-mono uppercase tracking-wider text-[#64748b]"
          >
            API token
          </label>
          <input
            id="bufferflow-api-token"
            type="password"
            autoComplete="current-password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="Bearer token"
            className="w-full bg-[#0a0e16] border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono outline-none focus:border-[#00f0ff]"
          />

          {authError && <p className="text-xs text-[#f43f5e] font-mono">{authError}</p>}

          <button
            type="submit"
            className="cursor-pointer rounded-lg border border-[#00f0ff]/40 bg-[#00f0ff]/15 px-4 py-2 text-xs font-mono font-bold text-[#00f0ff] transition hover:bg-[#00f0ff]/25"
          >
            UNLOCK DASHBOARD
          </button>

          <p className="text-[10px] font-mono text-[#64748b]">
            The token is kept in this browser&apos;s localStorage.
          </p>
        </form>
      </div>
    );
  }

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
          historyCount={historyCount}
          onOpenHistory={() => setHistoryModalOpen(true)}
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

        <Suspense
          fallback={
            <div className="glass-card rounded-2xl p-6 h-[420px] flex items-center justify-center text-xs font-mono text-[#64748b]">
              Loading architecture canvas…
            </div>
          }
        >
          <DagPipeline
            metrics={metrics}
            workers={workers}
            trafficActive={trafficActive}
            routingStrategy={routingStrategy}
            maxConcurrencyPerWorker={maxConcurrencyPerWorker}
          />
        </Suspense>

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

        <Suspense
          fallback={
            <div className="glass-card rounded-2xl p-6 h-[220px] flex items-center justify-center text-xs font-mono text-[#64748b]">
              Loading charts…
            </div>
          }
        >
          <ThroughputChart
            data={chartData}
            targetRps={trafficConfig.targetRps}
            durationSec={trafficConfig.durationSec}
            downstreamLatencyMs={trafficConfig.downstreamLatencyMs}
            bufferCapacity={metrics.bufferCapacity}
          />
        </Suspense>

        <Footer />
      </div>

      {dlqModalOpen && (
        <Suspense fallback={null}>
          <DlqModal
            isOpen={dlqModalOpen}
            sessionId={SESSION_ID}
            onClose={() => setDlqModalOpen(false)}
            onReplaySingle={handleReplaySingle}
            onReplayAll={handleReplayAll}
            onPurge={handlePurgeDlq}
          />
        </Suspense>
      )}

      {resultsModalOpen && (
        <Suspense fallback={null}>
          <ResultsModal
            isOpen={resultsModalOpen}
            results={latestResults}
            onClose={() => setResultsModalOpen(false)}
          />
        </Suspense>
      )}

      {historyModalOpen && (
        <Suspense fallback={null}>
          <HistoryModal
            isOpen={historyModalOpen}
            onClose={() => {
              setHistoryModalOpen(false);
              refreshHistoryCount();
            }}
            onSelectRun={handleSelectHistoricalRun}
          />
        </Suspense>
      )}
    </>
  );
};
