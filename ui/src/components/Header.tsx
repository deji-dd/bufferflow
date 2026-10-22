import { AlertTriangle, FileJson, Gauge, History, Layers, Moon, Sun } from 'lucide-react';
import type React from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface HeaderProps {
  p95LatencyMs: number;
  bufferCapacity: number;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  hasResults?: boolean;
  onOpenResults?: () => void;
  historyCount?: number;
  onOpenHistory?: () => void;
  trafficActive?: boolean;
  dlqSize?: number;
  onOpenDlq?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  p95LatencyMs,
  bufferCapacity,
  theme,
  onToggleTheme,
  hasResults,
  onOpenResults,
  historyCount = 0,
  onOpenHistory,
  trafficActive = false,
  dlqSize = 0,
  onOpenDlq,
}) => {
  return (
    <header className="glass-card rounded-2xl px-6 py-4 flex justify-between items-center flex-wrap gap-4">
      {/* Brand and System Status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-wider font-sans text-white">
                BUFFERFLOW
              </span>
            </div>
          </div>
        </div>

        {/* Live Traffic Pill */}
        <div className="hidden lg:flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/10 text-[11px] font-mono">
          <span className="relative flex h-2 w-2">
            {trafficActive && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00f0ff] opacity-75" />
            )}
            <span
              className={cn(
                'relative inline-flex rounded-full h-2 w-2',
                trafficActive ? 'bg-[#00f0ff]' : 'bg-[#10b981]'
              )}
            />
          </span>
          <span className={trafficActive ? 'text-[#00f0ff] font-semibold' : 'text-[#94a3b8]'}>
            {trafficActive ? 'BURST ACTIVE' : 'IDLE'}
          </span>
        </div>
      </div>

      {/* Center/Right Metrics & Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Gateway & Buffer telemetry chips */}
        <div className="hidden md:flex items-center gap-3">
          <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-white/[0.03] border border-white/10">
            <div className="size-7 rounded-lg bg-[#00f0ff]/10 border border-[#00f0ff]/25 flex items-center justify-center text-[#00f0ff]">
              <Gauge className="size-3.5" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[9px] font-mono uppercase font-semibold text-[#64748b] tracking-wider">
                Gateway P95
              </span>
              <span className="font-mono text-xs font-bold text-[#00f0ff]">
                {p95LatencyMs > 0 ? `${p95LatencyMs.toFixed(2)} ms` : '-- ms'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-white/[0.03] border border-white/10">
            <div className="size-7 rounded-lg bg-[#a855f7]/10 border border-[#a855f7]/25 flex items-center justify-center text-[#a855f7]">
              <Layers className="size-3.5" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[9px] font-mono uppercase font-semibold text-[#64748b] tracking-wider">
                Buffer Capacity
              </span>
              <span className="font-mono text-xs font-bold text-[#a855f7]">
                {bufferCapacity.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {dlqSize > 0 && onOpenDlq && (
            <Button
              type="button"
              variant="destructive-subtle"
              size="sm"
              onClick={onOpenDlq}
              className="font-mono text-xs font-bold gap-1.5 animate-pulse"
              title="Open Dead Letter Queue"
            >
              <AlertTriangle className="size-3.5" />
              <span>DLQ ({dlqSize})</span>
            </Button>
          )}

          {onOpenHistory && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenHistory}
              className="font-mono font-bold gap-1.5 text-xs border-white/10 hover:border-[#00f0ff]/40 hover:text-[#00f0ff]"
              title="View Historical Test Runs & Benchmarks"
            >
              <History className="size-3.5 text-[#00f0ff]" />
              <span>HISTORY</span>
              {historyCount > 0 && (
                <span className="h-4 min-w-4 px-1 rounded-full bg-[#00f0ff]/20 text-[#00f0ff] text-[10px] flex items-center justify-center font-bold">
                  {historyCount > 99 ? '99+' : historyCount}
                </span>
              )}
            </Button>
          )}

          {hasResults && onOpenResults && (
            <Button
              type="button"
              variant="cyan-subtle"
              size="sm"
              onClick={onOpenResults}
              className="font-mono font-bold gap-1.5 text-xs"
              title="Export Benchmark & Stress Test Results"
            >
              <FileJson className="size-3.5" />
              <span>RESULTS EXPORT</span>
            </Button>
          )}

          <div className="h-4 w-px bg-white/10 hidden sm:block mx-1" />

          <a
            href="https://github.com/deji-dd/bufferflow"
            target="_blank"
            rel="noreferrer"
            className={cn(
              buttonVariants({ variant: 'outline', size: 'icon-sm' }),
              'transition-colors hover:text-white'
            )}
            title="View GitHub Repository"
            aria-label="GitHub Repository"
          >
            <svg className="size-4 fill-current" viewBox="0 0 24 24" role="img" aria-label="GitHub">
              <title>GitHub</title>
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </svg>
          </a>

          {/* Theme switcher: clean icon-only button with NO label */}
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? (
              <Sun className="size-4 text-[#f59e0b] transition-transform hover:rotate-45" />
            ) : (
              <Moon className="size-4 text-[#00f0ff] transition-transform hover:-rotate-12" />
            )}
          </Button>
        </div>
      </div>
    </header>
  );
};
