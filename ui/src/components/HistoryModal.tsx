import { Clock, Database, Eye, History, RefreshCw, Trash2, X } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';

export interface HistoricalRunItem {
  id: string;
  runId: string;
  sessionId: string;
  testType: string;
  isMultiLevel: boolean;
  completedReason: string;
  durationSec: number;
  startedAt: string;
  completedAt: string;
  targetRps: number;
  workerCount: number;
  peakThroughputRps: number;
  p95LatencyMs: number;
  totalProcessed: number;
  totalFailed: number;
  createdAt: string;
}

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectRun: (runId: string) => void;
}

export const HistoryModal: React.FC<HistoryModalProps> = ({ isOpen, onClose, onSelectRun }) => {
  const [runs, setRuns] = useState<HistoricalRunItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [isPostgres, setIsPostgres] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/history?limit=50');
      const data = await res.json();
      if (data && Array.isArray(data.runs)) {
        setRuns(data.runs);
        setTotal(data.total ?? data.runs.length);
        setIsPostgres(Boolean(data.isPostgres));
      }
    } catch (err) {
      console.warn('Failed to load history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchHistory();
    }
  }, [isOpen]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this historical benchmark run?')) return;
    setDeletingId(id);
    try {
      const res = await apiFetch(`/api/history/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data?.success) {
        setRuns((prev) => prev.filter((r) => r.id !== id && r.runId !== id));
        setTotal((prev) => Math.max(0, prev - 1));
      }
    } catch (err) {
      console.warn('Failed to delete run:', err);
    } finally {
      setDeletingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-4xl max-h-[85vh] flex flex-col p-6 gap-4 overflow-hidden"
        showCloseButton={false}
      >
        {/* Header */}
        <DialogHeader className="border-b border-white/10 pb-3 flex flex-row items-center justify-between">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2.5">
              <div className="size-8 rounded-lg bg-[#00f0ff]/10 border border-[#00f0ff]/30 flex items-center justify-center text-[#00f0ff]">
                <History className="size-4" />
              </div>
              <DialogTitle className="text-lg font-bold text-white tracking-wide">
                Historical Benchmark Runs
              </DialogTitle>
              <Badge variant="cyan" className="font-mono text-xs">
                {total} {total === 1 ? 'RUN' : 'RUNS'}
              </Badge>
              <Badge
                variant={isPostgres ? 'emerald' : 'glass'}
                className="font-mono text-[10px] gap-1"
              >
                <Database className="size-3" />
                {isPostgres ? 'PostgreSQL IPC' : 'In-Memory (Dev)'}
              </Badge>
            </div>
            <DialogDescription className="text-xs text-[#94a3b8]">
              Review past stress tests, strategy evaluations, and throughput comparisons.
            </DialogDescription>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={fetchHistory}
              disabled={loading}
              title="Refresh Historical Runs"
            >
              <RefreshCw className={`size-3.5 text-[#00f0ff] ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              className="text-[#94a3b8] hover:text-white"
            >
              <X className="size-4" />
            </Button>
          </div>
        </DialogHeader>

        {/* Content List */}
        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="size-12 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center text-[#64748b] mb-3">
                <History className="size-6" />
              </div>
              <span className="text-sm font-semibold text-white">No Historical Runs Found</span>
              <p className="text-xs text-[#64748b] max-w-sm mt-1">
                Execute a Full Suite Benchmark or Traffic Burst from the Control Matrix to record
                performance metrics.
              </p>
            </div>
          ) : (
            runs.map((run) => {
              const isSuite = run.testType === 'FULL_SUITE';
              const isCompleted = run.completedReason === 'completed';
              const dateStr = new Date(run.completedAt || run.startedAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });

              return (
                <Card
                  key={run.id}
                  className="bg-white/[0.02] border-white/10 hover:border-white/20 p-4 transition-all duration-150 flex flex-col md:flex-row md:items-center justify-between gap-4 group"
                >
                  <div className="flex flex-col gap-2 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant={isSuite ? 'purple' : 'cyan'}
                        className="font-mono text-[10px] font-bold"
                      >
                        {isSuite
                          ? run.isMultiLevel
                            ? '4-LEVEL SUITE'
                            : 'FULL SUITE'
                          : 'BURST RUN'}
                      </Badge>
                      <Badge
                        variant={isCompleted ? 'emerald' : 'amber'}
                        className="font-mono text-[10px] font-semibold"
                      >
                        {isCompleted ? 'COMPLETED' : 'STOPPED'}
                      </Badge>
                      <span className="text-[11px] font-mono text-[#64748b] flex items-center gap-1">
                        <Clock className="size-3" />
                        {dateStr}
                      </span>
                      <span className="text-[10px] font-mono text-[#475569] hidden sm:inline">
                        ID: {run.runId}
                      </span>
                    </div>

                    {/* KPI Metrics Chips */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                      <div className="flex flex-col bg-black/20 rounded-lg px-2.5 py-1.5 border border-white/5">
                        <span className="text-[9px] font-mono text-[#64748b] uppercase">
                          Duration
                        </span>
                        <span className="text-xs font-mono font-bold text-white">
                          {run.durationSec}s
                        </span>
                      </div>
                      <div className="flex flex-col bg-black/20 rounded-lg px-2.5 py-1.5 border border-white/5">
                        <span className="text-[9px] font-mono text-[#64748b] uppercase">
                          Peak Ingress
                        </span>
                        <span className="text-xs font-mono font-bold text-[#00f0ff]">
                          {run.peakThroughputRps.toLocaleString()} rps
                        </span>
                      </div>
                      <div className="flex flex-col bg-black/20 rounded-lg px-2.5 py-1.5 border border-white/5">
                        <span className="text-[9px] font-mono text-[#64748b] uppercase">
                          P95 Latency
                        </span>
                        <span className="text-xs font-mono font-bold text-[#f59e0b]">
                          {run.p95LatencyMs > 0 ? `${run.p95LatencyMs} ms` : '--'}
                        </span>
                      </div>
                      <div className="flex flex-col bg-black/20 rounded-lg px-2.5 py-1.5 border border-white/5">
                        <span className="text-[9px] font-mono text-[#64748b] uppercase">
                          Processed
                        </span>
                        <span className="text-xs font-mono font-bold text-[#10b981]">
                          {run.totalProcessed.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                    <Button
                      type="button"
                      variant="cyan-subtle"
                      size="sm"
                      onClick={() => onSelectRun(run.runId)}
                      className="font-mono text-xs gap-1.5"
                    >
                      <Eye className="size-3.5" />
                      <span>View Breakdown</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => handleDelete(e, run.id)}
                      disabled={deletingId === run.id}
                      className="text-[#64748b] hover:text-[#f43f5e] hover:bg-[#f43f5e]/10 transition-colors"
                      title="Delete Run"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
