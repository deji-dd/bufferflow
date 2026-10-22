import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { StrategyBenchmark, WorkerInfo } from '../core/types';

export const testRunsTable = pgTable(
  'test_runs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    sessionId: text('session_id').notNull(),
    testType: text('test_type').notNull(), // 'FULL_SUITE' | 'STANDARD'
    isMultiLevel: boolean('is_multi_level').default(false),
    completedReason: text('completed_reason').notNull(),
    durationSec: integer('duration_sec').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    targetRps: integer('target_rps').notNull(),
    workerCount: integer('worker_count').notNull(),
    peakIncomingRps: integer('peak_incoming_rps').default(0),
    peakAcceptedRps: integer('peak_accepted_rps').default(0),
    peakDrainedRps: integer('peak_drained_rps').default(0),
    p50LatencyMs: integer('p50_latency_ms').default(0),
    p95LatencyMs: integer('p95_latency_ms').default(0),
    p99LatencyMs: integer('p99_latency_ms').default(0),
    totalIngressed: integer('total_ingressed').default(0),
    totalAccepted: integer('total_accepted').default(0),
    totalProcessed: integer('total_processed').default(0),
    totalFailed: integer('total_failed').default(0),
    summary: jsonb('summary').$type<Record<string, any>>().notNull(),
    config: jsonb('config').$type<Record<string, any>>().notNull(),
    strategyBreakdown: jsonb('strategy_breakdown').$type<Record<string, StrategyBenchmark>>(),
    levelBreakdowns:
      jsonb('level_breakdowns').$type<Record<number, Record<string, StrategyBenchmark>>>(),
    workers: jsonb('workers').$type<WorkerInfo[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_test_runs_created').on(table.createdAt.desc()),
    index('idx_test_runs_session').on(table.sessionId),
  ]
);

export type TestRunRecord = typeof testRunsTable.$inferSelect;
export type NewTestRunRecord = typeof testRunsTable.$inferInsert;
