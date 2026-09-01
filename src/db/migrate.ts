import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export async function runMigrations(): Promise<void> {
  const customUrl = process.env.DATABASE_URL;

  const defaultSocket = existsSync('/var/run/postgresql')
    ? '/var/run/postgresql'
    : existsSync('/tmp/.s.PGSQL.5432')
      ? '/tmp'
      : undefined;

  const host = process.env.POSTGRES_HOST || defaultSocket;
  const database = process.env.POSTGRES_DB || 'bufferflow_db';
  const username = process.env.POSTGRES_USER || 'bufferflow_user';
  const password = process.env.POSTGRES_PASSWORD;
  const port = Number(process.env.POSTGRES_PORT || 5432);

  const client = customUrl
    ? postgres(customUrl, { max: 1 })
    : postgres({
        host,
        port,
        database,
        username,
        password,
        max: 1,
      });

  try {
    const db = drizzle(client);
    const migrationsFolder = join(process.cwd(), 'drizzle');

    console.log(`[Bufferflow Migrations] Applying migrations from ${migrationsFolder}...`);
    await migrate(db, { migrationsFolder });
    console.log('[Bufferflow Migrations] Migrations applied successfully.');
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Bufferflow Migrations] Migration failed:', err);
      process.exit(1);
    });
}
