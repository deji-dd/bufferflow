import { Dices, Lock, SlidersHorizontal, Sparkles, Square, Zap } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

import type {
  BurstProgress,
  SuiteProgress,
  TrafficConfig as ServerTrafficConfig,
} from '../../../src/core/types';

// UI traffic config extends the server's traffic-generator config with the
// runtime worker/strategy knobs that are sent along with a start request.
export interface TrafficConfig extends ServerTrafficConfig {
  workerCount: number;
  routingStrategy: string;
}

export interface IntensityPreset {
  level: number;
  name: string;
  badge: string;
  badgeVariant: 'emerald' | 'cyan' | 'amber' | 'rose';
  targetRps: number;
  downstreamLatencyMs: number;
  failureRate: number;
  workerCount: number;
  durationSec: number;
  idempotencyCollisionRate: number;
}

export const INTENSITY_PRESETS: IntensityPreset[] = [
  {
    level: 1,
    name: 'Moderate',
    badge: 'STEADY',
    badgeVariant: 'emerald',
    targetRps: 2500,
    downstreamLatencyMs: 15,
    failureRate: 5,
    workerCount: 8,
    durationSec: 15,
    idempotencyCollisionRate: 4,
  },
  {
    level: 2,
    name: 'High Pressure',
    badge: 'HEAVY',
    badgeVariant: 'cyan',
    targetRps: 4200,
    downstreamLatencyMs: 40,
    failureRate: 12,
    workerCount: 8,
    durationSec: 15,
    idempotencyCollisionRate: 6,
  },
  {
    level: 3,
    name: 'Extreme Stress',
    badge: 'SURGE',
    badgeVariant: 'amber',
    targetRps: 5800,
    downstreamLatencyMs: 65,
    failureRate: 20,
    workerCount: 12,
    durationSec: 20,
    idempotencyCollisionRate: 8,
  },
  {
    level: 4,
    name: 'Catastrophic',
    badge: 'CRITICAL',
    badgeVariant: 'rose',
    targetRps: 7500,
    downstreamLatencyMs: 95,
    failureRate: 28,
    workerCount: 16,
    durationSec: 25,
    idempotencyCollisionRate: 12,
  },
];

interface ControlMatrixProps {
  config: TrafficConfig;
  trafficActive: boolean;
  burstProgress?: BurstProgress;
  suiteProgress?: SuiteProgress;
  isServerRunningTest?: boolean;
  onChange: (updated: Partial<TrafficConfig>) => void;
  onStart: () => void;
  onStartFullTest: () => void;
  onStop: () => void;
  onRandomize: () => void;
}

export const ControlMatrix: React.FC<ControlMatrixProps> = ({
  config,
  trafficActive,
  burstProgress,
  suiteProgress,
  isServerRunningTest = false,
  onChange,
  onStart,
  onStartFullTest,
  onStop,
  onRandomize,
}) => {
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const isUnlimited = !!(config.isUnlimited || config.durationSec === 0);
  const isTestRunning = trafficActive || isServerRunningTest;

  const currentMatchingLevel = INTENSITY_PRESETS.find(
    (p) =>
      p.targetRps === config.targetRps &&
      p.failureRate === config.failureRate &&
      p.downstreamLatencyMs === config.downstreamLatencyMs
  )?.level;

  const handleApplyPreset = (preset: IntensityPreset) => {
    onChange({
      targetRps: preset.targetRps,
      downstreamLatencyMs: preset.downstreamLatencyMs,
      failureRate: preset.failureRate,
      workerCount: preset.workerCount,
      durationSec: preset.durationSec,
      idempotencyCollisionRate: preset.idempotencyCollisionRate,
      isUnlimited: false,
    });
  };

  return (
    <>
      {/* Root Execution Control Bar */}
      <div className="glass-card rounded-2xl p-5 flex flex-col gap-4">
        {/* Header row: Title + 3 Primary Action Buttons */}
        <div className="flex justify-between items-center flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div>
              <h3 className="text-sm font-bold tracking-wider uppercase text-white flex items-center gap-2">
                Controls
              </h3>
            </div>
          </div>

          {/* 3 Main Action Buttons */}
          <div className="flex items-center gap-2.5 flex-wrap">
            {/* 1. Automated Full Test */}
            <Button
              type="button"
              variant="gradient"
              size="default"
              disabled={isTestRunning}
              onClick={onStartFullTest}
              className="font-mono text-xs font-bold gap-2 !text-white shadow-md cursor-pointer"
              title="Automated benchmark of all 4 load tiers × 7 routing strategies (28 benchmarks total)"
            >
              {isServerRunningTest ? (
                <>
                  <span className="size-2 rounded-full bg-white animate-ping" />
                  <span>FULL TEST RUNNING...</span>
                </>
              ) : (
                <>
                  <Sparkles className="size-3.5" />
                  <span>AUTOMATED FULL TEST</span>
                </>
              )}
            </Button>

            {/* 2. Manual Test (Leads to Config Modal) */}
            <Button
              type="button"
              variant={trafficActive && !isServerRunningTest ? 'cyan-subtle' : 'default'}
              size="default"
              onClick={() => setManualModalOpen(true)}
              className="font-mono text-xs font-bold gap-2 cursor-pointer"
              title={
                trafficActive
                  ? 'View manual test parameters (locked while running)'
                  : 'Configure and start manual traffic test'
              }
            >
              <SlidersHorizontal className="size-3.5" />
              <span>
                {trafficActive && !isServerRunningTest ? 'MANUAL TEST (RUNNING)' : 'MANUAL TEST'}
              </span>
            </Button>

            {/* 3. Stop Button (Initially Disabled) */}
            <Button
              type="button"
              variant={isTestRunning ? 'destructive' : 'outline'}
              size="default"
              disabled={!isTestRunning}
              onClick={onStop}
              className={cn(
                'font-mono text-xs font-bold gap-2 transition-all cursor-pointer',
                isTestRunning && 'ring-2 ring-[#f43f5e]/50 animate-pulse'
              )}
              title={isTestRunning ? 'Stop active traffic test' : 'No active test to stop'}
            >
              <Square className="size-3.5 fill-current" />
              <span>STOP</span>
            </Button>
          </div>
        </div>

        {/* Active Test Progress Banner when running */}
        {isTestRunning && (
          <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex flex-col gap-2 transition-all">
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-white flex items-center gap-2 font-mono">
                <span
                  className={cn(
                    'size-2 rounded-full animate-pulse',
                    isServerRunningTest ? 'bg-[#a855f7]' : 'bg-[#00f0ff]'
                  )}
                />
                {isServerRunningTest
                  ? suiteProgress?.totalLevels
                    ? `AUTOMATED MATRIX TEST [LEVEL ${suiteProgress.currentLevel}/${suiteProgress.totalLevels}]`
                    : 'AUTOMATED FULL TEST RUNNING'
                  : isUnlimited
                    ? 'MANUAL TEST RUNNING (CONTINUOUS)'
                    : 'MANUAL TEST BURST RUNNING'}
              </span>
              <span className="font-mono text-xs text-[#00f0ff] font-bold">
                {isServerRunningTest && suiteProgress
                  ? `Phase ${suiteProgress.currentIndex + 1}/${suiteProgress.totalStrategies} (${suiteProgress.elapsedSec}s / ${suiteProgress.totalDurationSec}s)`
                  : isUnlimited || burstProgress?.isUnlimited
                    ? `${burstProgress?.elapsedSec ?? 0}s / ∞ (UNLIMITED)`
                    : `${burstProgress?.elapsedSec ?? 0}s / ${burstProgress?.durationSec ?? config.durationSec}s (${burstProgress?.pct ?? 0}%)`}
              </span>
            </div>

            <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden relative">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-300',
                  isServerRunningTest
                    ? 'bg-gradient-to-r from-[#a855f7] via-[#ec4899] to-[#00f0ff] shadow-[0_0_12px_rgba(168,85,247,0.6)]'
                    : isUnlimited || burstProgress?.isUnlimited
                      ? 'w-full bg-gradient-to-r from-[#00f0ff] via-[#a855f7] to-[#10b981] animate-pulse shadow-[0_0_12px_rgba(0,240,255,0.6)]'
                      : 'bg-gradient-to-r from-[#00f0ff] via-[#a855f7] to-[#10b981] shadow-[0_0_12px_rgba(0,240,255,0.6)]'
                )}
                style={{
                  width: isServerRunningTest
                    ? `${suiteProgress?.pct ?? 0}%`
                    : isUnlimited || burstProgress?.isUnlimited
                      ? '100%'
                      : `${burstProgress?.pct ?? 0}%`,
                }}
              />
            </div>

            {isServerRunningTest && (
              <div className="flex justify-between items-center text-[11px] font-mono text-[#94a3b8]">
                <span>
                  Active Strategy:{' '}
                  <b className="text-[#00f0ff]">
                    {suiteProgress?.currentStrategy.replace(/_/g, ' ') || config.routingStrategy}
                  </b>
                </span>
                <span className="text-[10px] text-[#64748b]">
                  Settings locked while automated suite benchmark executes
                </span>
              </div>
            )}
          </div>
        )}

        {/* Standby Summary Pills & Quick Lvl 1 - 4 Presets when idle */}
        {!isTestRunning && (
          <div className="flex items-center justify-between text-xs text-[#94a3b8] flex-wrap gap-3 pt-1 border-t border-white/5 font-mono text-[11px]">
            {/* Quick Intensity Preset Switcher */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-mono text-[#64748b] uppercase tracking-wider">
                Presets:
              </span>
              {INTENSITY_PRESETS.map((p) => (
                <button
                  key={p.level}
                  type="button"
                  disabled={isTestRunning}
                  onClick={() => handleApplyPreset(p)}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] font-mono font-bold transition border cursor-pointer',
                    currentMatchingLevel === p.level
                      ? 'bg-[#00f0ff]/20 text-[#00f0ff] border-[#00f0ff]/40 shadow-xs'
                      : 'bg-white/5 text-[#94a3b8] border-white/10 hover:text-white hover:border-white/20'
                  )}
                  title={`Lvl ${p.level} (${p.name}): ${p.targetRps.toLocaleString()} RPS, ${p.failureRate}% err, ${p.downstreamLatencyMs}ms`}
                >
                  Lvl {p.level}
                </button>
              ))}
            </div>

            {/* Current Config Values */}
            <div className="flex items-center gap-3 flex-wrap">
              <span>
                Target: <b className="text-white">{config.targetRps.toLocaleString()} RPS</b>
              </span>
              <span>•</span>
              <span>
                Duration:{' '}
                <b className="text-white">
                  {isUnlimited ? 'Continuous' : `${config.durationSec}s`}
                </b>
              </span>
              <span>•</span>
              <span>
                Workers: <b className="text-white">{config.workerCount} Nodes</b>
              </span>
              <span>•</span>
              <span>
                Strategy:{' '}
                <b className="text-[#10b981]">{config.routingStrategy.replace(/_/g, ' ')}</b>
              </span>
              <span>•</span>
              <span>
                Faults:{' '}
                <b className={config.failureRate > 0 ? 'text-[#f43f5e]' : 'text-white'}>
                  {config.failureRate}% err / {config.downstreamLatencyMs}ms
                </b>
              </span>
              <button
                type="button"
                onClick={() => setManualModalOpen(true)}
                className="text-[#00f0ff] hover:underline cursor-pointer flex items-center gap-1 ml-1"
              >
                <span>Customize</span> &rarr;
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Manual Test Configuration Modal */}
      <Dialog open={manualModalOpen} onOpenChange={setManualModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>Test Configuration</span>
            </DialogTitle>
          </DialogHeader>

          {/* Locked Notice while test is running */}
          {isTestRunning && (
            <div className="p-3 rounded-xl bg-[#f59e0b]/15 border border-[#f59e0b]/40 flex items-center gap-2.5 text-xs text-[#f59e0b]">
              <Lock className="size-4 shrink-0" />
              <span>
                A test is currently running. Configuration is locked to preserve execution
                integrity. Stop the active test before making changes.
              </span>
            </div>
          )}

          <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-5 py-2">
            {/* Lvl 1 - 4 Stress Intensity Presets */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold text-[#94a3b8] flex items-center gap-1.5 font-mono">
                  <Zap className="size-3.5 text-[#00f0ff]" />
                  <span>STRESS INTENSITY PRESETS (LVL 1 - 4)</span>
                </span>
                <span className="text-[10px] font-mono text-[#64748b]">
                  Click to load preset benchmark targets
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {INTENSITY_PRESETS.map((preset) => {
                  const isSelected = currentMatchingLevel === preset.level;
                  return (
                    <button
                      key={preset.level}
                      type="button"
                      disabled={isTestRunning}
                      onClick={() => handleApplyPreset(preset)}
                      className={cn(
                        'p-2.5 rounded-xl border transition-all text-left flex flex-col gap-1 cursor-pointer select-none',
                        isSelected
                          ? 'bg-[#00f0ff]/15 border-[#00f0ff] shadow-[0_0_12px_rgba(0,240,255,0.25)] ring-1 ring-[#00f0ff]/50'
                          : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/[0.08]',
                        isTestRunning && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-bold text-white">
                          Lvl {preset.level}
                        </span>
                        <Badge
                          variant={preset.badgeVariant}
                          className="text-[8px] font-mono font-bold px-1 py-0 h-3.5"
                        >
                          {preset.badge}
                        </Badge>
                      </div>
                      <div className="text-[11px] font-semibold text-[#94a3b8] truncate">
                        {preset.name}
                      </div>
                      <div className="text-[10px] font-mono text-[#64748b] leading-tight mt-0.5">
                        <b className="text-white">{preset.targetRps.toLocaleString()}</b> RPS •{' '}
                        <b
                          className={preset.failureRate > 15 ? 'text-[#f43f5e]' : 'text-[#f59e0b]'}
                        >
                          {preset.failureRate}%
                        </b>{' '}
                        err • <b>{preset.downstreamLatencyMs}ms</b>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Target Throughput */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label
                  htmlFor="modal-input-target-rps"
                  className="text-xs font-semibold text-[#94a3b8]"
                >
                  TARGET INGRESS THROUGHPUT
                </label>
                <span className="font-mono text-xs font-semibold text-[#00f0ff]">
                  {config.targetRps.toLocaleString()} req/s
                </span>
              </div>
              <Slider
                id="modal-input-target-rps"
                min={100}
                max={8000}
                step={100}
                disabled={isTestRunning}
                value={[config.targetRps]}
                onValueChange={([val]) => onChange({ targetRps: val })}
                rangeClassName="bg-[#00f0ff]"
                thumbClassName="shadow-[0_0_8px_rgba(0,240,255,0.6)]"
              />
            </div>

            {/* Burst Duration with Unlimited Option */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label
                  htmlFor="modal-input-burst-duration"
                  className="text-xs font-semibold text-[#94a3b8]"
                >
                  BURST DURATION
                </label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant={isUnlimited ? 'purple' : 'outline'}
                    size="xs"
                    disabled={isTestRunning}
                    onClick={() => {
                      if (isUnlimited) {
                        onChange({ isUnlimited: false, durationSec: 15 });
                      } else {
                        onChange({ isUnlimited: true, durationSec: 0 });
                      }
                    }}
                    className="font-mono font-bold"
                  >
                    {isUnlimited ? '∞ UNLIMITED' : 'SET UNLIMITED'}
                  </Button>
                  <span className="font-mono text-xs font-semibold text-[#00f0ff]">
                    {isUnlimited ? '∞ Continuous' : `${config.durationSec} sec`}
                  </span>
                </div>
              </div>
              <Slider
                id="modal-input-burst-duration"
                min={5}
                max={90}
                step={5}
                disabled={isUnlimited || isTestRunning}
                value={[isUnlimited ? 90 : config.durationSec]}
                onValueChange={([val]) => onChange({ durationSec: val, isUnlimited: false })}
                rangeClassName="bg-[#00f0ff]"
                thumbClassName="shadow-[0_0_8px_rgba(0,240,255,0.6)]"
              />
            </div>

            {/* Failure & Latency Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label
                    htmlFor="modal-input-failure-rate"
                    className="text-[11px] font-semibold text-[#94a3b8]"
                  >
                    DOWNSTREAM FAILURE RATE
                  </label>
                  <span className="font-mono text-[11px] font-semibold text-[#f43f5e]">
                    {config.failureRate}%
                  </span>
                </div>
                <Slider
                  id="modal-input-failure-rate"
                  min={0}
                  max={60}
                  step={2}
                  disabled={isTestRunning}
                  value={[config.failureRate]}
                  onValueChange={([val]) => onChange({ failureRate: val })}
                  rangeClassName="bg-[#f43f5e]"
                  thumbClassName="shadow-[0_0_8px_rgba(244,63,94,0.6)]"
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label
                    htmlFor="modal-input-downstream-lat"
                    className="text-[11px] font-semibold text-[#94a3b8]"
                  >
                    DOWNSTREAM LATENCY
                  </label>
                  <span className="font-mono text-[11px] font-semibold text-[#f59e0b]">
                    {config.downstreamLatencyMs} ms
                  </span>
                </div>
                <Slider
                  id="modal-input-downstream-lat"
                  min={2}
                  max={100}
                  step={2}
                  disabled={isTestRunning}
                  value={[config.downstreamLatencyMs]}
                  onValueChange={([val]) => onChange({ downstreamLatencyMs: val })}
                  rangeClassName="bg-[#f59e0b]"
                  thumbClassName="shadow-[0_0_8px_rgba(245,158,11,0.6)]"
                />
              </div>
            </div>

            {/* Idempotency & Worker Count Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label
                    htmlFor="modal-input-idempotency-rate"
                    className="text-[11px] font-semibold text-[#94a3b8]"
                  >
                    IDEMPOTENCY DUPE COLLISION
                  </label>
                  <span className="font-mono text-[11px] font-semibold text-[#f59e0b]">
                    {config.idempotencyCollisionRate}%
                  </span>
                </div>
                <Slider
                  id="modal-input-idempotency-rate"
                  min={0}
                  max={30}
                  step={1}
                  disabled={isTestRunning}
                  value={[config.idempotencyCollisionRate]}
                  onValueChange={([val]) => onChange({ idempotencyCollisionRate: val })}
                  rangeClassName="bg-[#f59e0b]"
                  thumbClassName="shadow-[0_0_8px_rgba(245,158,11,0.6)]"
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label
                    htmlFor="modal-input-worker-count"
                    className="text-[11px] font-semibold text-[#94a3b8]"
                  >
                    WORKER POOL SIZE
                  </label>
                  <span className="font-mono text-[11px] font-semibold text-[#10b981]">
                    {config.workerCount} Nodes
                  </span>
                </div>
                <Slider
                  id="modal-input-worker-count"
                  min={2}
                  max={24}
                  step={2}
                  disabled={isTestRunning}
                  value={[config.workerCount]}
                  onValueChange={([val]) => onChange({ workerCount: val })}
                  rangeClassName="bg-[#10b981]"
                  thumbClassName="shadow-[0_0_8px_rgba(16,185,129,0.6)]"
                />
              </div>
            </div>

            {/* Routing Strategy Select */}
            <div>
              <label
                htmlFor="modal-select-routing"
                className="block text-xs font-semibold text-[#94a3b8] mb-1"
              >
                DISPATCH ROUTING STRATEGY
              </label>
              <Select
                disabled={isTestRunning}
                value={config.routingStrategy}
                onValueChange={(val) => onChange({ routingStrategy: val })}
              >
                <SelectTrigger id="modal-select-routing">
                  <SelectValue placeholder="Select routing strategy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="LEAST_CONNECTIONS">
                      Least Connections (Dispatches to least busy worker)
                    </SelectItem>
                    <SelectItem value="WEIGHTED_ROUND_ROBIN">
                      Weighted Round-Robin (Weighted node tiers)
                    </SelectItem>
                    <SelectItem value="ROUND_ROBIN">
                      Standard Round-Robin (Cyclic round-robin)
                    </SelectItem>
                    <SelectItem value="POWER_OF_TWO_CHOICES">
                      Power of Two Choices (Best of 2 random workers)
                    </SelectItem>
                    <SelectItem value="WEIGHTED_LEAST_CONNECTIONS">
                      Weighted Least Connections (Active jobs / worker weight)
                    </SelectItem>
                    <SelectItem value="RANDOM">
                      Random Selection (Uniform random distribution)
                    </SelectItem>
                    <SelectItem value="CONSISTENT_HASH">
                      Consistent Hashing (Payload/Idempotency key affinity)
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </form>

          {/* Modal Footer Actions */}
          <DialogFooter className="flex justify-between items-center sm:justify-between w-full pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isTestRunning}
              onClick={onRandomize}
              className="gap-1.5 font-mono text-xs cursor-pointer"
            >
              <Dices className="size-3.5" />
              <span>RANDOMIZE</span>
            </Button>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setManualModalOpen(false)}
                className="cursor-pointer"
              >
                Close
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={isTestRunning}
                onClick={() => {
                  onStart();
                  setManualModalOpen(false);
                }}
                className="font-mono font-bold text-xs cursor-pointer"
              >
                {isTestRunning
                  ? 'TEST IN PROGRESS...'
                  : `START TEST (${config.targetRps.toLocaleString()} RPS)`}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
