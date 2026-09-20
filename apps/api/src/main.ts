import { createDb, type Db } from '@lance/db';
import { LedgerReader, LedgerWriter, SystemControl } from '@lance/ledger';
import { getConfig, readSecret, type Config } from '@lance/shared';
import { pathToFileURL } from 'node:url';
import { createEntraVerifier } from './auth/entra.js';
import type { ApiDeps, SlackDeps, TokenVerifier } from './deps.js';
import { buildServer } from './server.js';
import { createDbStatusSource } from './status.js';

/**
 * Process entry point. Everything the server needs is built here and passed
 * in, so `buildServer` itself reaches for nothing global.
 */

const DEFAULT_PORT = 3001;
/** Container Apps routes to the container's own interface, not to loopback. */
const HOST = '0.0.0.0';

export interface RuntimeOptions {
  config: Config;
  db: Db;
  auth: TokenVerifier;
  slack: SlackDeps;
  ingestSecret: string;
}

/** Assembles the real `SystemControl`, `LedgerReader`, `LedgerWriter` and status source over `db`. */
export const createApiDeps = (options: RuntimeOptions): ApiDeps => {
  const control = new SystemControl(options.db);
  return {
    config: options.config,
    control,
    ledger: new LedgerReader(options.db),
    writer: new LedgerWriter(options.db),
    status: createDbStatusSource(options.db, control, {
      usdToGbp: options.config.cost.usdToGbp,
      timeZone: options.config.timeZone,
    }),
    auth: options.auth,
    slack: options.slack,
    ingestSecret: options.ingestSecret,
  };
};

/**
 * Reads a required, non-secret environment variable. Secrets go through
 * `readSecret`; these three are identifiers, published in the Entra runbook
 * and safe in plain configuration.
 */
const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable "${name}". See docs/runbooks/entra-setup.md for where its value comes from.`,
    );
  }
  return value;
};

const port = (): number => {
  const raw = process.env['PORT'];
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return parsed;
};

export const main = async (): Promise<void> => {
  const config = getConfig();
  const db = createDb();

  const deps = createApiDeps({
    config,
    db,
    auth: createEntraVerifier({
      tenantId: requiredEnv('ENTRA_TENANT_ID'),
      clientId: requiredEnv('ENTRA_CLIENT_ID'),
      allowedUpn: requiredEnv('ALLOWED_UPN'),
    }),
    slack: {
      signingSecret: readSecret('SLACK_SIGNING_SECRET'),
      allowedUserId: process.env['SLACK_ALLOWED_USER_ID'] ?? null,
    },
    ingestSecret: readSecret('AGENT_LOG_INGEST_SECRET'),
  });

  const server = buildServer(deps);

  const shutdown = (signal: string): void => {
    server.log.info({ signal }, 'Shutting down the api');
    void server
      .close()
      .then(() => db.$client.end())
      .then(() => process.exit(0));
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await server.listen({ port: port(), host: HOST });
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
