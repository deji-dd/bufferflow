#!/usr/bin/env bun
/**
 * One-off backfill for historical runs that were stored before the
 * STANDARD/FULL_SUITE distinction was fixed.
 *
 * Old manual burst runs defaulted to test_type = 'FULL_SUITE' but never had a
 * strategy breakdown. Completed suites always have a strategy_breakdown (and
 * multi-level suites a level_breakdowns object).
 *
 * Usage:
 *   bun run db:backfill:test-type --dry-run
 *   bun run db:backfill:test-type
 */
import { existsSync } from 'node:fs';
import postgres from 'postgres';

const dryRun = process.argv.includes('--dry-run');

const customUrl = process.env.DATABASE_URL;
const defaultSocketDir = existsSync('/var/run/postgresql')
  ? '/var/run/postgresql'
  : existsSync('/tmp/.s.PGSQL.5432')
    ? '/tmp'
    : undefined;
const host = process.env.POSTGRES_HOST || defaultSocketDir;
const database = process.env.POSTGRES_DB || 'bufferflow_db';
const username = process.env.POSTGRES_USER || 'bufferflow_user';
const password = process.env.POSTGRES_PASSWORD;
const port = Number(process.env.POSTGRES_PORT || 5432);

const client = customUrl
  ? postgres(customUrl, { max: 1, connect_timeout: 3 })
  : postgres({
      host,
      port,
      database,
      username,
      password,
      max: 1,
      connect_timeout: 3,
    });

try {
  if (dryRun) {
    const rows = await client<{ id: string }[]>`
      SELECT id, run_id
      FROM test_runs
      WHERE test_type = 'FULL_SUITE'
        AND strategy_breakdown IS NULL
        AND level_breakdowns IS NULL
      ORDER BY created_at DESC
    `;
    console.log(`[Bufferflow Backfill] Dry run: ${rows.length} row(s) would be backfilled.`);
    for (const row of rows) console.log(`  ${row.id}`);
  } else {
    const rows = await client<{ id: string }[]>`
      UPDATE test_runs
      SET test_type = 'STANDARD'
      WHERE test_type = 'FULL_SUITE'
        AND strategy_breakdown IS NULL
        AND level_breakdowns IS NULL
      RETURNING id
    `;
    console.log(`[Bufferflow Backfill] Updated ${rows.length} row(s) to test_type = 'STANDARD'.`);
    for (const row of rows) console.log(`  ${row.id}`);
  }
} catch (error: any) {
  console.error(`[Bufferflow Backfill] Failed: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
