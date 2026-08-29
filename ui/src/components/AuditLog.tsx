import type React from 'react';

export interface LogItem {
  id: string;
  time: string;
  text: string;
  colorClass: string;
}

interface AuditLogProps {
  logs: LogItem[];
  onClear: () => void;
}

export const AuditLog: React.FC<AuditLogProps> = ({ logs, onClear }) => {
  return (
    <section className="glass-card rounded-2xl p-6">
      <div className="flex justify-between items-center mb-3">
        <div>
          <h2 className="text-sm font-bold tracking-wider uppercase text-white">
            Audit Stream &amp; System Events
          </h2>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="px-2.5 py-1 text-xs font-mono font-semibold rounded bg-white/5 hover:bg-white/10 text-[#94a3b8] hover:text-white border border-white/10 transition cursor-pointer"
        >
          CLEAR
        </button>
      </div>

      <div
        id="terminal-feed"
        className="w-full h-[140px] bg-[#04060a] border border-white/10 rounded-xl p-3 font-mono text-xs overflow-y-auto flex flex-col gap-1"
      >
        {logs.length === 0 ? (
          <div className="text-[#64748b] italic">No event logs recorded yet.</div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="flex items-baseline gap-2">
              <span className="text-[#64748b] text-[10px] shrink-0">[{log.time}]</span>
              <span className={log.colorClass}>{log.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
};
