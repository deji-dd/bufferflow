import type React from 'react';
import { useEffect, useState } from 'react';
import type { DLQItem } from '../../../src/core/types';

interface DlqModalProps {
  isOpen: boolean;
  sessionId: string;
  onClose: () => void;
  onReplaySingle: (id: string) => Promise<void>;
  onReplayAll: () => Promise<void>;
  onPurge: () => Promise<void>;
}

export const DlqModal: React.FC<DlqModalProps> = ({
  isOpen,
  sessionId,
  onClose,
  onReplaySingle,
  onReplayAll,
  onPurge,
}) => {
  const [items, setItems] = useState<DLQItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [confirmPurgeOpen, setConfirmPurgeOpen] = useState(false);

  const fetchDlqItems = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/dlq?limit=50', {
        headers: { 'X-Session-Id': sessionId },
      });
      const data = await res.json();
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch {
      // Ignored
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchDlqItems();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleReplaySingle = async (id: string) => {
    setActionInProgress(true);
    await onReplaySingle(id);
    await fetchDlqItems();
    setActionInProgress(false);
  };

  const handleReplayAll = async () => {
    setActionInProgress(true);
    await onReplayAll();
    await fetchDlqItems();
    setActionInProgress(false);
  };

  const executePurge = async () => {
    setConfirmPurgeOpen(false);
    setActionInProgress(true);
    await onPurge();
    await fetchDlqItems();
    setActionInProgress(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      className="fixed inset-0 bg-black/75 backdrop-blur-md z-50 flex items-center justify-center p-6"
      id="dlq-modal"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass-card rounded-2xl max-w-4xl w-full max-h-[85vh] flex flex-col p-6 gap-4 relative">
        <div className="flex justify-between items-center border-b border-white/10 pb-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-[#f43f5e]/20 text-[#f43f5e] border border-[#f43f5e]/40">
              DEAD-LETTER QUEUE
            </span>
            <h3 className="text-base font-bold text-white">
              Failed Job Inspector &amp; Replay Console
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#94a3b8] hover:text-white font-mono text-base px-2 py-1 rounded bg-white/5 hover:bg-white/10 cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="flex justify-between items-center flex-wrap gap-2 text-xs">
          <span className="text-[#94a3b8]">
            Total DLQ Backlog: <b className="text-white">{total}</b> entries
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={actionInProgress || total === 0}
              onClick={handleReplayAll}
              className="px-3 py-1.5 rounded-lg bg-[#10b981]/20 text-[#10b981] border border-[#10b981]/40 hover:bg-[#10b981] hover:text-white font-semibold transition cursor-pointer disabled:opacity-50"
            >
              Replay All
            </button>
            <button
              type="button"
              disabled={actionInProgress || total === 0}
              onClick={() => setConfirmPurgeOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-[#f43f5e]/20 text-[#f43f5e] border border-[#f43f5e]/40 hover:bg-[#f43f5e] hover:text-white font-semibold transition cursor-pointer disabled:opacity-50"
            >
              Purge All
            </button>
          </div>
        </div>

        {/* DLQ Table */}
        <div className="flex-1 overflow-auto border border-white/10 rounded-xl bg-[#080d16]/50">
          <table className="w-full text-left border-collapse text-xs font-mono">
            <thead className="sticky top-0 bg-[#0d1424] text-[#94a3b8] border-b border-white/10">
              <tr>
                <th className="p-2.5">Task ID / Key</th>
                <th className="p-2.5">Schema</th>
                <th className="p-2.5">Attempts</th>
                <th className="p-2.5">Failure Reason</th>
                <th className="p-2.5">Failed At</th>
                <th className="p-2.5">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-[#94a3b8]">
                    Loading DLQ items...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-[#94a3b8]">
                    No dead-letter entries present. All messages processed successfully.
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const time = new Date(item.failedAt).toLocaleTimeString();
                  return (
                    <tr key={item.id} className="hover:bg-white/5 transition">
                      <td className="p-2.5">
                        <div className="text-[#00f0ff]">{item.id}</div>
                        <div className="text-[#64748b] text-[10px]">Key: {item.idempotencyKey}</div>
                      </td>
                      <td className="p-2.5">
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#a855f7]/20 text-[#a855f7] border border-[#a855f7]/30">
                          {item.originalPayload?.schemaType || 'generic'}
                        </span>
                      </td>
                      <td className="p-2.5">{item.attempts}</td>
                      <td className="p-2.5 text-[#f43f5e]">{item.errorReason}</td>
                      <td className="p-2.5 text-[#94a3b8]">{time}</td>
                      <td className="p-2.5">
                        <button
                          type="button"
                          disabled={actionInProgress}
                          onClick={() => handleReplaySingle(item.id)}
                          className="px-2 py-0.5 text-[10px] font-semibold rounded bg-[#00f0ff]/20 text-[#00f0ff] border border-[#00f0ff]/40 hover:bg-[#00f0ff] hover:text-black cursor-pointer transition disabled:opacity-50"
                        >
                          Replay
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Confirmation Dialog Overlay */}
        {confirmPurgeOpen && (
          <div
            role="alertdialog"
            aria-modal="true"
            className="absolute inset-0 bg-black/80 backdrop-blur-sm rounded-2xl flex items-center justify-center p-6 z-10"
          >
            <div className="glass-card rounded-xl p-6 max-w-md w-full border border-[#f43f5e]/40 shadow-2xl flex flex-col gap-4 text-center">
              <div className="text-base font-bold text-white">Purge Dead-Letter Queue?</div>
              <p className="text-xs text-[#94a3b8]">
                This will permanently delete all failed task events currently in the Dead-Letter
                Queue. This operation cannot be reversed.
              </p>
              <div className="flex gap-3 justify-center pt-2">
                <button
                  type="button"
                  onClick={() => setConfirmPurgeOpen(false)}
                  className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-semibold cursor-pointer transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={executePurge}
                  className="px-4 py-2 rounded-lg bg-[#f43f5e] hover:bg-[#ff4d6d] text-white text-xs font-bold shadow-[0_0_15px_rgba(244,63,94,0.4)] cursor-pointer transition"
                >
                  Confirm Purge
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
