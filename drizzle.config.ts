import { defineConfig } from 'drizzle-kit';

const configuredHost = process.env.POSTGRES_HOST || '127.0.0.1';
// drizzle-kit talks to Postgres over a TCP connection string. If the runtime is
// configured with a Unix-socket directory (`/tmp`, `/var/run/postgresql`), fall
// back to localhost for the CLI; socket-only setups should set DATABASE_URL.
const host = configuredHost.startsWith('/') ? '127.0.0.1' : configuredHost;
const port = process.env.POSTGRES_PORT || '5432';
const database = encodeURIComponent(process.env.POSTGRES_DB || 'bufferflow_db');
const username = encodeURIComponent(process.env.POSTGRES_USER || 'bufferflow_user');
const password = encodeURIComponent(process.env.POSTGRES_PASSWORD || '');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      `postgresql://${username}:${password}@${host}:${port}/${database}`,
  },
});
