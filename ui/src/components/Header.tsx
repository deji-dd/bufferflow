import type React from 'react';

interface HeaderProps {
  p95LatencyMs: number;
  bufferCapacity: number;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  p95LatencyMs,
  bufferCapacity,
  theme,
  onToggleTheme,
}) => {
  return (
    <header className="glass-card rounded-2xl px-7 py-5 flex justify-between items-center flex-wrap gap-4">
      <div className="flex items-center gap-4">
        <div>
          <div className="text-xl font-bold tracking-wider flex items-center gap-2.5 font-sans">
            BUFFERFLOW{' '}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-6 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold tracking-wider text-[#64748b] uppercase">
            Gateway Latency (P95)
          </span>
          <span className="font-mono text-base font-semibold text-[#00f0ff]">
            {p95LatencyMs > 0 ? `${p95LatencyMs.toFixed(2)} ms` : '-- ms'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold tracking-wider text-[#64748b] uppercase">
            Buffer Capacity
          </span>
          <span className="font-mono text-base font-semibold text-[#a855f7]">
            {bufferCapacity.toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold tracking-wider text-[#64748b] uppercase">
            Theme
          </span>
          <button
            type="button"
            onClick={onToggleTheme}
            className="px-2.5 py-1 text-xs font-mono font-semibold rounded-lg bg-white/5 hover:bg-white/10 text-white border border-white/10 transition cursor-pointer flex items-center gap-1.5"
            aria-label="Toggle theme"
          >
            <span>{theme.toUpperCase()}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
