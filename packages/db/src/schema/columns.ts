import { sql } from 'drizzle-orm';
import { char, check, timestamp } from 'drizzle-orm/pg-core';

/**
 * Column builders shared by every table in spec section 5.1.
 *
 * Ids are ULIDs: 26 characters of Crockford base32, stored as `char(26)` and
 * constrained by a CHECK so a malformed id cannot reach the database.
 */

export const ULID_PATTERN = '^[0-9A-HJKMNP-TV-Z]{26}$';

export const ulid = (name: string) => char(name, { length: 26 });

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const createdAt = () => timestamptz('created_at').notNull().defaultNow();

export const updatedAt = () => timestamptz('updated_at').notNull().defaultNow();

/**
 * A CHECK constraint asserting one column holds a well-formed ULID. NULL
 * columns pass, because `NULL ~ pattern` is NULL rather than false.
 */
export const ulidCheck = (table: string, column: string) =>
  check(`${table}_${column}_ulid`, sql.raw(`"${column}" ~ '${ULID_PATTERN}'`));
