// Bufferflow TypeScript Frontend Client
import type { TelemetryFrame, WorkerInfo } from '../../src/core/types';

declare global {
  interface Window {
    bufferflowReplayItem: (id: string) => Promise<void>;
  }
}

// --- State & History ---
let ws: WebSocket | null = null;
let reconnectTimer: any = null;
let isTrafficActive = false;
const previousWorkerStates = new Map<string, string>();

const MAX_HISTORY = 50;
const historyData = {
  incoming: new Array(MAX_HISTORY).fill(0),
  accepted: new Array(MAX_HISTORY).fill(0),
  drained: new Array(MAX_HISTORY).fill(0),
  bufferDepth: new Array(MAX_HISTORY).fill(0),
  p95Latency: new Array(MAX_HISTORY).fill(0),
  p99Latency: new Array(MAX_HISTORY).fill(0),
};

// --- DOM Elements Cache ---
function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T;
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

// --- WebSocket Connection ---
function connectWebSocket(): void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // In dev with Vite, the proxy forwards /ws to ws://localhost:3001
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  setWsStatus('connecting');

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setWsStatus('connected');
      addLogEntry(
        'WebSocket Telemetry link established (250ms broadcast active)',
        'text-[#10b981]'
      );
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const frame: TelemetryFrame = JSON.parse(event.data);
        handleTelemetryFrame(frame);
      } catch (e) {
        console.error('Failed to parse telemetry frame:', e);
      }
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      setWsStatus('disconnected');
      ws?.close();
    };
  } catch {
    setWsStatus('disconnected');
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 2000);
}

function setWsStatus(status: 'connected' | 'connecting' | 'disconnected'): void {
  const wsIndicator = getEl('ws-indicator');
  if (status === 'connected') {
    wsIndicator.innerHTML = '<span class="status-dot pulse-cyan"></span> CONNECTED';
    wsIndicator.className =
      'font-mono text-base font-semibold text-[#00f0ff] flex items-center gap-1.5';
  } else if (status === 'connecting') {
    wsIndicator.innerHTML = '<span class="status-dot bg-[#f59e0b]"></span> CONNECTING';
    wsIndicator.className =
      'font-mono text-base font-semibold text-[#f59e0b] flex items-center gap-1.5';
  } else {
    wsIndicator.innerHTML = '<span class="status-dot bg-[#f43f5e]"></span> RECONNECTING';
    wsIndicator.className =
      'font-mono text-base font-semibold text-[#f43f5e] flex items-center gap-1.5';
  }
}

// --- Telemetry Ingestion ---
function handleTelemetryFrame(frame: TelemetryFrame): void {
  const { metrics, workers, routingStrategy, trafficActive, activeTargetRps } = frame;
  isTrafficActive = trafficActive;

  // 1. Header
  getEl('header-p95').textContent = `${metrics.p95LatencyMs.toFixed(2)} ms`;
  getEl('header-buf-cap').textContent = metrics.bufferCapacity.toLocaleString();

  // 2. Top KPIs
  getEl('kpi-incoming-rps').textContent = metrics.incomingRps.toLocaleString();
  getEl('kpi-accepted-rps').textContent = metrics.acceptedRps.toLocaleString();
  getEl('kpi-rateltd-rps').textContent = metrics.rateLimitedRps.toLocaleString();

  const trafficStatus = getEl('kpi-traffic-status');
  trafficStatus.textContent = trafficActive ? `${activeTargetRps} RPS` : 'IDLE';
  trafficStatus.className = trafficActive
    ? 'text-xs font-mono font-semibold px-2 py-0.5 rounded bg-[rgba(0,240,255,0.12)] text-[#00f0ff] border border-[rgba(0,240,255,0.3)]'
    : 'text-xs font-mono font-semibold px-2 py-0.5 rounded bg-[rgba(245,158,11,0.12)] text-[#f59e0b] border border-[rgba(245,158,11,0.3)]';

  getEl('kpi-buffer-depth').textContent = metrics.bufferDepth.toLocaleString();
  getEl('kpi-utilization').textContent = `${metrics.bufferUtilizationPct}% FULL`;
  getEl('kpi-queue-lag').textContent = `${metrics.queueLagMs} ms`;

  getEl('kpi-drained-rps').textContent = metrics.drainedRps.toLocaleString();
  getEl('kpi-active-workers').textContent = String(workers.length);
  getEl('kpi-total-processed').textContent = metrics.totalProcessed.toLocaleString();
  getEl('kpi-routing-badge').textContent = routingStrategy.replace('_', ' ');

  getEl('kpi-dlq-count').textContent = metrics.dlqSize.toLocaleString();
  const dlqBadge = getEl('kpi-dlq-badge');
  dlqBadge.textContent = metrics.dlqSize > 0 ? `${metrics.dlqSize} FAILS` : '0 FAILS';
  dlqBadge.className =
    metrics.dlqSize > 0
      ? 'text-xs font-mono font-semibold px-2 py-0.5 rounded bg-[rgba(244,63,94,0.12)] text-[#f43f5e] border border-[rgba(244,63,94,0.3)]'
      : 'text-xs font-mono font-semibold px-2 py-0.5 rounded bg-[rgba(16,185,129,0.12)] text-[#10b981] border border-[rgba(16,185,129,0.3)]';

  getEl('kpi-dupe-count').textContent = metrics.duplicateRps.toLocaleString();

  // 3. DAG Overlays
  getEl('dag-traffic-val').textContent = trafficActive ? `${metrics.incomingRps} req/s` : '0 req/s';
  getEl('dag-badge-traffic').textContent = trafficActive ? 'BURSTING' : 'IDLE';

  getEl('dag-ingress-val').textContent =
    `P50: ${metrics.p50LatencyMs}ms • P95: ${metrics.p95LatencyMs}ms`;
  getEl('dag-buffer-val').textContent =
    `${metrics.bufferDepth} tasks (${metrics.queueLagMs}ms lag)`;
  getEl('dag-badge-buffer').textContent = `${metrics.bufferUtilizationPct}% FULL`;

  const busyWorkers = workers.filter((w) => w.activeJobs > 0).length;
  getEl('dag-router-val').textContent = `${busyWorkers}/${workers.length} Active`;
  getEl('dag-badge-router').textContent = routingStrategy.replace('_', ' ');

  const openCount = workers.filter((w) => w.circuitState === 'OPEN').length;
  const halfCount = workers.filter((w) => w.circuitState === 'HALF_OPEN').length;
  const closedCount = workers.length - openCount - halfCount;

  const dagDownstreamBadge = getEl('dag-badge-downstream');
  if (openCount > 0) {
    getEl('dag-downstream-val').textContent = `${openCount} Trips`;
    dagDownstreamBadge.textContent = 'DEGRADED';
    dagDownstreamBadge.className =
      'absolute -top-2 right-2 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#f43f5e]/20 text-[#f43f5e] border border-[#f43f5e]';
  } else if (halfCount > 0) {
    getEl('dag-downstream-val').textContent = 'Recovering';
    dagDownstreamBadge.textContent = 'HALF-OPEN';
    dagDownstreamBadge.className =
      'absolute -top-2 right-2 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#f59e0b]/20 text-[#f59e0b] border border-[#f59e0b]';
  } else {
    getEl('dag-downstream-val').textContent = `${metrics.drainedRps} 200 OK/s`;
    dagDownstreamBadge.textContent = 'HEALTHY';
    dagDownstreamBadge.className =
      'absolute -top-2 right-2 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#10b981]/20 text-[#10b981] border border-[#10b981]';
  }

  getEl('dag-dlq-val').textContent = `${metrics.dlqSize} fails`;

  // 4. Button States
  (getEl('btn-start-traffic') as HTMLButtonElement).disabled = trafficActive;
  (getEl('btn-stop-traffic') as HTMLButtonElement).disabled = !trafficActive;

  // 5. Worker Grid
  updateWorkerGrid(workers);
  getEl('summary-closed-circuits').textContent = `${closedCount} Healthy`;
  getEl('summary-half-circuits').textContent = `${halfCount} Half-Open`;
  getEl('summary-open-circuits').textContent = `${openCount} Tripped`;

  // 6. Push Chart History
  pushHistory(metrics);

  // 7. Audit System Events
  checkSystemEvents(metrics, workers);
}

function pushHistory(metrics: TelemetryFrame['metrics']): void {
  historyData.incoming.shift();
  historyData.incoming.push(metrics.incomingRps);

  historyData.accepted.shift();
  historyData.accepted.push(metrics.acceptedRps);

  historyData.drained.shift();
  historyData.drained.push(metrics.drainedRps);

  historyData.bufferDepth.shift();
  historyData.bufferDepth.push(metrics.bufferDepth);

  historyData.p95Latency.shift();
  historyData.p95Latency.push(metrics.p95LatencyMs);

  historyData.p99Latency.shift();
  historyData.p99Latency.push(metrics.p99LatencyMs);
}

// --- Worker Grid Rendering ---
function updateWorkerGrid(workers: WorkerInfo[]): void {
  const grid = getEl('worker-grid');

  if (grid.children.length !== workers.length) {
    grid.innerHTML = '';
    for (const w of workers) {
      const card = document.createElement('div');
      card.id = `card-${w.id}`;
      card.className =
        'bg-[#0a0e16]/80 border border-white/10 rounded-xl p-3.5 flex flex-col gap-2 transition hover:-translate-y-0.5';
      card.innerHTML = `
        <div class="flex justify-between items-center">
          <div class="text-xs font-semibold flex items-center gap-1.5">
            <span class="status-dot" id="dot-${w.id}"></span>
            <span>${w.name}</span>
          </div>
          <span class="text-[10px] font-mono bg-white/10 px-1.5 py-0.5 rounded text-[#94a3b8]">W: ${w.weight}</span>
        </div>
        <div class="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div class="h-full bg-[#00f0ff] transition-all" id="bar-${w.id}" style="width: 0%;"></div>
        </div>
        <div class="flex justify-between text-[11px] font-mono text-[#94a3b8]">
          <span>Inflight: <b class="text-white" id="jobs-${w.id}">0</b></span>
          <span>State: <b id="state-${w.id}">IDLE</b></span>
        </div>
        <div class="flex justify-between text-[11px] font-mono text-[#94a3b8]">
          <span>Done: <b class="text-[#10b981]" id="done-${w.id}">0</b></span>
          <span>Fails: <b class="text-[#f43f5e]" id="fails-${w.id}">0</b></span>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  for (const w of workers) {
    const card = document.getElementById(`card-${w.id}`);
    const dot = document.getElementById(`dot-${w.id}`);
    const bar = document.getElementById(`bar-${w.id}`);
    const jobs = document.getElementById(`jobs-${w.id}`);
    const stateEl = document.getElementById(`state-${w.id}`);
    const done = document.getElementById(`done-${w.id}`);
    const fails = document.getElementById(`fails-${w.id}`);

    if (!card || !dot || !bar || !jobs || !stateEl || !done || !fails) continue;

    jobs.textContent = String(w.activeJobs);
    done.textContent = w.totalProcessed.toLocaleString();
    fails.textContent = w.totalFailed.toLocaleString();

    const pct = Math.min(100, (w.activeJobs / 20) * 100);
    bar.style.width = `${pct}%`;

    if (w.circuitState === 'OPEN') {
      card.className =
        'bg-[#f43f5e]/10 border border-[#f43f5e]/60 rounded-xl p-3.5 flex flex-col gap-2';
      dot.className = 'status-dot dot-rose';
      bar.style.background = '#f43f5e';
      stateEl.textContent = 'CIRCUIT OPEN';
      stateEl.className = 'text-[#f43f5e]';
    } else if (w.circuitState === 'HALF_OPEN') {
      card.className =
        'bg-[#f59e0b]/10 border border-[#f59e0b]/60 rounded-xl p-3.5 flex flex-col gap-2';
      dot.className = 'status-dot dot-amber';
      bar.style.background = '#f59e0b';
      stateEl.textContent = 'HALF-OPEN';
      stateEl.className = 'text-[#f59e0b]';
    } else if (w.activeJobs > 0) {
      card.className =
        'bg-[#0a0e16]/80 border border-white/10 rounded-xl p-3.5 flex flex-col gap-2';
      dot.className = 'status-dot pulse-cyan';
      bar.style.background = '#00f0ff';
      stateEl.textContent = 'PROCESSING';
      stateEl.className = 'text-[#00f0ff]';
    } else {
      card.className =
        'bg-[#0a0e16]/80 border border-white/10 rounded-xl p-3.5 flex flex-col gap-2';
      dot.className = 'status-dot dot-emerald';
      bar.style.background = '#00f0ff';
      stateEl.textContent = 'IDLE';
      stateEl.className = 'text-[#94a3b8]';
    }
  }
}

// --- Audit Log Stream ---
function checkSystemEvents(metrics: TelemetryFrame['metrics'], workers: WorkerInfo[]): void {
  if (metrics.rateLimitedRps > 0 && Math.random() < 0.15) {
    addLogEntry(
      `Rate limiter threshold reached: dropped ${metrics.rateLimitedRps} req/s (HTTP 429)`,
      'text-[#f59e0b]'
    );
  }
  if (metrics.duplicateRps > 0 && Math.random() < 0.15) {
    addLogEntry(
      `Idempotency collision detected: deduplicated ${metrics.duplicateRps} redundant requests (HTTP 409)`,
      'text-[#00f0ff]'
    );
  }

  for (const w of workers) {
    const prev = previousWorkerStates.get(w.id);
    if (prev && prev !== w.circuitState) {
      if (w.circuitState === 'OPEN') {
        addLogEntry(
          `⚠️ Circuit breaker TRIPPED for ${w.name}: consecutive errors exceeded limit!`,
          'text-[#f43f5e]'
        );
      } else if (w.circuitState === 'HALF_OPEN') {
        addLogEntry(
          `🔄 Circuit breaker entered HALF-OPEN for ${w.name}: testing canary requests...`,
          'text-[#f59e0b]'
        );
      } else if (w.circuitState === 'CLOSED' && prev === 'HALF_OPEN') {
        addLogEntry(
          `✅ Circuit breaker RECOVERED for ${w.name}: normal routing restored.`,
          'text-[#10b981]'
        );
      }
    }
    previousWorkerStates.set(w.id, w.circuitState);
  }
}

function addLogEntry(text: string, colorClass = 'text-[#00f0ff]'): void {
  const feed = getEl('terminal-feed');
  const entry = document.createElement('div');
  entry.className = `flex gap-2.5 leading-snug ${colorClass}`;

  const now = new Date();
  const timeStr = `${now.toTimeString().split(' ')[0]}.${String(now.getMilliseconds()).padStart(3, '0')}`;

  entry.innerHTML = `<span class="text-[#64748b] whitespace-nowrap">[${timeStr}]</span> <span>${text}</span>`;
  feed.appendChild(entry);

  if (feed.children.length > 80) {
    feed.removeChild(feed.children[0]);
  }
  feed.scrollTop = feed.scrollHeight;
}

// --- Canvas Animated DAG ---
class Particle {
  public progress: number = 0;
  public speed: number;

  constructor(
    public startNode: string,
    public endNode: string,
    public color: string
  ) {
    this.speed = 0.015 + Math.random() * 0.02;
  }

  public update(speedMultiplier: number): boolean {
    this.progress += this.speed * speedMultiplier;
    return this.progress < 1;
  }

  public draw(
    ctx: CanvasRenderingContext2D,
    nodeCoords: Record<string, { x: number; y: number }>
  ): void {
    const p1 = nodeCoords[this.startNode];
    const p2 = nodeCoords[this.endNode];
    if (!p1 || !p2) return;

    const x = p1.x + (p2.x - p1.x) * this.progress;
    const y = p1.y + (p2.y - p1.y) * this.progress;

    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

let particles: Particle[] = [];
const dagNodes: Record<string, { x: number; y: number }> = {
  traffic: { x: 0.05, y: 0.5 },
  ingress: { x: 0.23, y: 0.5 },
  buffer: { x: 0.45, y: 0.5 },
  router: { x: 0.65, y: 0.5 },
  downstream: { x: 0.88, y: 0.28 },
  dlq: { x: 0.88, y: 0.72 },
};

function initDagCanvas(): void {
  const canvas = getEl<HTMLCanvasElement>('dag-canvas');
  const ctx = canvas.getContext('2d')!;

  function resize(): void {
    if (!canvas.parentElement) return;
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  const links = [
    { from: 'traffic', to: 'ingress' },
    { from: 'ingress', to: 'buffer' },
    { from: 'buffer', to: 'router' },
    { from: 'router', to: 'downstream' },
    { from: 'router', to: 'dlq' },
  ];

  function render(): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const coords: Record<string, { x: number; y: number }> = {};
    for (const [key, pt] of Object.entries(dagNodes)) {
      coords[key] = {
        x: pt.x * canvas.width,
        y: pt.y * canvas.height,
      };
    }

    for (const link of links) {
      const p1 = coords[link.from];
      const p2 = coords[link.to];
      if (!p1 || !p2) continue;

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const latestIncoming = historyData.incoming[historyData.incoming.length - 1] || 0;
    const latestDrained = historyData.drained[historyData.drained.length - 1] || 0;

    if (latestIncoming > 0 && Math.random() < 0.6) {
      particles.push(new Particle('traffic', 'ingress', '#00f0ff'));
      particles.push(new Particle('ingress', 'buffer', '#a855f7'));
    }
    if (latestDrained > 0 && Math.random() < 0.6) {
      particles.push(new Particle('buffer', 'router', '#10b981'));
      particles.push(new Particle('router', 'downstream', '#10b981'));
    }

    const dlqVal = Number(getEl('kpi-dlq-count').textContent) || 0;
    if (dlqVal > 0 && Math.random() < 0.08) {
      particles.push(new Particle('router', 'dlq', '#f43f5e'));
    }

    const speedMultiplier = isTrafficActive ? 1.5 : 0.8;
    particles = particles.filter((p) => {
      const alive = p.update(speedMultiplier);
      if (alive) p.draw(ctx, coords);
      return alive;
    });

    requestAnimationFrame(render);
  }

  render();
}

// --- Real-time Rolling Canvas Charts ---
function initCharts(): void {
  const c1 = getEl<HTMLCanvasElement>('chart-throughput');
  const ctx1 = c1.getContext('2d')!;
  const c2 = getEl<HTMLCanvasElement>('chart-buffer-lat');
  const ctx2 = c2.getContext('2d')!;

  function resize(): void {
    if (c1.parentElement && c2.parentElement) {
      c1.width = c1.parentElement.clientWidth;
      c1.height = c1.parentElement.clientHeight;
      c2.width = c2.parentElement.clientWidth;
      c2.height = c2.parentElement.clientHeight;
    }
  }
  window.addEventListener('resize', resize);
  resize();

  function drawLine(
    ctx: CanvasRenderingContext2D,
    data: number[],
    color: string,
    width = 2,
    fillGradient: CanvasGradient | null = null,
    maxValOverride: number | null = null
  ): void {
    if (!data || data.length < 2) return;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const max = maxValOverride !== null ? maxValOverride : Math.max(10, ...data) * 1.15;

    ctx.beginPath();
    const step = w / (data.length - 1);

    data.forEach((val, i) => {
      const x = i * step;
      const y = h - (val / max) * (h - 20) - 10;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    if (fillGradient) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = fillGradient;
      ctx.fill();
      ctx.beginPath();
      data.forEach((val, i) => {
        const x = i * step;
        const y = h - (val / max) * (h - 20) - 10;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function drawGrid(ctx: CanvasRenderingContext2D): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let y = 20; y < h; y += 35) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  function renderCharts(): void {
    // Chart 1: Throughput
    drawGrid(ctx1);
    const maxRps = Math.max(
      100,
      ...historyData.incoming,
      ...historyData.accepted,
      ...historyData.drained
    );
    drawLine(ctx1, historyData.incoming, '#00f0ff', 2, null, maxRps);
    drawLine(ctx1, historyData.accepted, '#a855f7', 2, null, maxRps);
    drawLine(ctx1, historyData.drained, '#10b981', 2, null, maxRps);

    // Chart 2: Buffer Depth & Latency
    drawGrid(ctx2);
    const maxDepth = Math.max(50, ...historyData.bufferDepth);
    const grad = ctx2.createLinearGradient(0, 0, 0, ctx2.canvas.height);
    grad.addColorStop(0, 'rgba(168, 85, 247, 0.25)');
    grad.addColorStop(1, 'rgba(168, 85, 247, 0.0)');

    drawLine(ctx2, historyData.bufferDepth, '#a855f7', 1.5, grad, maxDepth);

    const maxLat = Math.max(10, ...historyData.p95Latency, ...historyData.p99Latency);
    drawLine(ctx2, historyData.p95Latency, '#00f0ff', 2, null, maxLat);
    drawLine(ctx2, historyData.p99Latency, '#f59e0b', 1.5, null, maxLat);

    requestAnimationFrame(renderCharts);
  }

  renderCharts();
}

// --- Control Matrix Handlers ---
function setupControls(): void {
  const inputTargetRps = getEl<HTMLInputElement>('input-target-rps');
  const inputBurstDuration = getEl<HTMLInputElement>('input-burst-duration');
  const inputFailureRate = getEl<HTMLInputElement>('input-failure-rate');
  const inputDownstreamLat = getEl<HTMLInputElement>('input-downstream-lat');
  const inputIdempotencyRate = getEl<HTMLInputElement>('input-idempotency-rate');
  const inputWorkerCount = getEl<HTMLInputElement>('input-worker-count');
  const selectSchema = getEl<HTMLSelectElement>('select-schema');
  const selectRouting = getEl<HTMLSelectElement>('select-routing');

  inputTargetRps.addEventListener('input', (e) => {
    getEl('val-target-rps').textContent =
      `${Number((e.target as HTMLInputElement).value).toLocaleString()} req/s`;
  });

  inputBurstDuration.addEventListener('input', (e) => {
    getEl('val-burst-duration').textContent = `${(e.target as HTMLInputElement).value} sec`;
  });

  inputFailureRate.addEventListener('input', (e) => {
    getEl('val-failure-rate').textContent = `${(e.target as HTMLInputElement).value}%`;
    syncConfigToServer();
  });

  inputDownstreamLat.addEventListener('input', (e) => {
    getEl('val-downstream-lat').textContent = `${(e.target as HTMLInputElement).value} ms`;
    syncConfigToServer();
  });

  inputIdempotencyRate.addEventListener('input', (e) => {
    getEl('val-idempotency-rate').textContent = `${(e.target as HTMLInputElement).value}%`;
  });

  inputWorkerCount.addEventListener('input', (e) => {
    getEl('val-worker-count').textContent = `${(e.target as HTMLInputElement).value} Nodes`;
    syncConfigToServer();
  });

  selectRouting.addEventListener('change', () => {
    syncConfigToServer();
  });

  // Start Burst
  getEl('btn-start-traffic').addEventListener('click', async () => {
    const config = {
      targetRps: Number(inputTargetRps.value),
      durationSec: Number(inputBurstDuration.value),
      schemaType: selectSchema.value,
      failureRate: Number(inputFailureRate.value),
      downstreamLatencyMs: Number(inputDownstreamLat.value),
      idempotencyCollisionRate: Number(inputIdempotencyRate.value),
    };

    try {
      const res = await fetch('/api/traffic/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      addLogEntry(`🚀 ${data.message || 'Traffic burst initiated'}`, 'text-[#00f0ff]');
      (getEl('btn-start-traffic') as HTMLButtonElement).disabled = true;
      (getEl('btn-stop-traffic') as HTMLButtonElement).disabled = false;
    } catch (err: any) {
      addLogEntry(`Failed to start traffic: ${err.message}`, 'text-[#f43f5e]');
    }
  });

  // Stop Burst
  getEl('btn-stop-traffic').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/traffic/stop', { method: 'POST' });
      const data = await res.json();
      addLogEntry(`⏹ Traffic stopped. Total sent: ${data.totalSent}`, 'text-[#f59e0b]');
      (getEl('btn-start-traffic') as HTMLButtonElement).disabled = false;
      (getEl('btn-stop-traffic') as HTMLButtonElement).disabled = true;
    } catch (err: any) {
      addLogEntry(`Failed to stop traffic: ${err.message}`, 'text-[#f43f5e]');
    }
  });

  // Randomize
  getEl('btn-randomize').addEventListener('click', () => {
    const randomRps = [1500, 2200, 3000, 3800, 4500][Math.floor(Math.random() * 5)];
    const randomDuration = [10, 15, 20, 30][Math.floor(Math.random() * 4)];
    const randomFailure = [4, 8, 14, 22][Math.floor(Math.random() * 4)];
    const randomLatency = [8, 14, 25, 45][Math.floor(Math.random() * 4)];
    const schemas = ['ecommerce', 'fintech', 'iot'];
    const randomSchema = schemas[Math.floor(Math.random() * schemas.length)];
    const randomWorkers = [4, 8, 12, 16][Math.floor(Math.random() * 4)];

    inputTargetRps.value = String(randomRps);
    getEl('val-target-rps').textContent = `${randomRps.toLocaleString()} req/s`;

    inputBurstDuration.value = String(randomDuration);
    getEl('val-burst-duration').textContent = `${randomDuration} sec`;

    inputFailureRate.value = String(randomFailure);
    getEl('val-failure-rate').textContent = `${randomFailure}%`;

    inputDownstreamLat.value = String(randomLatency);
    getEl('val-downstream-lat').textContent = `${randomLatency} ms`;

    selectSchema.value = randomSchema;

    inputWorkerCount.value = String(randomWorkers);
    getEl('val-worker-count').textContent = `${randomWorkers} Nodes`;

    syncConfigToServer();
    addLogEntry(
      `🎲 Randomized runtime parameters: ${randomRps} RPS / ${randomDuration}s burst / ${randomFailure}% errors`,
      'text-[#00f0ff]'
    );
  });

  // Clear Logs
  getEl('btn-clear-logs').addEventListener('click', () => {
    getEl('terminal-feed').innerHTML = '';
    addLogEntry('Audit log cleared.', 'text-[#00f0ff]');
  });
}

async function syncConfigToServer(): Promise<void> {
  const configUpdate = {
    workerCount: Number((getEl('input-worker-count') as HTMLInputElement).value),
    routingStrategy: (getEl('select-routing') as HTMLSelectElement).value,
    mockDownstreamFailureRate: Number((getEl('input-failure-rate') as HTMLInputElement).value),
    mockDownstreamLatencyMs: Number((getEl('input-downstream-lat') as HTMLInputElement).value),
  };

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configUpdate),
    });
  } catch {
    // Ignored
  }
}

// --- DLQ Console Modal ---
function setupDlqModal(): void {
  const modal = getEl('dlq-modal');
  getEl('btn-open-dlq').addEventListener('click', openDlqModal);
  getEl('btn-close-dlq').addEventListener('click', () => {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  });

  getEl('btn-replay-all').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/dlq/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      addLogEntry(
        `🔄 Replayed ${data.replayedCount} dead-letter items back into Shock Buffer!`,
        'text-[#10b981]'
      );
      openDlqModal();
    } catch (err: any) {
      addLogEntry(`Failed to replay DLQ: ${err.message}`, 'text-[#f43f5e]');
    }
  });

  getEl('btn-purge-dlq').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to purge all items from the DLQ?')) return;
    try {
      const res = await fetch('/api/dlq', { method: 'DELETE' });
      const data = await res.json();
      addLogEntry(`🗑 Purged ${data.purgedCount} items from DLQ`, 'text-[#f59e0b]');
      openDlqModal();
    } catch (err: any) {
      addLogEntry(`Failed to purge DLQ: ${err.message}`, 'text-[#f43f5e]');
    }
  });
}

async function openDlqModal(): Promise<void> {
  const modal = getEl('dlq-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  const tableBody = getEl('dlq-table-body');
  tableBody.innerHTML = `<tr><td colspan="6" class="text-center p-4 text-[#64748b]">Loading DLQ items...</td></tr>`;

  try {
    const res = await fetch('/api/dlq?limit=50');
    const { items, total } = await res.json();
    getEl('modal-dlq-count').textContent = total;

    if (items.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="6" class="text-center p-4 text-[#64748b]">No items currently in Dead-Letter Queue</td></tr>`;
      return;
    }

    tableBody.innerHTML = items
      .map((item: any) => {
        const time = new Date(item.failedAt).toLocaleTimeString();
        return `
          <tr class="hover:bg-white/5 transition">
            <td class="p-2.5">
              <div class="text-[#00f0ff]">${item.id}</div>
              <div class="text-[#64748b] text-[10px]">Key: ${item.idempotencyKey}</div>
            </td>
            <td class="p-2.5"><span class="px-1.5 py-0.5 rounded text-[10px] bg-[#a855f7]/20 text-[#a855f7] border border-[#a855f7]/30">${item.originalPayload?.schemaType || 'generic'}</span></td>
            <td class="p-2.5">${item.attempts}</td>
            <td class="p-2.5 text-[#f43f5e]">${item.errorReason}</td>
            <td class="p-2.5 text-[#94a3b8]">${time}</td>
            <td class="p-2.5">
              <button class="px-2 py-0.5 text-[10px] font-semibold rounded bg-[#00f0ff]/20 text-[#00f0ff] border border-[#00f0ff]/40 hover:bg-[#00f0ff] hover:text-black cursor-pointer transition" onclick="window.bufferflowReplayItem('${item.id}')">Replay</button>
            </td>
          </tr>
        `;
      })
      .join('');
  } catch (err: any) {
    tableBody.innerHTML = `<tr><td colspan="6" class="text-center p-4 text-[#f43f5e]">Error loading DLQ: ${err.message}</td></tr>`;
  }
}

window.bufferflowReplayItem = async (id: string): Promise<void> => {
  try {
    const res = await fetch('/api/dlq/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (data.success) {
      addLogEntry(`🔄 Replayed DLQ task ${id} back to Buffer`, 'text-[#10b981]');
      openDlqModal();
    }
  } catch (err: any) {
    addLogEntry(`Failed to replay item: ${err.message}`, 'text-[#f43f5e]');
  }
};

// --- Initialization ---
function init(): void {
  connectWebSocket();
  initDagCanvas();
  initCharts();
  setupControls();
  setupDlqModal();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
