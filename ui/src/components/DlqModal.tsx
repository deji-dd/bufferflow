import type React from 'react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';

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
      const res = await apiFetch(`/api/dlq?session=${sessionId}`);
      const data = await res.json();
      if (data && !data.error) {
        setItems(data.items || []);
        setTotal(data.total || 0);
      }
    } catch {
      // Ignored in poller
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchDlqItems();
      const interval = setInterval(fetchDlqItems, 2000);
      return () => clearInterval(interval);
    }
  }, [isOpen, sessionId]);

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
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          className="max-w-4xl max-h-[85vh] flex flex-col p-6 gap-4"
          showCloseButton={false}
        >
          <DialogHeader className="border-b border-white/10 pb-3">
            <div className="flex justify-between items-center w-full">
              <div className="flex items-center gap-3">
                <Badge variant="rose" className="font-mono text-xs font-bold">
                  DEAD-LETTER QUEUE
                </Badge>
                <DialogTitle className="text-base font-bold text-white">
                  Failed Job Inspector &amp; Replay Console
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
              View and replay dead-letter queue failed items
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-between items-center flex-wrap gap-2 text-xs">
            <span className="text-[#94a3b8]">
              Total DLQ Backlog: <b className="text-white">{total}</b> entries
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="success-subtle"
                size="sm"
                disabled={actionInProgress || total === 0}
                onClick={handleReplayAll}
              >
                Replay All
              </Button>
              <Button
                type="button"
                variant="destructive-subtle"
                size="sm"
                disabled={actionInProgress || total === 0}
                onClick={() => setConfirmPurgeOpen(true)}
              >
                Purge All
              </Button>
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
                          <div className="text-[#64748b] text-[10px]">
                            Key: {item.idempotencyKey}
                          </div>
                        </td>
                        <td className="p-2.5">
                          <Badge variant="purple" className="text-[10px] px-1.5 py-0 font-normal">
                            {item.originalPayload?.schemaType || 'generic'}
                          </Badge>
                        </td>
                        <td className="p-2.5">{item.attempts}</td>
                        <td className="p-2.5 text-[#f43f5e]">{item.errorReason}</td>
                        <td className="p-2.5 text-[#94a3b8]">{time}</td>
                        <td className="p-2.5">
                          <Button
                            type="button"
                            variant="cyan-subtle"
                            size="xs"
                            disabled={actionInProgress}
                            onClick={() => handleReplaySingle(item.id)}
                          >
                            Replay
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog */}
      <Dialog open={confirmPurgeOpen} onOpenChange={setConfirmPurgeOpen}>
        <DialogContent
          className="max-w-md p-6 border-[#f43f5e]/40 text-center flex flex-col gap-4"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-white text-center">
              Purge Dead-Letter Queue?
            </DialogTitle>
            <DialogDescription className="text-xs text-[#94a3b8] text-center">
              This will permanently delete all failed task events currently in the Dead-Letter
              Queue. This operation cannot be reversed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-3 justify-center pt-2 sm:justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmPurgeOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={executePurge}>
              Confirm Purge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
