import { desc, eq, or, sql } from 'drizzle-orm';
import type { FullSuiteResults } from '../core/types';
import { getDb, isDbConnected } from './index';
import { type NewTestRunRecord, testRunsTable } from './schema';

export interface HistoricalRunSummary {
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

export class HistoryRepository {
  private inMemoryRuns: Map<string, any> = new Map();
  private maxInMemory: number = 50;

  public async saveTestRun(results: FullSuiteResults | any): Promise<void> {
    if (!results?.runId) return;

    const summary = results.summary || {};
    const config = results.config || {};
    const _peakThroughput = Math.max(
      summary.peakAcceptedRps || 0,
      summary.peakDrainedRps || 0,
      summary.peakIncomingRps || 0
    );

    const record: NewTestRunRecord = {
      id: results.id || results.runId,
      runId: results.runId,
      sessionId: results.sessionId || 'default',
      testType: results.testType || 'FULL_SUITE',
      isMultiLevel: Boolean(results.isMultiLevel),
      completedReason: results.completedReason || 'completed',
      durationSec: Number(results.durationSec) || 0,
      startedAt: new Date(results.startedAt || Date.now()),
      completedAt: new Date(results.completedAt || Date.now()),
      targetRps: Number(config.targetRps) || 0,
      workerCount: Number(config.workerCount) || 8,
      peakIncomingRps: Number(summary.peakIncomingRps) || 0,
      peakAcceptedRps: Number(summary.peakAcceptedRps) || 0,
      peakDrainedRps: Number(summary.peakDrainedRps) || 0,
      p50LatencyMs: Math.round(Number(summary.p50LatencyMs) || 0),
      p95LatencyMs: Math.round(Number(summary.p95LatencyMs) || 0),
      p99LatencyMs: Math.round(Number(summary.p99LatencyMs) || 0),
      totalIngressed: Number(summary.totalIngressed) || 0,
      totalAccepted: Number(summary.totalAccepted) || 0,
      totalProcessed: Number(summary.totalProcessed) || 0,
      totalFailed: Number(summary.totalFailed) || 0,
      summary: summary,
      config: config,
      strategyBreakdown: results.strategyBreakdown || null,
      levelBreakdowns: results.levelBreakdowns || null,
      workers: results.workers || null,
      createdAt: new Date(),
    };

    // Save to in-memory store
    this.inMemoryRuns.set(record.runId, results);
    if (this.inMemoryRuns.size > this.maxInMemory) {
      const oldestKey = this.inMemoryRuns.keys().next().value;
      if (oldestKey) this.inMemoryRuns.delete(oldestKey);
    }

    // Persist to Postgres if available
    try {
      const db = await getDb();
      if (db && isDbConnected()) {
        await db
          .insert(testRunsTable)
          .values(record)
          .onConflictDoUpdate({
            target: testRunsTable.id,
            set: {
              completedReason: record.completedReason,
              completedAt: record.completedAt,
              durationSec: record.durationSec,
              summary: record.summary,
              strategyBreakdown: record.strategyBreakdown,
              levelBreakdowns: record.levelBreakdowns,
              workers: record.workers,
              totalProcessed: record.totalProcessed,
              totalFailed: record.totalFailed,
            },
          });
      }
    } catch (err: any) {
      console.warn(
        `[Bufferflow History] Failed to persist test run to PostgreSQL: ${err?.message}`
      );
    }
  }

  public async listRuns(
    limit: number = 50,
    offset: number = 0
  ): Promise<{ runs: HistoricalRunSummary[]; total: number; isPostgres: boolean }> {
    try {
      const db = await getDb();
      if (db && isDbConnected()) {
        const [countRes] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(testRunsTable);
        const total = Number(countRes?.count || 0);

        const rows = await db
          .select()
          .from(testRunsTable)
          .orderBy(desc(testRunsTable.createdAt))
          .limit(limit)
          .offset(offset);

        const runs: HistoricalRunSummary[] = rows.map((r) => ({
          id: r.id,
          runId: r.runId,
          sessionId: r.sessionId,
          testType: r.testType,
          isMultiLevel: Boolean(r.isMultiLevel),
          completedReason: r.completedReason,
          durationSec: r.durationSec,
          startedAt: r.startedAt.toISOString(),
          completedAt: r.completedAt.toISOString(),
          targetRps: r.targetRps,
          workerCount: r.workerCount,
          peakThroughputRps: Math.max(
            r.peakAcceptedRps || 0,
            r.peakDrainedRps || 0,
            r.peakIncomingRps || 0
          ),
          p95LatencyMs: r.p95LatencyMs || 0,
          totalProcessed: r.totalProcessed || 0,
          totalFailed: r.totalFailed || 0,
          createdAt: r.createdAt.toISOString(),
        }));

        return { runs, total, isPostgres: true };
      }
    } catch (err: any) {
      console.warn(`[Bufferflow History] Error querying PostgreSQL: ${err?.message}`);
    }

    // In-memory fallback
    const all = Array.from(this.inMemoryRuns.values()).reverse();
    const total = all.length;
    const paged = all.slice(offset, offset + limit);

    const runs: HistoricalRunSummary[] = paged.map((r: any) => ({
      id: r.id || r.runId,
      runId: r.runId,
      sessionId: r.sessionId || 'default',
      testType: r.testType || 'FULL_SUITE',
      isMultiLevel: Boolean(r.isMultiLevel),
      completedReason: r.completedReason || 'completed',
      durationSec: Number(r.durationSec) || 0,
      startedAt: r.startedAt || new Date().toISOString(),
      completedAt: r.completedAt || new Date().toISOString(),
      targetRps: Number(r.config?.targetRps) || 0,
      workerCount: Number(r.config?.workerCount) || 8,
      peakThroughputRps: Math.max(
        r.summary?.peakAcceptedRps || 0,
        r.summary?.peakDrainedRps || 0,
        r.summary?.peakIncomingRps || 0
      ),
      p95LatencyMs: Math.round(Number(r.summary?.p95LatencyMs) || 0),
      totalProcessed: Number(r.summary?.totalProcessed) || 0,
      totalFailed: Number(r.summary?.totalFailed) || 0,
      createdAt: r.createdAt || r.completedAt || new Date().toISOString(),
    }));

    return { runs, total, isPostgres: false };
  }

  public async getRunById(runIdOrId: string): Promise<any | null> {
    try {
      const db = await getDb();
      if (db && isDbConnected()) {
        const [row] = await db
          .select()
          .from(testRunsTable)
          .where(or(eq(testRunsTable.id, runIdOrId), eq(testRunsTable.runId, runIdOrId)))
          .limit(1);

        if (row) {
          return {
            id: row.id,
            runId: row.runId,
            sessionId: row.sessionId,
            testType: row.testType,
            isMultiLevel: row.isMultiLevel,
            completedReason: row.completedReason,
            durationSec: row.durationSec,
            startedAt: row.startedAt.toISOString(),
            completedAt: row.completedAt.toISOString(),
            config: row.config,
            summary: row.summary,
            strategyBreakdown: row.strategyBreakdown,
            levelBreakdowns: row.levelBreakdowns,
            workers: row.workers,
            createdAt: row.createdAt.toISOString(),
          };
        }
      }
    } catch (err: any) {
      console.warn(`[Bufferflow History] Error querying run by id: ${err?.message}`);
    }

    // In-memory fallback
    for (const [key, val] of this.inMemoryRuns.entries()) {
      if (key === runIdOrId || val.id === runIdOrId || val.runId === runIdOrId) {
        return val;
      }
    }

    return null;
  }

  public async deleteRun(runIdOrId: string): Promise<boolean> {
    let deleted = false;
    if (this.inMemoryRuns.has(runIdOrId)) {
      this.inMemoryRuns.delete(runIdOrId);
      deleted = true;
    }
    for (const [k, v] of this.inMemoryRuns.entries()) {
      if (v.id === runIdOrId || v.runId === runIdOrId) {
        this.inMemoryRuns.delete(k);
        deleted = true;
      }
    }

    try {
      const db = await getDb();
      if (db && isDbConnected()) {
        const _res = await db
          .delete(testRunsTable)
          .where(or(eq(testRunsTable.id, runIdOrId), eq(testRunsTable.runId, runIdOrId)));
        deleted = true;
      }
    } catch (err: any) {
      console.warn(`[Bufferflow History] Error deleting run: ${err?.message}`);
    }

    return deleted;
  }
}

export const historyRepository = new HistoryRepository();
