import type React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { TelemetryFrame } from '../../../src/core/types';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';

interface KpiGridProps {
  metrics: TelemetryFrame['metrics'];
  trafficActive: boolean;
  activeTargetRps: number;
  workerCount: number;
  onOpenDlq: () => void;
}

export const KpiGrid: React.FC<KpiGridProps> = ({
  metrics,
  trafficActive,
  activeTargetRps,
  workerCount,
  onOpenDlq,
}) => {
  const animIncoming = useAnimatedNumber(metrics.incomingRps, 280);
  const animAccepted = useAnimatedNumber(metrics.acceptedRps, 280);
  const animBufferDepth = useAnimatedNumber(metrics.bufferDepth, 280);
  const animDrained = useAnimatedNumber(metrics.drainedRps, 280);
  const animDlq = useAnimatedNumber(metrics.dlqSize, 280);
  const animRateLimited = useAnimatedNumber(metrics.rateLimitedRps, 280);
  const animTotalProcessed = useAnimatedNumber(metrics.totalProcessed, 280);
  const animDupes = useAnimatedNumber(metrics.duplicateRps, 280);

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* KPI 1: Ingress RPS */}
      <Card className="flex flex-col gap-2.5">
        <div className="flex justify-between items-center">
          <span className="text-[11px] font-semibold tracking-wider text-[#64748b] uppercase">
            Incoming Ingress RPS
          </span>
          <Badge
            variant={trafficActive ? 'cyan' : 'amber'}
            className="font-mono text-xs font-semibold"
          >
            {trafficActive ? `${activeTargetRps} RPS` : 'IDLE'}
          </Badge>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-3xl font-bold text-[#00f0ff]">
            {animIncoming.toLocaleString()}
          </span>
          <span className="text-xs text-[#94a3b8]">req/sec</span>
        </div>
        <div className="text-xs text-[#94a3b8] flex items-center gap-2">
          <span>
            Accepted: <b className="text-white">{animAccepted.toLocaleString()}</b>/s
          </span>
          <span className="text-[#334155]">•</span>
          <span>
            429 Ltd: <b className="text-[#f59e0b]">{animRateLimited.toLocaleString()}</b>/s
          </span>
        </div>
      </Card>

      {/* KPI 2: Shock Buffer Depth */}
      <Card className="flex flex-col gap-2.5">
        <div className="flex justify-between items-center">
          <span className="text-[11px] font-semibold tracking-wider text-[#64748b] uppercase">
            Shock Buffer Depth
          </span>
          <Badge variant="purple" className="font-mono text-xs font-semibold">
            {metrics.bufferUtilizationPct}% FULL
          </Badge>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-3xl font-bold text-[#a855f7]">
            {animBufferDepth.toLocaleString()}
          </span>
          <span className="text-xs text-[#94a3b8]">in queue</span>
        </div>
        <div className="text-xs text-[#94a3b8] flex items-center gap-2">
          <span>
            Queue Lag: <b className="text-white">{metrics.queueLagMs} ms</b>
          </span>
          <span className="text-[#334155]">•</span>
          <span>
            Max Cap:{' '}
            <b>
              {metrics.bufferCapacity >= 1000
                ? `${(metrics.bufferCapacity / 1000).toFixed(0)}k`
                : metrics.bufferCapacity}
            </b>
          </span>
        </div>
      </Card>

      {/* KPI 3: Worker Drain Throughput */}
      <Card className="flex flex-col gap-2.5">
        <div className="flex justify-between items-center">
          <span className="text-[11px] font-semibold tracking-wider text-[#64748b] uppercase">
            Worker Drain Throughput
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-3xl font-bold text-[#10b981]">
            {animDrained.toLocaleString()}
          </span>
          <span className="text-xs text-[#94a3b8]">jobs/sec</span>
        </div>
        <div className="text-xs text-[#94a3b8] flex items-center gap-2">
          <span>
            Workers: <b className="text-white">{workerCount}</b>
          </span>
          <span className="text-[#334155]">•</span>
          <span>
            Done: <b className="text-[#10b981]">{animTotalProcessed.toLocaleString()}</b>
          </span>
        </div>
      </Card>

      {/* KPI 4: Dead-Letter Queue */}
      <Card className="flex flex-col gap-2.5">
        <div className="flex justify-between items-center">
          <span className="text-[11px] font-semibold tracking-wider text-[#64748b] uppercase">
            Dead-Letter Queue (DLQ)
          </span>
          <Badge
            variant={metrics.dlqSize > 0 ? 'rose' : 'emerald'}
            className="font-mono text-xs font-semibold"
          >
            {animDlq > 0 ? `${animDlq} FAILS` : '0 FAILS'}
          </Badge>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-3xl font-bold text-[#f43f5e]">
            {animDlq.toLocaleString()}
          </span>
          <span className="text-xs text-[#94a3b8]">exhausted</span>
        </div>
        <div className="text-xs text-[#94a3b8] flex items-center gap-2">
          <Button
            type="button"
            variant="destructive-subtle"
            size="xs"
            onClick={onOpenDlq}
            className="text-[11px] font-semibold"
          >
            Inspect &amp; Replay
          </Button>
          <span className="text-[#334155]">•</span>
          <span>
            Dupes: <b className="text-[#f59e0b]">{animDupes.toLocaleString()}</b>
          </span>
        </div>
      </Card>
    </section>
  );
};
