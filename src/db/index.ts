import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export interface DbConfig {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  schema?: string;
}

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlClient: ReturnType<typeof postgres> | null = null;
let isInitialized = false;
let isConnectedToPostgres = false;

export async function getDb() {
  if (!isInitialized) {
    await initDb();
  }
  return dbInstance;
}

export function isDbConnected(): boolean {
  return isConnectedToPostgres;
}

export async function initDb(): Promise<boolean> {
  if (isInitialized) return isConnectedToPostgres;
  isInitialized = true;

  const schemaName = schema.SCHEMA_NAME;
  const isProd = process.env.NODE_ENV === 'production';
  const customUrl = process.env.DATABASE_URL;

  // Detect socket availability or explicit host configuration
  const defaultSocketDir = '/var/run/postgresql';
  const hasDefaultSocket = existsSync(defaultSocketDir);
  const host = process.env.POSTGRES_HOST || (hasDefaultSocket ? defaultSocketDir : undefined);
  const database = process.env.POSTGRES_DB || 'dejis_cloud_db';
  const username = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD;
  const port = Number(process.env.POSTGRES_PORT || 5432);

  // If not in prod and no socket/url/host configured, stay in dev in-memory mode
  if (!customUrl && !host && !isProd) {
    console.log(
      `[Bufferflow DB] Running in local development mode (no PostgreSQL socket at ${defaultSocketDir}). Historical results stored in memory.`
    );
    return false;
  }

  try {
    let client: ReturnType<typeof postgres>;
    if (customUrl) {
      client = postgres(customUrl, { connect_timeout: 3, max: 10 });
    } else {
      client = postgres({
        host: host || defaultSocketDir,
        port,
        database,
        username,
        password,
        connect_timeout: 3,
        max: 10,
      });
    }

    // Ping check
    await client`SELECT 1`;

    // Ensure isolated schema and table exist
    await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}"."test_runs" (
        "id" text PRIMARY KEY,
        "run_id" text NOT NULL,
        "session_id" text NOT NULL,
        "test_type" text NOT NULL,
        "is_multi_level" boolean DEFAULT false,
        "completed_reason" text NOT NULL,
        "duration_sec" integer NOT NULL,
        "started_at" timestamp with time zone NOT NULL,
        "completed_at" timestamp with time zone NOT NULL,
        "target_rps" integer NOT NULL,
        "worker_count" integer NOT NULL,
        "peak_incoming_rps" integer DEFAULT 0,
        "peak_accepted_rps" integer DEFAULT 0,
        "peak_drained_rps" integer DEFAULT 0,
        "p50_latency_ms" integer DEFAULT 0,
        "p95_latency_ms" integer DEFAULT 0,
        "p99_latency_ms" integer DEFAULT 0,
        "total_ingressed" integer DEFAULT 0,
        "total_accepted" integer DEFAULT 0,
        "total_processed" integer DEFAULT 0,
        "total_failed" integer DEFAULT 0,
        "summary" jsonb NOT NULL,
        "config" jsonb NOT NULL,
        "strategy_breakdown" jsonb,
        "level_breakdowns" jsonb,
        "workers" jsonb,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );
    `);
    await client.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_${schemaName}_test_runs_created" 
      ON "${schemaName}"."test_runs" ("created_at" DESC);
    `);
    await client.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_${schemaName}_test_runs_session" 
      ON "${schemaName}"."test_runs" ("session_id");
    `);

    sqlClient = client;
    dbInstance = drizzle(client, { schema });
    isConnectedToPostgres = true;

    console.log(
      `[Bufferflow DB] Connected to PostgreSQL (${host ? `socket/host: ${host}` : 'url'}), using isolated schema "${schemaName}".`
    );
    return true;
  } catch (err: any) {
    console.warn(
      `[Bufferflow DB] PostgreSQL unavailable (${err?.message || err}). Falling back to resilient in-memory historical storage.`
    );
    isConnectedToPostgres = false;
    dbInstance = null;
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
    dbInstance = null;
    isConnectedToPostgres = false;
  }
}
