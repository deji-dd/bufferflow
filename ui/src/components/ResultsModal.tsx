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
import type { StrategyBenchmark, WorkerInfo } from '../../../src/core/types';
import type { TrafficConfig } from './ControlMatrix';

export interface TestRunResults {
  runId: string;
  sessionId: string;
  testType?: 'STANDARD' | 'FULL_SUITE';
  isMultiLevel?: boolean;
  levelsTested?: number[];
  levelBreakdowns?: Record<number, Record<string, StrategyBenchmark>>;
  startedAt: string;
  completedAt: string;
  durationSec: number;
  completedReason:
    | 'completed'
    | 'stopped_by_user'
    | 'safety_fallback_blur'
    | 'safety_fallback_unload';
  config: TrafficConfig;
  strategiesTested?: string[];
  strategyBreakdown?: Record<string, StrategyBenchmark>;
  summary: {
    totalIngressed: number;
    totalAccepted: number;
    totalProcessed: number;
    totalFailed: number;
    peakIncomingRps: number;
    peakAcceptedRps?: number;
    peakDrainedRps?: number;
    p50LatencyMs?: number;
    p95LatencyMs: number;
    p99LatencyMs?: number;
    finalBufferDepth: number;
    finalDlqSize: number;
  };
  workers: WorkerInfo[];
}

interface ResultsModalProps {
  isOpen: boolean;
  results: TestRunResults | null;
  onClose: () => void;
}

export const ResultsModal: React.FC<ResultsModalProps> = ({ isOpen, results, onClose }) => {
  const [copied, setCopied] = useState(false);
  const [selectedLevelTab, setSelectedLevelTab] = useState<number>(0);

  // Reset per-run view state when a different result is opened.
  useEffect(() => {
    setSelectedLevelTab(0);
    setCopied(false);
  }, [results?.runId]);

  if (!isOpen || !results) return null;

  const jsonString = JSON.stringify(results, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleDownload = () => {
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bufferflow_results_${results.runId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getBadge = () => {
    switch (results.completedReason) {
      case 'completed':
        return { text: 'COMPLETED', color: 'bg-[#10b981]/20 text-[#10b981] border-[#10b981]/40' };
      case 'stopped_by_user':
        return {
          text: 'STOPPED BY USER',
          color: 'bg-[#f59e0b]/20 text-[#f59e0b] border-[#f59e0b]/40',
        };
      case 'safety_fallback_blur':
        return {
          text: 'SAFETY STOP (BLUR)',
          color: 'bg-[#a855f7]/20 text-[#a855f7] border-[#a855f7]/40',
        };
      default:
        return { text: 'TERMINATED', color: 'bg-[#f43f5e]/20 text-[#f43f5e] border-[#f43f5e]/40' };
    }
  };

  const badge = getBadge();
  const isFullSuite = results.testType === 'FULL_SUITE';

  // Strategy breakdown to show: level specific or aggregate
  const activeBreakdown: Record<string, StrategyBenchmark> | undefined =
    results.isMultiLevel && results.levelBreakdowns && selectedLevelTab > 0
      ? results.levelBreakdowns[selectedLevelTab]
      : results.strategyBreakdown;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-4xl max-h-[90vh] flex flex-col p-6 gap-5 overflow-hidden"
        showCloseButton={false}
      >
        {/* Header */}
        <DialogHeader className="border-b border-white/10 pb-4">
          <div className="flex justify-between items-start w-full">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge
                  variant={isFullSuite ? 'purple' : 'cyan'}
                  className="text-xs font-mono font-bold"
                >
                  {isFullSuite ? 'FULL SUITE BENCHMARK' : 'RUN RESULTS'}
                </Badge>
                <Badge
                  variant={badge.text === 'COMPLETED' ? 'emerald' : 'amber'}
                  className="text-[10px] font-mono font-bold"
                >
                  {badge.text}
                </Badge>
                <span className="text-xs font-mono text-[#94a3b8]">
                  Duration: <b className="text-white">{results.durationSec}s</b>
                </span>
              </div>
              <DialogTitle className="text-lg font-bold text-white tracking-wide">
                {isFullSuite ? 'Full Suite Benchmark Breakdown' : 'Execution Run Results'}
              </DialogTitle>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              className="text-[#94a3b8] hover:text-white font-mono text-base bg-white/5 hover:bg-white/10"
            >
              ✕
            </Button>
          </div>
          <DialogDescription className="sr-only">
            Automated test results breakdown and telemetry summary
          </DialogDescription>
        </DialogHeader>

        {/* Summary Metric Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
          <Card className="p-3 rounded-xl gap-1">
            <span className="text-[10px] text-[#94a3b8]">TOTAL INGRESSED</span>
            <span className="text-base font-bold text-[#00f0ff]">
              {results.summary.totalIngressed.toLocaleString()}
            </span>
          </Card>
          <Card className="p-3 rounded-xl gap-1">
            <span className="text-[10px] text-[#94a3b8]">PROCESSED OK</span>
            <span className="text-base font-bold text-[#10b981]">
              {results.summary.totalProcessed.toLocaleString()}
            </span>
          </Card>
          <Card className="p-3 rounded-xl gap-1">
            <span className="text-[10px] text-[#94a3b8]">FAILED / DLQ</span>
            <span className="text-base font-bold text-[#f43f5e]">
              {results.summary.totalFailed.toLocaleString()}
            </span>
          </Card>
          <Card className="p-3 rounded-xl gap-1">
            <span className="text-[10px] text-[#94a3b8]">GATEWAY P95 LATENCY</span>
            <span className="text-base font-bold text-[#a855f7]">
              {results.summary.p95LatencyMs.toFixed(2)} ms
            </span>
          </Card>
        </div>

        {/* Additional Config & Peak Throughput Info */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-mono text-[#94a3b8]">
          <span>
            Target: <b className="text-white">{results.config.targetRps.toLocaleString()} RPS</b>
          </span>
          <span>
            Strategy:{' '}
            <b className="text-[#00f0ff]">{results.config.routingStrategy.replace(/_/g, ' ')}</b>
          </span>
          <span>
            Workers: <b className="text-[#10b981]">{results.workers.length} Nodes</b>
          </span>
          <span>
            Peak RPS:{' '}
            <b className="text-white">{results.summary.peakIncomingRps.toLocaleString()}</b>
          </span>
          <span>
            DLQ Size: <b className="text-[#f43f5e]">{results.summary.finalDlqSize}</b>
          </span>
        </div>

        {/* Strategy Breakdown Table for Full Suite Tests */}
        {activeBreakdown && Object.keys(activeBreakdown).length > 0 && (
          <div className="flex flex-col gap-2 p-3 rounded-xl bg-white/5 border border-[#a855f7]/30 font-mono text-xs">
            <div className="text-[11px] font-bold text-[#a855f7] flex items-center justify-between flex-wrap gap-2">
              <span>
                {results.isMultiLevel
                  ? 'AUTOMATED MULTI-LEVEL MATRIX BREAKDOWN'
                  : 'BENCHMARK BREAKDOWN'}
              </span>
              <span className="text-[10px] text-[#94a3b8]">
                Accepted work drained before each strategy switch
              </span>
            </div>

            {results.isMultiLevel && results.levelBreakdowns && (
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-0.5">
                <Button
                  type="button"
                  variant={selectedLevelTab === 0 ? 'cyan-subtle' : 'outline'}
                  size="xs"
                  onClick={() => setSelectedLevelTab(0)}
                  className="font-mono font-bold"
                >
                  ALL TIERS (AGGREGATE)
                </Button>
                {[1, 2, 3, 4].map((lvl) => (
                  <Button
                    key={lvl}
                    type="button"
                    variant={selectedLevelTab === lvl ? 'purple' : 'outline'}
                    size="xs"
                    onClick={() => setSelectedLevelTab(lvl)}
                    className="font-mono font-bold"
                  >
                    LEVEL {lvl}{' '}
                    {lvl === 1
                      ? '(2.5k RPS)'
                      : lvl === 2
                        ? '(4.2k RPS)'
                        : lvl === 3
                          ? '(5.8k RPS)'
                          : '(7.5k RPS)'}
                  </Button>
                ))}
              </div>
            )}

            <div className="overflow-x-auto max-h-[160px]">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[#64748b] border-b border-white/10">
                  <tr>
                    <th className="py-1.5 px-2 font-semibold">ROUTING STRATEGY</th>
                    <th className="py-1.5 px-2 text-right font-semibold">INGRESSED</th>
                    <th className="py-1.5 px-2 text-right font-semibold">PROCESSED</th>
                    <th className="py-1.5 px-2 text-right font-semibold">FAILED</th>
                    <th className="py-1.5 px-2 text-right font-semibold">DRAIN RPS</th>
                    <th className="py-1.5 px-2 text-right font-semibold">P95 LATENCY</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {(Object.values(activeBreakdown) as StrategyBenchmark[]).map((st) => (
                    <tr key={st.strategy} className="hover:bg-white/5 transition-colors">
                      <td className="py-1.5 px-2 font-bold text-[#00f0ff]">
                        {st.strategy.replace(/_/g, ' ')}
                      </td>
                      <td className="py-1.5 px-2 text-right text-white">
                        {st.ingressed.toLocaleString()}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[#10b981] font-semibold">
                        {st.processed.toLocaleString()}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[#f43f5e]">
                        {st.failed.toLocaleString()}
                      </td>
                      <td className="py-1.5 px-2 text-right font-bold text-white">
                        {st.avgThroughputRps.toLocaleString()}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[#a855f7]">
                        {st.p95LatencyMs.toFixed(2)} ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* JSON Viewer */}
        <div className="flex-1 min-h-[180px] max-h-[300px] overflow-auto border border-white/10 rounded-xl bg-[#060a12] p-3 text-xs font-mono text-[#cbd5e1] select-all">
          <pre className="whitespace-pre">{jsonString}</pre>
        </div>

        {/* Actions */}
        <div className="flex justify-between items-center flex-wrap gap-3 pt-2 border-t border-white/10">
          <div className="text-[11px] font-mono text-[#64748b]">
            Run ID: {results.runId} • {new Date(results.startedAt).toLocaleTimeString()} -{' '}
            {new Date(results.completedAt).toLocaleTimeString()}
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant={copied ? 'success' : 'secondary'}
              size="sm"
              onClick={handleCopy}
              className="font-mono font-bold gap-1.5"
            >
              {copied ? '✓ COPIED JSON' : 'COPY JSON'}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleDownload}
              className="font-mono font-bold gap-1.5"
            >
              DOWNLOAD JSON
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
