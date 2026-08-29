import type { BurstProgress } from '../../../src/core/types';

export interface TrafficConfig {
  targetRps: number;
  durationSec: number;
  schemaType: string;
  failureRate: number;
  downstreamLatencyMs: number;
  idempotencyCollisionRate: number;
  workerCount: number;
  routingStrategy: string;
}

interface ControlMatrixProps {
  config: TrafficConfig;
  trafficActive: boolean;
  burstProgress?: BurstProgress;
  onChange: (updated: Partial<TrafficConfig>) => void;
  onStart: () => void;
  onStop: () => void;
  onRandomize: () => void;
}

export const ControlMatrix: React.FC<ControlMatrixProps> = ({
  config,
  trafficActive,
  burstProgress,
  onChange,
  onStart,
  onStop,
  onRandomize,
}) => {
  return (
    <div className="glass-card rounded-2xl p-6 flex flex-col gap-4">
      <div className="flex justify-between items-center border-b border-white/10 pb-3">
        <h3 className="text-sm font-bold tracking-wider uppercase text-white">Controls</h3>
      </div>

      <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-4">
        {/* Target Throughput */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label htmlFor="input-target-rps" className="text-xs font-semibold text-[#94a3b8]">
              TARGET THROUGHPUT
            </label>
            <span className="font-mono text-xs font-semibold text-[#00f0ff]">
              {config.targetRps.toLocaleString()} req/s
            </span>
          </div>
          <input
            id="input-target-rps"
            type="range"
            min="100"
            max="5000"
            step="100"
            value={config.targetRps}
            onChange={(e) => onChange({ targetRps: Number(e.target.value) })}
            className="custom-range range-cyan"
          />
        </div>

        {/* Burst Duration */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label htmlFor="input-burst-duration" className="text-xs font-semibold text-[#94a3b8]">
              BURST DURATION
            </label>
            <span className="font-mono text-xs font-semibold text-[#00f0ff]">
              {config.durationSec} sec
            </span>
          </div>
          <input
            id="input-burst-duration"
            type="range"
            min="5"
            max="90"
            step="5"
            value={config.durationSec}
            onChange={(e) => onChange({ durationSec: Number(e.target.value) })}
            className="custom-range range-cyan"
          />
        </div>

        {/* Payload Schema */}
        <div>
          <label
            htmlFor="select-schema"
            className="block text-xs font-semibold text-[#94a3b8] mb-1"
          >
            PAYLOAD SCHEMA PRESET
          </label>
          <select
            id="select-schema"
            value={config.schemaType}
            onChange={(e) => onChange({ schemaType: e.target.value })}
            className="w-full bg-[#0d111a] border border-white/10 text-white rounded-lg px-3 py-2 text-xs outline-none focus:border-[#00f0ff]"
          >
            <option value="ecommerce">E-Commerce Checkout (Orders &amp; Items)</option>
            <option value="fintech">FinTech ISO20022 (Real-time Payments)</option>
            <option value="iot">IoT Telemetry (Sensor Readings)</option>
          </select>
        </div>

        {/* Failure & Latency Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex justify-between items-center mb-1">
              <label
                htmlFor="input-failure-rate"
                className="text-[11px] font-semibold text-[#94a3b8]"
              >
                ERRORS %
              </label>
              <span className="font-mono text-[11px] font-semibold text-[#f43f5e]">
                {config.failureRate}%
              </span>
            </div>
            <input
              id="input-failure-rate"
              type="range"
              min="0"
              max="60"
              step="2"
              value={config.failureRate}
              onChange={(e) => onChange({ failureRate: Number(e.target.value) })}
              className="custom-range range-rose"
            />
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <label
                htmlFor="input-downstream-lat"
                className="text-[11px] font-semibold text-[#94a3b8]"
              >
                LATENCY
              </label>
              <span className="font-mono text-[11px] font-semibold text-[#f59e0b]">
                {config.downstreamLatencyMs} ms
              </span>
            </div>
            <input
              id="input-downstream-lat"
              type="range"
              min="2"
              max="100"
              step="2"
              value={config.downstreamLatencyMs}
              onChange={(e) => onChange({ downstreamLatencyMs: Number(e.target.value) })}
              className="custom-range range-amber"
            />
          </div>
        </div>

        {/* Dupe & Worker Count Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex justify-between items-center mb-1">
              <label
                htmlFor="input-idempotency-rate"
                className="text-[11px] font-semibold text-[#94a3b8]"
              >
                DUPE %
              </label>
              <span className="font-mono text-[11px] font-semibold text-[#f59e0b]">
                {config.idempotencyCollisionRate}%
              </span>
            </div>
            <input
              id="input-idempotency-rate"
              type="range"
              min="0"
              max="30"
              step="1"
              value={config.idempotencyCollisionRate}
              onChange={(e) => onChange({ idempotencyCollisionRate: Number(e.target.value) })}
              className="custom-range range-amber"
            />
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <label
                htmlFor="input-worker-count"
                className="text-[11px] font-semibold text-[#94a3b8]"
              >
                WORKERS
              </label>
              <span className="font-mono text-[11px] font-semibold text-[#10b981]">
                {config.workerCount} Nodes
              </span>
            </div>
            <input
              id="input-worker-count"
              type="range"
              min="2"
              max="24"
              step="2"
              value={config.workerCount}
              onChange={(e) => onChange({ workerCount: Number(e.target.value) })}
              className="custom-range range-emerald"
            />
          </div>
        </div>

        {/* Routing Strategy */}
        <div>
          <label
            htmlFor="select-routing"
            className="block text-xs font-semibold text-[#94a3b8] mb-1"
          >
            WORKER ROUTING STRATEGY
          </label>
          <select
            id="select-routing"
            value={config.routingStrategy}
            onChange={(e) => onChange({ routingStrategy: e.target.value })}
            className="w-full bg-[#0d111a] border border-white/10 text-white rounded-lg px-3 py-2 text-xs outline-none focus:border-[#00f0ff]"
          >
            <option value="LEAST_CONNECTIONS">
              Least Connections (Dispatches to least busy worker)
            </option>
            <option value="WEIGHTED_ROUND_ROBIN">Weighted Round-Robin (Weighted node tiers)</option>
            <option value="ROUND_ROBIN">Standard Round-Robin</option>
          </select>
        </div>

        {/* Burst Progress Bar */}
        <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-white/5 border border-white/10">
          <div className="flex justify-between items-center text-xs">
            <span className="font-semibold text-[#94a3b8] flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  trafficActive ? 'bg-[#00f0ff] animate-pulse' : 'bg-[#64748b]'
                }`}
              />
              {trafficActive ? 'BURST PROGRESS' : 'BURST STATUS'}
            </span>
            <span className="font-mono font-semibold text-white">
              {trafficActive
                ? `${burstProgress?.elapsedSec ?? 0}s / ${burstProgress?.durationSec ?? config.durationSec}s (${burstProgress?.pct ?? 0}%)`
                : 'READY / IDLE'}
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden relative">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                trafficActive
                  ? 'bg-gradient-to-r from-[#00f0ff] via-[#a855f7] to-[#10b981] shadow-[0_0_12px_rgba(0,240,255,0.6)]'
                  : 'bg-white/10'
              }`}
              style={{ width: `${trafficActive ? (burstProgress?.pct ?? 0) : 0}%` }}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            disabled={trafficActive}
            onClick={onStart}
            className="flex-1 py-2.5 px-3 rounded-lg bg-[#00f0ff] hover:bg-[#22f3ff] text-[#030810] font-bold text-xs shadow-[0_0_16px_rgba(0,240,255,0.3)] transition cursor-pointer flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {trafficActive ? 'BURST ACTIVE...' : 'START BURST'}
          </button>
          <button
            type="button"
            onClick={onRandomize}
            className="py-2.5 px-3 rounded-lg bg-white/5 hover:bg-white/10 text-white border border-white/10 text-xs font-semibold transition cursor-pointer flex items-center justify-center"
          >
            RANDOMIZE
          </button>
          <button
            type="button"
            onClick={onStop}
            className={`py-2.5 px-4 rounded-lg text-xs font-bold transition cursor-pointer flex items-center justify-center ${
              trafficActive
                ? 'bg-[#f43f5e] hover:bg-[#ff4d6d] text-white shadow-[0_0_16px_rgba(244,63,94,0.4)] ring-2 ring-[#f43f5e]/40'
                : 'bg-white/5 text-[#94a3b8] hover:bg-white/10 hover:text-white border border-white/10'
            }`}
          >
            STOP
          </button>
        </div>
      </form>
    </div>
  );
};
