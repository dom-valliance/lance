import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { scopedDb, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { isUnsetSecretValue, newUlid, nowIso } from '@lance/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { EvidenceExporterLike, EvidenceRequest, PrincipalDirectoryLike } from '../deps.js';
import { BadRequestError } from '../errors.js';

/**
 * The ISO 27001 evidence export (spec 4.4, ADR 0024 amendment): a signed
 * JSON bundle of access and lifecycle events, rule changes and retention
 * runs recorded in a period, and, for one principal, the metadata of every
 * ledger event they have. Never a content payload: an event's payload is
 * included only for the system kinds below, which carry who, when and what
 * changed, and for everything else the bundle holds the hashes the
 * auditor can check against, not the payload.
 *
 * Without a principal the export covers system events only, across every
 * principal. The signature is Ed25519 over the exact bytes of `signed`,
 * with a key held in the static Key Vault (`evidence-signing-key`); how to
 * verify it is in docs/compliance/iso27001-access-review.md.
 */

export const EVIDENCE_FORMAT = 'lance-evidence/1';

/** The longest period one export may cover, so a bundle stays a size an auditor can open. */
export const MAX_PERIOD_DAYS = 366;
/** Rows per section; a longer section is cut and the bundle says so. */
export const MAX_ROWS = 20_000;

/** `state_changed` changes that are access or lifecycle events, whose payloads are metadata. */
export const ACCESS_CHANGES = [
  'principal_created',
  'principal_bound',
  'principal_roles_recorded',
  'principal_paused',
  'slack_link_issued',
  'slack_linked',
  'slack_unlinked',
  'slack_channel_created',
  'slack_channel_assigned',
  'slack_channel_invited',
  'graph_connected',
  'jamie_connected',
  'credential_migrated',
  'offboarding_requested',
  'offboarding_step',
  'evidence_exported',
  'pause_all',
  'resume_all',
] as const;

export interface SignedEvidence {
  format: typeof EVIDENCE_FORMAT;
  /** The exact JSON text that was signed. Parse it to read the bundle. */
  signed: string;
  signature: {
    algorithm: 'Ed25519';
    /** The first 16 hex characters of the SHA-256 of the public key (SPKI, DER). */
    keyId: string;
    /** PEM, so a verifier needs nothing else; compare `keyId` with the one on record. */
    publicKey: string;
    /** Base64. */
    value: string;
  };
}

export interface EvidenceSigner {
  keyId: string;
  sign(text: string): SignedEvidence['signature'];
}

/** A signer over an Ed25519 private key in PEM (PKCS #8), as `openssl genpkey -algorithm ed25519` writes it. */
export function evidenceSignerFromPem(pem: string): EvidenceSigner {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(
      'EVIDENCE_SIGNING_KEY is not a PEM private key. Generate one with `openssl genpkey -algorithm ed25519` (docs/compliance/iso27001-access-review.md).',
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `EVIDENCE_SIGNING_KEY must be an Ed25519 key; this one is ${String(key.asymmetricKeyType)}.`,
    );
  }
  const publicKey = createPublicKey(key);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(der).digest('hex').slice(0, 16);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    keyId,
    sign: (text) => ({
      algorithm: 'Ed25519',
      keyId,
      publicKey: publicPem,
      value: sign(null, Buffer.from(text, 'utf8'), key).toString('base64'),
    }),
  };
}

/** The signer from `EVIDENCE_SIGNING_KEY`, or null while it is unset or still the template's placeholder. */
export function evidenceSignerFromEnv(env: NodeJS.ProcessEnv = process.env): EvidenceSigner | null {
  const value = env['EVIDENCE_SIGNING_KEY'];
  if (isUnsetSecretValue(value)) return null;
  return evidenceSignerFromPem(value ?? '');
}

interface EventRow extends Record<string, unknown> {
  id: string;
  principal_id: string;
  ts: string;
  created_at: string;
  actor: string;
  kind: string;
  source_system: string | null;
  source_record_hash: string | null;
  correlation_id: string;
  payload_hash: string;
  payload: unknown;
}

/** A system event with its payload. */
export interface EvidenceEvent {
  id: string;
  principalId: string;
  ts: string;
  recordedAt: string;
  actor: string;
  kind: string;
  sourceSystem: string | null;
  payloadHash: string;
  /** Null once retention has nulled it; the hash still verifies what was there. */
  payload: unknown;
}

/** One of a principal's ledger events without its payload. */
export interface EvidenceEventMetadata {
  id: string;
  ts: string;
  recordedAt: string;
  actor: string;
  kind: string;
  sourceSystem: string | null;
  sourceRecordHash: string | null;
  correlationId: string;
  payloadHash: string;
  /** False once retention has nulled the payload (ADR 0011). */
  payloadHeld: boolean;
}

export interface EvidenceContent {
  format: typeof EVIDENCE_FORMAT;
  generatedAt: string;
  generatedBy: string;
  period: { from: string; to: string };
  scope: { kind: 'system' } | { kind: 'principal'; principalId: string; upn: string };
  principals: { id: string; upn: string; status: string }[];
  accessEvents: EvidenceEvent[];
  ruleChanges: EvidenceEvent[];
  retentionRuns: EvidenceEvent[];
  /** Only for a principal export. */
  ledgerEvents?: EvidenceEventMetadata[];
  /** Sections that reached `MAX_ROWS` and were cut; empty when the bundle is whole. */
  truncated: string[];
}

const toEvent = (row: EventRow): EvidenceEvent => ({
  id: row.id,
  principalId: row.principal_id,
  ts: new Date(row.ts).toISOString(),
  recordedAt: new Date(row.created_at).toISOString(),
  actor: row.actor,
  kind: row.kind,
  sourceSystem: row.source_system,
  payloadHash: row.payload_hash,
  payload: row.payload ?? null,
});

const toMetadata = (row: EventRow): EvidenceEventMetadata => ({
  id: row.id,
  ts: new Date(row.ts).toISOString(),
  recordedAt: new Date(row.created_at).toISOString(),
  actor: row.actor,
  kind: row.kind,
  sourceSystem: row.source_system,
  sourceRecordHash: row.source_record_hash,
  correlationId: row.correlation_id,
  payloadHash: row.payload_hash,
  payloadHeld: row.payload !== null && row.payload !== undefined,
});

const DAY_MS = 24 * 3600 * 1000;

export function checkPeriod(from: string, to: string): { from: Date; to: Date } {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestError(
      'An evidence export needs a from and a to that are ISO-8601 instants.',
    );
  }
  if (end.getTime() <= start.getTime()) {
    throw new BadRequestError('The evidence period must end after it starts.');
  }
  if (end.getTime() - start.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new BadRequestError(
      `An evidence export covers at most ${String(MAX_PERIOD_DAYS)} days. Export a longer period in parts.`,
    );
  }
  return { from: start, to: end };
}

export interface EvidenceExporterOptions {
  root: Db;
  directory: PrincipalDirectoryLike;
  signer: EvidenceSigner;
  now?: () => string;
}

export function createEvidenceExporter(options: EvidenceExporterOptions): EvidenceExporterLike {
  const clock = options.now ?? nowIso;

  const select = async (
    principalId: string,
    where: SQL,
    period: { from: Date; to: Date },
  ): Promise<EventRow[]> => {
    const scoped = scopedDb(options.root, { principalId });
    const result = await scoped.execute<EventRow>(sql`
      SELECT id, principal_id, ts, created_at, actor, kind::text AS kind, source_system,
             source_record_hash, correlation_id, payload_hash, payload
        FROM ledger_events
       WHERE created_at >= ${period.from.toISOString()}::timestamptz
         AND created_at < ${period.to.toISOString()}::timestamptz
         AND ${where}
       ORDER BY id
       LIMIT ${MAX_ROWS + 1}`);
    return result.rows;
  };

  const accessWhere = sql`(
    (kind = 'state_changed' AND payload ->> 'change' IN (${sql.join(
      ACCESS_CHANGES.map((change) => sql`${change}`),
      sql`, `,
    )}))
    OR (kind = 'observed' AND source_system = 'graph' AND payload ->> 'kind' = 'role_assignment'))`;

  return {
    async export(request: EvidenceRequest) {
      const period = checkPeriod(request.from, request.to);
      const everyone = await options.directory.list();
      const target =
        request.principalId === null
          ? null
          : (everyone.find((principal) => principal.id === request.principalId) ?? null);
      if (request.principalId !== null && target === null) {
        throw new BadRequestError(
          `No principal has id ${request.principalId}. Take the id from the admin page's principals list.`,
        );
      }
      const covered = target === null ? everyone : [target];
      const truncated = new Set<string>();
      const collect = async (section: string, where: SQL): Promise<EvidenceEvent[]> => {
        const rows: EventRow[] = [];
        for (const principal of covered) rows.push(...(await select(principal.id, where, period)));
        rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (rows.length > MAX_ROWS) truncated.add(section);
        return rows.slice(0, MAX_ROWS).map(toEvent);
      };

      const content: EvidenceContent = {
        format: EVIDENCE_FORMAT,
        generatedAt: clock(),
        generatedBy: request.actor,
        period: { from: period.from.toISOString(), to: period.to.toISOString() },
        scope:
          target === null
            ? { kind: 'system' }
            : { kind: 'principal', principalId: target.id, upn: target.upn },
        principals: covered.map((principal) => ({
          id: principal.id,
          upn: principal.upn,
          status: principal.status,
        })),
        accessEvents: await collect('accessEvents', accessWhere),
        ruleChanges: await collect('ruleChanges', sql`kind = 'rule_changed'`),
        retentionRuns: await collect('retentionRuns', sql`kind = 'retention_applied'`),
        truncated: [],
      };
      if (target !== null) {
        const rows = await select(target.id, sql`true`, period);
        if (rows.length > MAX_ROWS) truncated.add('ledgerEvents');
        content.ledgerEvents = rows.slice(0, MAX_ROWS).map(toMetadata);
      }
      content.truncated = [...truncated].sort();

      const signed = JSON.stringify(content);
      const bundle: SignedEvidence = {
        format: EVIDENCE_FORMAT,
        signed,
        signature: options.signer.sign(signed),
      };
      // The export is itself an access event, recorded in the admin's own ledger.
      await new LedgerWriter(scopedDb(options.root, { principalId: request.callerId })).append({
        ts: clock(),
        actor: request.actor,
        kind: 'state_changed',
        sourceSystem: 'lance',
        correlationId: newUlid(),
        payload: {
          change: 'evidence_exported',
          from: content.period.from,
          to: content.period.to,
          principalId: request.principalId,
          keyId: bundle.signature.keyId,
          digest: createHash('sha256').update(signed).digest('hex'),
        },
      });
      return bundle;
    },
  };
}
