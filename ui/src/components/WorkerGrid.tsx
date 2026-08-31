import type React from 'react';
import { Badge } from '@/components/ui/badge';
import type { TelemetryFrame } from '../../../src/core/types';

interface WorkerGridProps {
  workers: TelemetryFrame['workers'];
  routingStrategy: string;
}

export const WorkerGrid: React.FC<WorkerGridProps> = ({ workers, routingStrategy }) => {
  return (
    <section className="glass-card rounded-2xl p-6">
      <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold tracking-wider uppercase text-white">
            Dynamic Worker Pool &amp; Circuit Breakers
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="emerald" className="text-xs font-mono">
            {routingStrategy.replace('_', ' ')}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
        {workers.map((w) => {
          const concurrencyLimit = 20;
          const loadPct = Math.min(100, Math.round((w.activeJobs / concurrencyLimit) * 100));

          return (
            <div
              key={w.id}
              className="bg-[#0a0e16]/80 border border-white/10 rounded-xl p-3.5 flex flex-col gap-2.5 transition hover:border-white/20"
            >
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-white">
                  <span
                    className={`status-dot ${
                      w.circuitState === 'CLOSED'
                        ? 'dot-emerald'
                        : w.circuitState === 'OPEN'
                          ? 'dot-rose'
                          : 'dot-amber'
                    }`}
                  />
                  {w.name}
                </div>
                <Badge
                  variant={
                    w.circuitState === 'OPEN'
                      ? 'rose'
                      : w.circuitState === 'HALF_OPEN'
                        ? 'amber'
                        : 'emerald'
                  }
                  className={`text-[10px] font-mono font-bold px-1.5 py-0 ${
                    w.circuitState === 'OPEN' ? 'animate-pulse' : ''
                  }`}
                >
                  {w.circuitState}
                </Badge>
              </div>

              <div>
                <div className="flex justify-between items-center text-[10px] font-mono text-[#94a3b8] mb-1">
                  <span>
                    Active: {w.activeJobs}/{concurrencyLimit}
                  </span>
                  <span>{loadPct}%</span>
                </div>
                <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-200 ${
                      w.circuitState === 'OPEN'
                        ? 'bg-[#f43f5e]'
                        : loadPct > 80
                          ? 'bg-[#f59e0b]'
                          : 'bg-[#10b981]'
                    }`}
                    style={{ width: `${loadPct}%` }}
                  />
                </div>
              </div>

              <div className="flex justify-between text-[11px] text-[#94a3b8] pt-1 border-t border-white/5">
                <span>
                  Processed: <b className="text-[#10b981]">{w.totalProcessed.toLocaleString()}</b>
                </span>
                <span>
                  Failed: <b className="text-[#f43f5e]">{w.totalFailed}</b>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
