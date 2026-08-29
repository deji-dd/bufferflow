// Bufferflow Dashboard & Telemetry Client

(function () {
  'use strict';

  // --- State & Config ---
  let ws = null;
  let reconnectTimer = null;
  let isTrafficActive = false;
  let previousWorkerStates = new Map();

  // History buffers for live canvas charts (keeps last 50 points = ~12.5 seconds)
  const MAX_HISTORY = 50;
  const historyData = {
    incoming: new Array(MAX_HISTORY).fill(0),
    accepted: new Array(MAX_HISTORY).fill(0),
    drained: new Array(MAX_HISTORY).fill(0),
    bufferDepth: new Array(MAX_HISTORY).fill(0),
    p95Latency: new Array(MAX_HISTORY).fill(0),
    p99Latency: new Array(MAX_HISTORY).fill(0),
  };

  // --- DOM Elements ---
  const el = {
    // Header
    headerP95: document.getElementById('header-p95'),
    headerBufCap: document.getElementById('header-buf-cap'),
    wsIndicator: document.getElementById('ws-indicator'),
    wsDot: document.getElementById('ws-dot'),

    // Top KPIs
    kpiIncomingRps: document.getElementById('kpi-incoming-rps'),
    kpiAcceptedRps: document.getElementById('kpi-accepted-rps'),
    kpiRateltdRps: document.getElementById('kpi-rateltd-rps'),
    kpiTrafficStatus: document.getElementById('kpi-traffic-status'),

    kpiBufferDepth: document.getElementById('kpi-buffer-depth'),
    kpiUtilization: document.getElementById('kpi-utilization'),
    kpiQueueLag: document.getElementById('kpi-queue-lag'),

    kpiDrainedRps: document.getElementById('kpi-drained-rps'),
    kpiActiveWorkers: document.getElementById('kpi-active-workers'),
    kpiTotalProcessed: document.getElementById('kpi-total-processed'),
    kpiRoutingBadge: document.getElementById('kpi-routing-badge'),

    kpiDlqCount: document.getElementById('kpi-dlq-count'),
    kpiDlqBadge: document.getElementById('kpi-dlq-badge'),
    kpiDupeCount: document.getElementById('kpi-dupe-count'),

    // DAG Node Overlay metrics
    dagTrafficVal: document.getElementById('dag-traffic-val'),
    dagBadgeTraffic: document.getElementById('dag-badge-traffic'),
    dagIngressVal: document.getElementById('dag-ingress-val'),
    dagBufferVal: document.getElementById('dag-buffer-val'),
    dagBadgeBuffer: document.getElementById('dag-badge-buffer'),
    dagRouterVal: document.getElementById('dag-router-val'),
    dagBadgeRouter: document.getElementById('dag-badge-router'),
    dagDownstreamVal: document.getElementById('dag-downstream-val'),
    dagBadgeDownstream: document.getElementById('dag-badge-downstream'),
    dagDlqVal: document.getElementById('dag-dlq-val'),
    dagBadgeDlq: document.getElementById('dag-badge-dlq'),

    // Form inputs
    inputTargetRps: document.getElementById('input-target-rps'),
    valTargetRps: document.getElementById('val-target-rps'),
    inputBurstDuration: document.getElementById('input-burst-duration'),
    valBurstDuration: document.getElementById('val-burst-duration'),
    selectSchema: document.getElementById('select-schema'),
    inputFailureRate: document.getElementById('input-failure-rate'),
    valFailureRate: document.getElementById('val-failure-rate'),
    inputDownstreamLat: document.getElementById('input-downstream-lat'),
    valDownstreamLat: document.getElementById('val-downstream-lat'),
    inputIdempotencyRate: document.getElementById('input-idempotency-rate'),
    valIdempotencyRate: document.getElementById('val-idempotency-rate'),
    inputWorkerCount: document.getElementById('input-worker-count'),
    valWorkerCount: document.getElementById('val-worker-count'),
    selectRouting: document.getElementById('select-routing'),

    // Buttons
    btnStartTraffic: document.getElementById('btn-start-traffic'),
    btnStopTraffic: document.getElementById('btn-stop-traffic'),
    btnRandomize: document.getElementById('btn-randomize'),
    btnClearLogs: document.getElementById('btn-clear-logs'),

    // Worker & Circuit Summary
    workerGrid: document.getElementById('worker-grid'),
    summaryClosed: document.getElementById('summary-closed-circuits'),
    summaryHalf: document.getElementById('summary-half-circuits'),
    summaryOpen: document.getElementById('summary-open-circuits'),

    // Logs
    terminalFeed: document.getElementById('terminal-feed'),

    // DLQ Modal
    dlqModal: document.getElementById('dlq-modal'),
    btnOpenDlq: document.getElementById('btn-open-dlq'),
    btnCloseDlq: document.getElementById('btn-close-dlq'),
    modalDlqCount: document.getElementById('modal-dlq-count'),
    dlqTableBody: document.getElementById('dlq-table-body'),
    btnReplayAll: document.getElementById('btn-replay-all'),
    btnPurgeDlq: document.getElementById('btn-purge-dlq'),

    // Canvases
    dagCanvas: document.getElementById('dag-canvas'),
    chartThroughput: document.getElementById('chart-throughput'),
    chartBufferLat: document.getElementById('chart-buffer-lat'),
  };

  // --- WebSocket Connection ---
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    setWsStatus('connecting');

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = function () {
        setWsStatus('connected');
        addLogEntry('WebSocket Telemetry link established (250ms broadcast active)', 'log-success');
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      };

      ws.onmessage = function (event) {
        try {
          const frame = JSON.parse(event.data);
          handleTelemetryFrame(frame);
        } catch (e) {
          console.error('Failed to parse telemetry frame:', e);
        }
      };

      ws.onclose = function () {
        setWsStatus('disconnected');
        scheduleReconnect();
      };

      ws.onerror = function () {
        setWsStatus('disconnected');
        ws.close();
      };
    } catch (e) {
      setWsStatus('disconnected');
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, 2000);
  }

  function setWsStatus(status) {
    if (status === 'connected') {
      el.wsIndicator.innerHTML = '<span class="status-dot pulse-cyan"></span> CONNECTED';
      el.wsIndicator.className = 'stat-value text-cyan';
    } else if (status === 'connecting') {
      el.wsIndicator.innerHTML = '<span class="status-dot"></span> CONNECTING';
      el.wsIndicator.className = 'stat-value text-amber';
    } else {
      el.wsIndicator.innerHTML = '<span class="status-dot"></span> RECONNECTING';
      el.wsIndicator.className = 'stat-value text-rose';
    }
  }

  // --- Telemetry Ingestion (Every 250ms) ---
  function handleTelemetryFrame(frame) {
    const { metrics, workers, routingStrategy, trafficActive, activeTargetRps } = frame;

    isTrafficActive = trafficActive;

    // 1. Update Header
    el.headerP95.textContent = `${metrics.p95LatencyMs.toFixed(2)} ms`;
    el.headerBufCap.textContent = metrics.bufferCapacity.toLocaleString();

    // 2. Update Top KPIs
    el.kpiIncomingRps.textContent = metrics.incomingRps.toLocaleString();
    el.kpiAcceptedRps.textContent = metrics.acceptedRps.toLocaleString();
    el.kpiRateltdRps.textContent = metrics.rateLimitedRps.toLocaleString();
    el.kpiTrafficStatus.textContent = trafficActive ? `${activeTargetRps} RPS` : 'IDLE';
    el.kpiTrafficStatus.className = trafficActive ? 'badge badge-cyan' : 'badge badge-amber';

    el.kpiBufferDepth.textContent = metrics.bufferDepth.toLocaleString();
    el.kpiUtilization.textContent = `${metrics.bufferUtilizationPct}% FULL`;
    el.kpiQueueLag.textContent = `${metrics.queueLagMs} ms`;

    el.kpiDrainedRps.textContent = metrics.drainedRps.toLocaleString();
    el.kpiActiveWorkers.textContent = workers.length;
    el.kpiTotalProcessed.textContent = metrics.totalProcessed.toLocaleString();
    el.kpiRoutingBadge.textContent = routingStrategy.replace('_', ' ');

    el.kpiDlqCount.textContent = metrics.dlqSize.toLocaleString();
    el.kpiDlqBadge.textContent = metrics.dlqSize > 0 ? `${metrics.dlqSize} FAILS` : 'CLEAN';
    el.kpiDlqBadge.className = metrics.dlqSize > 0 ? 'badge badge-rose' : 'badge badge-emerald';
    el.kpiDupeCount.textContent = metrics.duplicateRps.toLocaleString();

    // 3. Update DAG Overlays
    el.dagTrafficVal.textContent = trafficActive ? `${metrics.incomingRps} req/s` : '0 req/s';
    el.dagBadgeTraffic.textContent = trafficActive ? 'BURSTING' : 'IDLE';
    el.dagBadgeTraffic.className = trafficActive ? 'node-badge' : 'node-badge badge-amber';

    el.dagIngressVal.textContent = `P50: ${metrics.p50LatencyMs}ms • P95: ${metrics.p95LatencyMs}ms`;
    el.dagBufferVal.textContent = `${metrics.bufferDepth} tasks (${metrics.queueLagMs}ms lag)`;
    el.dagBadgeBuffer.textContent = `${metrics.bufferUtilizationPct}% FULL`;

    const busyWorkers = workers.filter((w) => w.activeJobs > 0).length;
    el.dagRouterVal.textContent = `${busyWorkers}/${workers.length} Active`;
    el.dagBadgeRouter.textContent = routingStrategy.replace('_', ' ');

    const openCount = workers.filter((w) => w.circuitState === 'OPEN').length;
    const halfCount = workers.filter((w) => w.circuitState === 'HALF_OPEN').length;
    const closedCount = workers.length - openCount - halfCount;

    if (openCount > 0) {
      el.dagDownstreamVal.textContent = `${openCount} Trips`;
      el.dagBadgeDownstream.textContent = 'DEGRADED';
      el.dagBadgeDownstream.className = 'node-badge badge-rose';
    } else if (halfCount > 0) {
      el.dagDownstreamVal.textContent = 'Recovering';
      el.dagBadgeDownstream.textContent = 'HALF-OPEN';
      el.dagBadgeDownstream.className = 'node-badge badge-amber';
    } else {
      el.dagDownstreamVal.textContent = `${metrics.drainedRps} 200 OK/s`;
      el.dagBadgeDownstream.textContent = 'HEALTHY';
      el.dagBadgeDownstream.className = 'node-badge badge-emerald';
    }

    el.dagDlqVal.textContent = `${metrics.dlqSize} failed`;

    // 4. Update Button State
    el.btnStartTraffic.disabled = trafficActive;
    el.btnStopTraffic.disabled = !trafficActive;

    // 5. Update Worker Cards & Circuit States
    updateWorkerGrid(workers);

    el.summaryClosed.textContent = `${closedCount} Healthy`;
    el.summaryHalf.textContent = `${halfCount} Half-Open`;
    el.summaryOpen.textContent = `${openCount} Tripped`;

    // 6. Push History Data for Canvas Charts
    pushHistory(metrics);

    // 7. Audit log detection
    checkSystemEvents(metrics, workers);
  }

  // --- Push History for Charts ---
  function pushHistory(metrics) {
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
  function updateWorkerGrid(workers) {
    if (el.workerGrid.children.length !== workers.length) {
      // Rebuild structure if worker count changed
      el.workerGrid.innerHTML = '';
      workers.forEach((w) => {
        const card = document.createElement('div');
        card.id = `card-${w.id}`;
        card.className = 'worker-card';
        card.innerHTML = `
          <div class="worker-card-header">
            <div class="worker-node-title">
              <span class="status-dot" id="dot-${w.id}"></span>
              <span>${w.name}</span>
            </div>
            <span class="worker-weight-pill">W: ${w.weight}</span>
          </div>
          <div class="worker-active-bar-wrap">
            <div class="worker-active-bar" id="bar-${w.id}" style="width: 0%;"></div>
          </div>
          <div class="worker-stats-row">
            <span>Inflight: <b class="text-white" id="jobs-${w.id}">0</b></span>
            <span>State: <b id="state-${w.id}">IDLE</b></span>
          </div>
          <div class="worker-stats-row">
            <span>Done: <b class="text-emerald" id="done-${w.id}">0</b></span>
            <span>Fails: <b class="text-rose" id="fails-${w.id}">0</b></span>
          </div>
        `;
        el.workerGrid.appendChild(card);
      });
    }

    // Update worker card values
    workers.forEach((w) => {
      const card = document.getElementById(`card-${w.id}`);
      const dot = document.getElementById(`dot-${w.id}`);
      const bar = document.getElementById(`bar-${w.id}`);
      const jobs = document.getElementById(`jobs-${w.id}`);
      const stateEl = document.getElementById(`state-${w.id}`);
      const done = document.getElementById(`done-${w.id}`);
      const fails = document.getElementById(`fails-${w.id}`);

      if (!card) return;

      jobs.textContent = w.activeJobs;
      done.textContent = w.totalProcessed.toLocaleString();
      fails.textContent = w.totalFailed.toLocaleString();

      // Active jobs bar percentage (capped at 50 max)
      const pct = Math.min(100, (w.activeJobs / 20) * 100);
      bar.style.width = `${pct}%`;

      if (w.circuitState === 'OPEN') {
        card.className = 'worker-card worker-card-open';
        dot.className = 'status-dot dot-rose';
        bar.style.background = 'var(--color-rose)';
        stateEl.textContent = 'CIRCUIT OPEN';
        stateEl.className = 'text-rose';
      } else if (w.circuitState === 'HALF_OPEN') {
        card.className = 'worker-card worker-card-half';
        dot.className = 'status-dot dot-amber';
        bar.style.background = 'var(--color-amber)';
        stateEl.textContent = 'HALF-OPEN';
        stateEl.className = 'text-amber';
      } else if (w.activeJobs > 0) {
        card.className = 'worker-card';
        dot.className = 'status-dot pulse-cyan';
        bar.style.background = 'var(--color-cyan)';
        stateEl.textContent = 'PROCESSING';
        stateEl.className = 'text-cyan';
      } else {
        card.className = 'worker-card';
        dot.className = 'status-dot dot-emerald';
        bar.style.background = 'var(--color-cyan)';
        stateEl.textContent = 'IDLE';
        stateEl.className = 'text-muted';
      }
    });
  }

  // --- Audit Log Feed ---
  function checkSystemEvents(metrics, workers) {
    if (metrics.rateLimitedRps > 0 && Math.random() < 0.15) {
      addLogEntry(`Rate limiter threshold reached: dropped ${metrics.rateLimitedRps} req/s (HTTP 429)`, 'log-warn');
    }
    if (metrics.duplicateRps > 0 && Math.random() < 0.15) {
      addLogEntry(`Idempotency collision detected: deduplicated ${metrics.duplicateRps} redundant requests (HTTP 409)`, 'log-info');
    }

    workers.forEach((w) => {
      const prev = previousWorkerStates.get(w.id);
      if (prev && prev !== w.circuitState) {
        if (w.circuitState === 'OPEN') {
          addLogEntry(`⚠️ Circuit breaker TRIPPED for ${w.name}: consecutive errors exceeded limit!`, 'log-error');
        } else if (w.circuitState === 'HALF_OPEN') {
          addLogEntry(`🔄 Circuit breaker entered HALF-OPEN for ${w.name}: attempting canary requests...`, 'log-warn');
        } else if (w.circuitState === 'CLOSED' && prev === 'HALF_OPEN') {
          addLogEntry(`✅ Circuit breaker RECOVERED for ${w.name}: normal routing restored.`, 'log-success');
        }
      }
      previousWorkerStates.set(w.id, w.circuitState);
    });
  }

  function addLogEntry(text, cssClass = 'log-info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${cssClass}`;

    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

    entry.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-text">${text}</span>`;
    el.terminalFeed.appendChild(entry);

    if (el.terminalFeed.children.length > 80) {
      el.terminalFeed.removeChild(el.terminalFeed.children[0]);
    }
    el.terminalFeed.scrollTop = el.terminalFeed.scrollHeight;
  }

  // --- Animated Canvas DAG Visualizer ---
  class Particle {
    constructor(startNode, endNode, color) {
      this.startNode = startNode;
      this.endNode = endNode;
      this.color = color;
      this.progress = 0;
      this.speed = 0.015 + Math.random() * 0.02;
    }

    update(speedMultiplier) {
      this.progress += this.speed * speedMultiplier;
      return this.progress < 1;
    }

    draw(ctx, nodeCoords) {
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

  let particles = [];
  const dagNodes = {
    traffic: { x: 0.04, y: 0.5 },
    ingress: { x: 0.23, y: 0.5 },
    buffer: { x: 0.45, y: 0.5 },
    router: { x: 0.65, y: 0.5 },
    downstream: { x: 0.88, y: 0.28 },
    dlq: { x: 0.88, y: 0.72 },
  };

  function initDagCanvas() {
    const canvas = el.dagCanvas;
    const ctx = canvas.getContext('2d');

    function resize() {
      canvas.width = canvas.parentElement.clientWidth;
      canvas.height = canvas.parentElement.clientHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    const links = [
      { from: 'traffic', to: 'ingress', color: '#00f0ff' },
      { from: 'ingress', to: 'buffer', color: '#a855f7' },
      { from: 'buffer', to: 'router', color: '#10b981' },
      { from: 'router', to: 'downstream', color: '#10b981' },
      { from: 'router', to: 'dlq', color: '#f43f5e' },
    ];

    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Node absolute coordinates
      const coords = {};
      for (const [key, pt] of Object.entries(dagNodes)) {
        coords[key] = {
          x: pt.x * canvas.width,
          y: pt.y * canvas.height,
        };
      }

      // Draw connecting lines with glow
      links.forEach((link) => {
        const p1 = coords[link.from];
        const p2 = coords[link.to];
        if (!p1 || !p2) return;

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      // Spawn particles based on activity
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

      // Occasional failure packet to DLQ
      const dlqVal = Number(el.kpiDlqCount.textContent) || 0;
      if (dlqVal > 0 && Math.random() < 0.08) {
        particles.push(new Particle('router', 'dlq', '#f43f5e'));
      }

      // Update and draw particles
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
  function initCharts() {
    const c1 = el.chartThroughput;
    const ctx1 = c1.getContext('2d');
    const c2 = el.chartBufferLat;
    const ctx2 = c2.getContext('2d');

    function resize() {
      c1.width = c1.parentElement.clientWidth;
      c1.height = c1.parentElement.clientHeight;
      c2.width = c2.parentElement.clientWidth;
      c2.height = c2.parentElement.clientHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    function drawLine(ctx, data, color, width = 2, fillGradient = null, maxValOverride = null) {
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

    function drawGrid(ctx) {
      const w = ctx.canvas.width;
      const h = ctx.canvas.height;
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      for (let y = 20; y < h; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    function renderCharts() {
      // Chart 1: Throughput
      drawGrid(ctx1);
      const maxRps = Math.max(100, ...historyData.incoming, ...historyData.accepted, ...historyData.drained);
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

      // Overlay Latency
      const maxLat = Math.max(10, ...historyData.p95Latency, ...historyData.p99Latency);
      drawLine(ctx2, historyData.p95Latency, '#00f0ff', 2, null, maxLat);
      drawLine(ctx2, historyData.p99Latency, '#f59e0b', 1.5, null, maxLat);

      requestAnimationFrame(renderCharts);
    }

    renderCharts();
  }

  // --- Form Controls & Interaction ---
  function setupControls() {
    // Slider values sync
    el.inputTargetRps.addEventListener('input', (e) => {
      el.valTargetRps.textContent = `${Number(e.target.value).toLocaleString()} req/s`;
    });

    el.inputBurstDuration.addEventListener('input', (e) => {
      el.valBurstDuration.textContent = `${e.target.value} sec`;
    });

    el.inputFailureRate.addEventListener('input', (e) => {
      el.valFailureRate.textContent = `${e.target.value}%`;
      syncConfigToServer();
    });

    el.inputDownstreamLat.addEventListener('input', (e) => {
      el.valDownstreamLat.textContent = `${e.target.value} ms`;
      syncConfigToServer();
    });

    el.inputIdempotencyRate.addEventListener('input', (e) => {
      el.valIdempotencyRate.textContent = `${e.target.value}%`;
    });

    el.inputWorkerCount.addEventListener('input', (e) => {
      el.valWorkerCount.textContent = `${e.target.value} Nodes`;
      syncConfigToServer();
    });

    el.selectRouting.addEventListener('change', () => {
      syncConfigToServer();
    });

    // Start Button
    el.btnStartTraffic.addEventListener('click', async () => {
      const config = {
        targetRps: Number(el.inputTargetRps.value),
        durationSec: Number(el.inputBurstDuration.value),
        schemaType: el.selectSchema.value,
        failureRate: Number(el.inputFailureRate.value),
        downstreamLatencyMs: Number(el.inputDownstreamLat.value),
        idempotencyCollisionRate: Number(el.inputIdempotencyRate.value),
      };

      try {
        const res = await fetch('/api/traffic/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        const data = await res.json();
        addLogEntry(`🚀 ${data.message || 'Traffic burst initiated'}`, 'log-info');
        el.btnStartTraffic.disabled = true;
        el.btnStopTraffic.disabled = false;
      } catch (err) {
        addLogEntry(`Failed to start traffic: ${err.message}`, 'log-error');
      }
    });

    // Stop Button
    el.btnStopTraffic.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/traffic/stop', { method: 'POST' });
        const data = await res.json();
        addLogEntry(`⏹ Traffic stopped. Total sent: ${data.totalSent}`, 'log-warn');
        el.btnStartTraffic.disabled = false;
        el.btnStopTraffic.disabled = true;
      } catch (err) {
        addLogEntry(`Failed to stop traffic: ${err.message}`, 'log-error');
      }
    });

    // Randomize Button
    el.btnRandomize.addEventListener('click', () => {
      const randomRps = [1500, 2200, 3000, 3800, 4500][Math.floor(Math.random() * 5)];
      const randomDuration = [10, 15, 20, 30][Math.floor(Math.random() * 4)];
      const randomFailure = [4, 8, 14, 22][Math.floor(Math.random() * 4)];
      const randomLatency = [8, 14, 25, 45][Math.floor(Math.random() * 4)];
      const schemas = ['ecommerce', 'fintech', 'iot'];
      const randomSchema = schemas[Math.floor(Math.random() * schemas.length)];
      const randomWorkers = [4, 8, 12, 16][Math.floor(Math.random() * 4)];

      el.inputTargetRps.value = randomRps;
      el.valTargetRps.textContent = `${randomRps.toLocaleString()} req/s`;

      el.inputBurstDuration.value = randomDuration;
      el.valBurstDuration.textContent = `${randomDuration} sec`;

      el.inputFailureRate.value = randomFailure;
      el.valFailureRate.textContent = `${randomFailure}%`;

      el.inputDownstreamLat.value = randomLatency;
      el.valDownstreamLat.textContent = `${randomLatency} ms`;

      el.selectSchema.value = randomSchema;

      el.inputWorkerCount.value = randomWorkers;
      el.valWorkerCount.textContent = `${randomWorkers} Nodes`;

      syncConfigToServer();
      addLogEntry(`🎲 Randomized runtime parameters: ${randomRps} RPS / ${randomDuration}s burst / ${randomFailure}% errors`, 'log-info');
    });

    // Clear Logs
    el.btnClearLogs.addEventListener('click', () => {
      el.terminalFeed.innerHTML = '';
      addLogEntry('Audit log cleared.', 'log-info');
    });
  }

  async function syncConfigToServer() {
    const configUpdate = {
      workerCount: Number(el.inputWorkerCount.value),
      routingStrategy: el.selectRouting.value,
      mockDownstreamFailureRate: Number(el.inputFailureRate.value),
      mockDownstreamLatencyMs: Number(el.inputDownstreamLat.value),
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

  // --- DLQ Modal & Replay Handlers ---
  function setupDlqModal() {
    el.btnOpenDlq.addEventListener('click', openDlqModal);
    el.btnCloseDlq.addEventListener('click', () => {
      el.dlqModal.classList.remove('active');
    });

    el.dlqModal.addEventListener('click', (e) => {
      if (e.target === el.dlqModal) {
        el.dlqModal.classList.remove('active');
      }
    });

    el.btnReplayAll.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/dlq/replay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        addLogEntry(`🔄 Replayed ${data.replayedCount} dead-letter items back into Shock Buffer!`, 'log-success');
        openDlqModal();
      } catch (err) {
        addLogEntry(`Failed to replay DLQ: ${err.message}`, 'log-error');
      }
    });

    el.btnPurgeDlq.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to purge all items from the DLQ?')) return;
      try {
        const res = await fetch('/api/dlq', { method: 'DELETE' });
        const data = await res.json();
        addLogEntry(`🗑 Purged ${data.purgedCount} items from DLQ`, 'log-warn');
        openDlqModal();
      } catch (err) {
        addLogEntry(`Failed to purge DLQ: ${err.message}`, 'log-error');
      }
    });
  }

  async function openDlqModal() {
    el.dlqModal.classList.add('active');
    el.dlqTableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Loading DLQ items...</td></tr>`;

    try {
      const res = await fetch('/api/dlq?limit=50');
      const { items, total } = await res.json();
      el.modalDlqCount.textContent = total;

      if (items.length === 0) {
        el.dlqTableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No items currently in Dead-Letter Queue</td></tr>`;
        return;
      }

      el.dlqTableBody.innerHTML = items
        .map((item) => {
          const time = new Date(item.failedAt).toLocaleTimeString();
          return `
            <tr>
              <td>
                <div class="text-cyan">${item.id}</div>
                <div class="text-muted" style="font-size:0.65rem;">Key: ${item.idempotencyKey}</div>
              </td>
              <td><span class="badge badge-purple">${item.originalPayload?.schemaType || 'generic'}</span></td>
              <td>${item.attempts}</td>
              <td class="text-rose">${item.errorReason}</td>
              <td>${time}</td>
              <td>
                <button class="btn btn-xs btn-cyan" onclick="window.bufferflowReplayItem('${item.id}')">Replay</button>
              </td>
            </tr>
          `;
        })
        .join('');
    } catch (err) {
      el.dlqTableBody.innerHTML = `<tr><td colspan="6" class="text-center text-rose">Error loading DLQ: ${err.message}</td></tr>`;
    }
  }

  window.bufferflowReplayItem = async function (id) {
    try {
      const res = await fetch('/api/dlq/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.success) {
        addLogEntry(`🔄 Replayed DLQ task ${id} back to Buffer`, 'log-success');
        openDlqModal();
      }
    } catch (err) {
      addLogEntry(`Failed to replay item: ${err.message}`, 'log-error');
    }
  };

  // --- Initialization ---
  function init() {
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
})();
