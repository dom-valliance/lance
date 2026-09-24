export const PACKAGE_NAME = '@lance/db';

export * from './enums.js';
export * from './schema/index.js';
export * from './client.js';
export { newestObservationFirst } from './latest.js';
export {
  resolvePrincipalByUpn,
  resolveSinglePrincipal,
  waitForPrincipalByUpn,
  waitForSinglePrincipal,
} from './principal.js';
export type { WaitOptions } from './principal.js';
export { MIGRATIONS_FOLDER, runMigrations, runMigrationsWithRetry } from './migrate.js';
export { SEED_PRINCIPAL_ID, seed } from './seed.js';
export { grantRetentionMember, RETENTION_MEMBER_ENV, runGrants } from './grants.js';
export type { GrantOutcome } from './grants.js';
export { credentialRotationLockKey, withAdvisoryLock } from './advisoryLock.js';
