import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

export interface DbConfig {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
}

const RETRY_COOLDOWN_MS = 15_000;

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlClient: ReturnType<typeof postgres> | null = null;
let isInitialized = false;
let isConnectedToPostgres = false;
let lastInitAttemptAt = 0;

export async function getDb() {
  if (!isInitialized && Date.now() - lastInitAttemptAt >= RETRY_COOLDOWN_MS) {
    await initDb();
  }
  return dbInstance;
}

export function isDbConnected(): boolean {
  return isConnectedToPostgres;
}

export async function initDb(force: boolean = false): Promise<boolean> {
  if (isInitialized) return isConnectedToPostgres;
  // Avoid hammering a down database on every history call.
  if (!force && Date.now() - lastInitAttemptAt < RETRY_COOLDOWN_MS) {
    return isConnectedToPostgres;
  }
  lastInitAttemptAt = Date.now();

  // Deterministic tests and local UI-only runs can opt out explicitly.
  if (process.env.BUFFERFLOW_DISABLE_DB === '1') {
    isInitialized = true;
    return false;
  }

  const isProd = process.env.NODE_ENV === 'production';
  const customUrl = process.env.DATABASE_URL;

  // Detect socket availability across Linux (/var/run/postgresql) and macOS (/tmp)
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

  // If not in prod and no socket/url/host configured, stay in dev in-memory mode
  if (!customUrl && !host && !isProd) {
    console.log(
      '[Bufferflow DB] Running in local development mode (no PostgreSQL socket found). Historical results stored in memory.'
    );
    isInitialized = true;
    return false;
  }

  let client: ReturnType<typeof postgres> | undefined;
  let connected = false;

  try {
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

    sqlClient = client;
    dbInstance = drizzle(client, { schema });
    connected = true;

    // Migration handling:
    // In production, always ensure pending migrations are applied automatically on boot.
    // In development (which frequently restarts via watcher), only run migration if initial
    // bootstrap is needed (tables don't exist yet) or explicitly requested via RUN_MIGRATIONS=true.
    const migrationsFolder = join(process.cwd(), 'drizzle');
    if (existsSync(migrationsFolder)) {
      const forceMigrate = isProd || process.env.RUN_MIGRATIONS === 'true';
      let shouldMigrate = forceMigrate;

      if (!shouldMigrate) {
        const [check] = await client`SELECT to_regclass('public.test_runs') AS tbl`;
        if (!check?.tbl) {
          shouldMigrate = true;
        }
      }

      if (shouldMigrate) {
        try {
          await migrate(dbInstance, { migrationsFolder });
          console.log('[Bufferflow DB] Database migrations applied successfully.');
        } catch (migrationErr: any) {
          console.warn(
            `[Bufferflow DB] Migration notice: ${migrationErr?.message || migrationErr}`
          );
        }
      }
    }

    isInitialized = true;
    isConnectedToPostgres = true;

    console.log(
      `[Bufferflow DB] Connected to PostgreSQL (${host ? `socket/host: ${host}` : 'url'}), database "${database}" as "${username}".`
    );
    return true;
  } catch (err: any) {
    // Close a partially-created pool so failed attempts do not leak sockets.
    if (client && !connected) {
      try {
        await client.end({ timeout: 5 });
      } catch {
        // Ignore cleanup errors
      }
    }
    console.warn(
      `[Bufferflow DB] PostgreSQL unavailable (${err?.message || err}). Falling back to resilient in-memory historical storage.`
    );
    isConnectedToPostgres = false;
    dbInstance = null;
    sqlClient = null;
    // Allow a later getDb() call to retry after the cooldown.
    isInitialized = false;
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
    dbInstance = null;
    isConnectedToPostgres = false;
    isInitialized = false;
    lastInitAttemptAt = 0;
  }
}
