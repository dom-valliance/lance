import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from './client.js';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

/** The pool config `pg` was given, read back off the Drizzle client. */
function poolOptions(db: ReturnType<typeof createDb>): Record<string, unknown> {
  return db.$client.options as unknown as Record<string, unknown>;
}

describe('createDb', () => {
  it('starts every session as PG_ROLE so runtime tables belong to the shared role', () => {
    process.env.DATABASE_URL = 'postgres://app:pw@localhost:5432/lance';
    process.env.PG_ROLE = 'lance_app';
    const db = createDb();
    expect(poolOptions(db)['options']).toBe('-c role=lance_app');
  });

  it('sets no role option when PG_ROLE is absent', () => {
    process.env.DATABASE_URL = 'postgres://app:pw@localhost:5432/lance';
    delete process.env.PG_ROLE;
    const db = createDb();
    expect(poolOptions(db)['options']).toBeUndefined();
  });

  it('refuses a PG_ROLE that is not a plain role name', () => {
    process.env.DATABASE_URL = 'postgres://app:pw@localhost:5432/lance';
    process.env.PG_ROLE = 'lance_app; drop table x';
    expect(() => createDb()).toThrow('PG_ROLE must be a plain role name');
  });
});
