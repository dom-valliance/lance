import { defineConfig } from 'drizzle-kit';

// `globalThis.process` rather than the bare global: this file sits outside
// the src globs the root ESLint config gives Node globals to.
const databaseUrl = globalThis.process.env.DATABASE_URL ?? '';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/enums.ts', './src/schema/index.ts'],
  out: './drizzle',
  dbCredentials: { url: databaseUrl },
});
