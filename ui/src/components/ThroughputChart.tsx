import type React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface ChartDataPoint {
  time: string;
  incoming: number;
  accepted: number;
  drained: number;
  bufferDepth: number;
  p95Latency: number;
}

interface ThroughputChartProps {
  data: ChartDataPoint[];
  targetRps?: number;
  durationSec?: number;
  downstreamLatencyMs?: number;
  bufferCapacity?: number;
}

interface TooltipPayloadItem {
  dataKey: string;
  name: string;
  value: number | string;
  stroke: string;
  color?: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
}

const CustomTooltip: React.FC<CustomTooltipProps> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;

  return (
    <div className="bg-[#0a0f1d]/95 backdrop-blur-md border border-white/10 rounded-xl p-3 shadow-2xl text-xs font-mono">
      <div className="text-[#64748b] text-[10px] mb-1.5">{label}</div>
      <div className="flex flex-col gap-1">
        {payload.map((entry) => (
          <div key={entry.dataKey} className="flex justify-between items-center gap-4">
            <span className="flex items-center gap-1.5 text-[#94a3b8]">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: entry.stroke || entry.color }}
              />
              {entry.name}:
            </span>
            <span className="font-semibold text-white">
              {typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const ThroughputChart: React.FC<ThroughputChartProps> = ({
  data,
  targetRps = 2000,
  durationSec = 15,
  downstreamLatencyMs = 15,
  bufferCapacity = 50000,
}) => {
  // 1. Throughput fixed ceiling: completely static during burst
  const throughputCeiling = Math.max(2500, Math.ceil((targetRps * 1.35) / 500) * 500);

  // 2. Buffer depth fixed ceiling: statically stepped based on burst configuration
  // Never auto-adjusts or jumps while traffic is running!
  const burstVolume = targetRps * durationSec;
  let bufferCeiling = 10000;
  if (burstVolume <= 15000) {
    bufferCeiling = 5000;
  } else if (burstVolume <= 40000) {
    bufferCeiling = 10000;
  } else if (burstVolume <= 80000) {
    bufferCeiling = 25000;
  } else {
    bufferCeiling = Math.min(bufferCapacity, 50000);
  }

  // 3. Latency SLA fixed ceiling: completely static during burst
  const latencyCeiling = Math.max(15, Math.ceil(((downstreamLatencyMs || 15) * 1.5) / 5) * 5);

  return (
    <div className="flex flex-col gap-4 min-w-0">
      {/* Chart 1: Throughput Dynamics */}
      <div className="glass-card rounded-2xl p-5 min-w-0">
        <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-bold text-white uppercase">Throughput Dynamics</h3>
          <div className="flex items-center gap-3 text-xs text-[#94a3b8]">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#00f0ff]" /> Ingress
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#a855f7]" /> Accepted
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#10b981]" /> Drained
            </span>
          </div>
        </div>

        <div className="relative w-full h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="gradIngress" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00f0ff" stopOpacity={0.45} />
                  <stop offset="95%" stopColor="#00f0ff" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="gradAccepted" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a855f7" stopOpacity={0.45} />
                  <stop offset="95%" stopColor="#a855f7" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="gradDrained" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.45} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255, 255, 255, 0.05)"
                vertical={false}
              />
              <XAxis
                dataKey="time"
                stroke="#64748b"
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#64748b"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                domain={[0, throughputCeiling]}
                allowDataOverflow={false}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="incoming"
                name="Ingress RPS"
                stroke="#00f0ff"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#gradIngress)"
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="accepted"
                name="Accepted RPS"
                stroke="#a855f7"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#gradAccepted)"
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="drained"
                name="Drained RPS"
                stroke="#10b981"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#gradDrained)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Chart 2: Buffer Depth & Latency SLA */}
      <div className="glass-card rounded-2xl p-5 min-w-0">
        <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-bold text-white uppercase">Buffer Depth &amp; Latency SLA</h3>
          <div className="flex items-center gap-3 text-xs text-[#94a3b8]">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#a855f7]" /> Queue Backlog
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 rounded-full bg-[#00f0ff]" /> P95 Latency (ms)
            </span>
          </div>
        </div>

        <div className="relative w-full h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="gradBuffer" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a855f7" stopOpacity={0.45} />
                  <stop offset="95%" stopColor="#a855f7" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="gradLatency" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00f0ff" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#00f0ff" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255, 255, 255, 0.05)"
                vertical={false}
              />
              <XAxis
                dataKey="time"
                stroke="#64748b"
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="left"
                stroke="#64748b"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                domain={[0, bufferCeiling]}
                allowDataOverflow={false}
                tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#64748b"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                domain={[0, latencyCeiling]}
                allowDataOverflow={false}
                unit="ms"
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="bufferDepth"
                name="Buffer Depth"
                stroke="#a855f7"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#gradBuffer)"
                isAnimationActive={false}
              />
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="p95Latency"
                name="P95 Latency"
                stroke="#00f0ff"
                strokeWidth={2}
                fill="none"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};
