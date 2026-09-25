import { ledgerEvents, principals, scopedDb, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { newUlid, nowIso, type SourceSystem } from '@lance/shared';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import {
  drizzleRunner,
  isEdge,
  isVertex,
  runCypher,
  sqlRunnerOf,
  type CypherParams,
  type SqlRunner,
  type Vertex,
} from './cypher.js';
import {
  EDGE_LABELS,
  EDGE_LABEL_VALUES,
  NODE_LABELS,
  NODE_LABEL_VALUES,
  ONTOLOGY_LAYERS,
  edgeLayer,
  edgeLayerBetween,
  nodeLayer,
  type EdgeLabel,
  type Layer,
  type NodeLabel,
} from './layers.js';
import {
  decide,
  nameOrganisationScore,
  normaliseEmail,
  normaliseName,
  organisationDomain,
  type ResolutionDecision,
} from './resolution.js';

/**
 * Every graph mutation goes through here (spec 5.2). A mutation is one
 * Cypher statement with concrete parameters, applied to AGE and appended
 * to the ledger as a `resolved` event carrying that statement verbatim,
 * so `rebuild` can replay the ledger into an empty graph and arrive at the
 * same nodes with the same ids. Lookups that decide what to write are not
 * recorded; only the write is.
 *
 * The graph is not under row-level security (ADR 0017), so the scope is
 * held here. The repository is built for one principal. Every read returns
 * reference and shared nodes plus the private nodes and edges whose
 * `principal_id` is that principal; every write stamps that principal on
 * what it makes private. The principal travels to Cypher as the `principal`
 * parameter, added by the repository and never by a caller.
 */

export const ONTOLOGY_ACTOR = 'system:ontology';
export const MUTATION_KIND = 'ontology_mutation';

/** The Cypher parameter that carries the scope's principal. Reserved. */
const SCOPE_PARAM = 'principal';

/** A Drizzle transaction over the repository's handle. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * How an `apply` runs: inside a caller's transaction rather than its own,
 * and holding the node locks a merge takes (see `lockNodes`).
 */
interface ApplyOptions {
  tx?: Tx;
  locks?: readonly string[];
}

/** Raised inside a merge's transaction to roll it back when the merge is refused. */
class MergeRefused extends Error {
  override readonly name = 'MergeRefused';
}

/**
 * Transaction-scoped advisory locks on graph node ids, taken in id order.
 * A meeting merge holds the lock on the node it deletes from its edge
 * scan to its delete, and every write that attaches an edge to a Meeting
 * or changes one takes the same lock, so no edge can reach the node
 * between the check and the delete (ADR 0033).
 */
async function lockNodes(runner: SqlRunner, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ontology-node:${id}`]);
  }
}

const REBUILD_PAGE = 500;

/** The principal a repository reads and writes for (ADR 0015, ADR 0017). */
export interface PrincipalScope {
  readonly principalId: string;
}

/** Where a node's knowledge came from (spec 5.2 `source_refs`). */
export interface SourceRef {
  system: SourceSystem;
  id: string;
  url?: string;
  observedAt: string;
}

/**
 * What a shared node keeps of its sightings (ADR 0033): the system and the
 * first time Lance learnt of it there. The record id and URL of each
 * sighting stay on the observing principal's private edge to the node.
 */
export interface SharedSourceRef {
  system: SourceSystem;
  observedAt: string;
}

export interface MutationContext {
  correlationId: string;
  /** Ledger actor, for example agent:triage@0.1.0 or system:ontology. */
  actor?: string;
}

export interface Node {
  id: string;
  label: NodeLabel;
  properties: Record<string, unknown>;
}

export interface PersonInput {
  displayName: string;
  emails?: readonly string[];
  slackId?: string | null;
  notionUserId?: string | null;
  jamieParticipantIds?: readonly string[];
  orgId?: string | null;
  role?: string | null;
  isInternal?: boolean;
  confidence?: number;
  sourceRef: SourceRef;
}

export interface OrganisationInput {
  name: string;
  domains?: readonly string[];
  type?: 'client' | 'prospect' | 'partner' | 'vendor' | 'internal' | 'unknown';
  confidence?: number;
  sourceRef: SourceRef;
}

/**
 * A meeting as one principal observed it. `title`, `start`, `end` and
 * `icalUid` describe the shared Meeting node; the Graph event id, the
 * transcript reference, the tags, the Jamie id and the source ref are this
 * principal's context and land on their own `ATTENDED` edge (ADR 0017).
 */
export interface MeetingInput {
  title: string;
  start: string | null;
  end: string | null;
  /** The calendar iCalUId every attendee's mailbox shares: the primary key. */
  icalUid?: string | null;
  jamieId?: string | null;
  graphEventId?: string | null;
  transcriptRef?: string | null;
  tags?: readonly string[];
  sourceRef: SourceRef;
}

/** The scope's own context for one meeting, read from its `ATTENDED` edge. */
export interface MeetingContext {
  graphEventId: string | null;
  transcriptRef: string | null;
  tags: string[];
  jamieId: string | null;
  sourceRefs: SourceRef[];
}

export interface TaskInput {
  title: string;
  status: string;
  due: string | null;
  source: 'notion' | 'jamie' | 'lance';
  sourceId: string;
  assigneeId?: string | null;
  sourceRef: SourceRef;
}

export interface ProjectInput {
  name: string;
  notionPageId?: string | null;
  clientOrgId?: string | null;
  status?: string | null;
  aliases?: readonly string[];
  sourceRef: SourceRef;
}

/** A mail conversation as one principal's mailbox holds it (spec 5.2 Thread). */
export interface ThreadInput {
  conversationId: string;
  subject: string | null;
  lastMessageAt: string | null;
  sourceRef: SourceRef;
}

/** The properties an edge may carry (spec 5.2 edges; SAME_AS uses confidence and status). */
export interface EdgeProperties {
  confidence?: number;
  status?: 'candidate' | 'merged' | 'dismissed' | null;
  role?: string | null;
  since?: string | null;
}

export interface UpsertResult {
  id: string;
  created: boolean;
}

export interface RebuildResult {
  replayed: number;
  nodes: number;
  edges: number;
}

export interface BackfillOptions {
  /** The iCalUId of the scope's own calendar event with this Graph event id, or null. */
  icalUidOf(graphEventId: string): Promise<string | null>;
  /**
   * The principal whose data the pre-Phase-4 graph is: the one every
   * legacy mutation was recorded under (the principal whose UPN is
   * `config.dom.email`). Every unlayered node, every name-only shared
   * Person and every record-bearing shared ref is taken to be theirs, so
   * a backfill in any other principal's scope claims nothing and records
   * nothing.
   */
  legacyOwnerId: string;
}

export interface BackfillResult {
  /** Nodes given a layer. */
  nodes: number;
  /** Edges given a layer. */
  edges: number;
  /** Meetings whose Graph event id, transcript reference and tags moved to the principal's edge. */
  meetingContexts: number;
  /** Meetings given an iCalUId. */
  meetingKeys: number;
  /** Meetings left without an iCalUId because another Meeting already holds it and could not be merged into it. */
  meetingKeyConflicts: number;
  /** Jamie-keyed Meetings merged into the Meeting that holds their iCalUId (ADR 0033). */
  meetingMerges: number;
  /** Shared Meetings whose Jamie id left the node because they have an iCalUId (ADR 0033). */
  meetingJamieIds: number;
  /** Name-only Persons moved from the shared layer to the principal's private layer (ADR 0033). */
  privatePersons: number;
  /** Shared nodes whose source refs lost their record ids and URLs to the principal's own edge (ADR 0033). */
  strippedRefs: number;
  /** Nodes left as they are because another principal's evidence touches them; the next run looks again. */
  refused: number;
  /** Recorded mutations this run appended. */
  mutations: number;
}

export interface RepositoryOptions {
  now?: () => string;
  idFactory?: () => string;
  /** The name the principal's own Person node is created with, if it does not exist yet. Defaults to the principal's UPN. */
  principalName?: string;
}

export interface ResolvePersonResult {
  id: string;
  decision: 'exact' | ResolutionDecision;
  /** The existing node a candidate or merge was scored against. */
  matchedId: string | null;
  score: number | null;
}

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value);
  }
  return out;
}

function mergeSourceRefs(existing: unknown, incoming: SourceRef): SourceRef[] {
  const refs: SourceRef[] = Array.isArray(existing) ? (existing as SourceRef[]) : [];
  const seen = refs.some((ref) => ref.system === incoming.system && ref.id === incoming.id);
  return seen ? refs : [...refs, incoming];
}

/**
 * A shared node's refs with one more sighting folded in: one entry per
 * system, the earliest time, and nothing else (ADR 0033). Refs written
 * before ADR 0033 carry a record id; folding drops it.
 */
function sharedRefs(existing: unknown, incoming: SourceRef | null): SharedSourceRef[] {
  const all = [...sourceRefsOf(existing), ...(incoming === null ? [] : [incoming])];
  const out: SharedSourceRef[] = [];
  for (const ref of all) {
    const seen = out.find((item) => item.system === ref.system);
    if (seen === undefined) out.push({ system: ref.system, observedAt: ref.observedAt });
    else if (ref.observedAt < seen.observedAt) seen.observedAt = ref.observedAt;
  }
  return out;
}

/** True when a ref says more than a shared node may keep: a record id or a URL. */
function carriesRecord(ref: unknown): boolean {
  return typeof ref === 'object' && ref !== null && ('id' in ref || 'url' in ref);
}

function sourceRefsOf(value: unknown): SourceRef[] {
  return Array.isArray(value) ? (value as SourceRef[]) : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function layerOf(node: Node | null): Layer | null {
  const layer = node?.properties['layer'];
  return layer === 'reference' || layer === 'shared' || layer === 'private' ? layer : null;
}

/**
 * ADR 0033: an email, a Slack id, a Notion user id or a Jamie participant
 * id. A Person with none of them is only a name one principal saw, so it
 * is that principal's evidence and lives in their private layer.
 */
function hasExactKey(props: {
  emails: readonly unknown[];
  slackId: unknown;
  notionUserId: unknown;
  jamieParticipantIds: readonly unknown[];
}): boolean {
  const present = (value: unknown) => typeof value === 'string' && value !== '';
  return (
    props.emails.some(present) ||
    present(props.slackId) ||
    present(props.notionUserId) ||
    props.jamieParticipantIds.some(present)
  );
}

function inputHasExactKey(input: PersonInput, emails: readonly string[]): boolean {
  return hasExactKey({
    emails,
    slackId: input.slackId,
    notionUserId: input.notionUserId,
    jamieParticipantIds: input.jamieParticipantIds ?? [],
  });
}

function nodeHasExactKey(node: Node): boolean {
  const props = node.properties;
  return hasExactKey({
    emails: stringsOf(props['emails']),
    slackId: props['slack_id'],
    notionUserId: props['notion_user_id'],
    jamieParticipantIds: stringsOf(props['jamie_participant_ids']),
  });
}

/** Edge property keys a merge copies by name into Cypher text; anything else is refused. */
const PROPERTY_KEY = /^[a-z_][a-z0-9_]*$/;

function assertLabel(label: string, allowed: ReadonlySet<string>, what: string): void {
  if (!allowed.has(label)) {
    throw new Error(`"${label}" is not a ${what} label the ontology knows (spec 5.2).`);
  }
}

function vertexToNode(vertex: Vertex): Node {
  const id = vertex.properties['id'];
  if (typeof id !== 'string') {
    throw new Error(`Ontology vertex ${String(vertex.id)} carries no string id property.`);
  }
  return { id, label: vertex.label as NodeLabel, properties: vertex.properties };
}

function firstNode(rows: unknown[][]): Node | null {
  const first = rows[0]?.[0];
  return isVertex(first) ? vertexToNode(first) : null;
}

function allNodes(rows: unknown[][]): Node[] {
  return rows
    .map((row) => row[0])
    .filter(isVertex)
    .map(vertexToNode);
}

/**
 * The visibility test every read applies to a node or an edge bound to
 * `alias`: reference and shared are visible to every principal, private
 * only to its own. Anything without a layer (a graph the backfill has not
 * reached) is invisible, so an unlayered private fact fails closed.
 */
function visible(alias: string): string {
  return `(${alias}.layer IN ['reference', 'shared'] OR (${alias}.layer = 'private' AND ${alias}.principal_id = $${SCOPE_PARAM}))`;
}

/** The scope's own private edge or node: stricter than `visible`, for per-principal context. */
function own(alias: string): string {
  return `(${alias}.layer = 'private' AND ${alias}.principal_id = $${SCOPE_PARAM})`;
}

export class OntologyRepository {
  private readonly runner: SqlRunner;
  private readonly writer: LedgerWriter;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly principalName: string | null;
  private upn: Promise<string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly scope: PrincipalScope,
    options: RepositoryOptions = {},
  ) {
    const dbPrincipal = db.$client.scope.principalId;
    if (dbPrincipal !== scope.principalId) {
      throw new Error(
        `OntologyRepository for principal "${scope.principalId}" was given a database handle scoped to "${dbPrincipal}". ` +
          'Build the repository over scopedDb(db, { principalId }) for the same principal, so the graph scope and the ledger scope agree.',
      );
    }
    this.runner = sqlRunnerOf(db);
    this.writer = new LedgerWriter(db);
    this.now = options.now ?? nowIso;
    this.newId = options.idFactory ?? newUlid;
    this.principalName = options.principalName ?? null;
  }

  // Reads. Every one filters nodes and edges through `visible` or `own`.

  async getNode(id: string): Promise<Node | null> {
    return firstNode(await this.read(`MATCH (n {id: $id}) WHERE ${visible('n')} RETURN n`, { id }));
  }

  async findPersonByEmail(email: string): Promise<Node | null> {
    return firstNode(
      await this.read(`MATCH (p:Person) WHERE $email IN p.emails AND ${visible('p')} RETURN p`, {
        email: normaliseEmail(email),
      }),
    );
  }

  async findPersonByKey(key: 'slack_id' | 'notion_user_id', value: string): Promise<Node | null> {
    const query =
      key === 'slack_id'
        ? `MATCH (p:Person {slack_id: $value}) WHERE ${visible('p')} RETURN p`
        : `MATCH (p:Person {notion_user_id: $value}) WHERE ${visible('p')} RETURN p`;
    return firstNode(await this.read(query, { value }));
  }

  async findPersonByJamieParticipantId(participantId: string): Promise<Node | null> {
    return firstNode(
      await this.read(
        `MATCH (p:Person) WHERE $pid IN p.jamie_participant_ids AND ${visible('p')} RETURN p`,
        { pid: participantId },
      ),
    );
  }

  async findPersonsByNormalisedName(normalised: string): Promise<Node[]> {
    return allNodes(
      await this.read(`MATCH (p:Person {normalised_name: $name}) WHERE ${visible('p')} RETURN p`, {
        name: normalised,
      }),
    );
  }

  /** Every person with an email at `domain`: the people of one organisation, whether or not a `WORKS_AT` edge exists yet. */
  async findPersonsByEmailDomain(domain: string): Promise<Node[]> {
    const rows = await this.read(
      `MATCH (p:Person) WHERE ${visible('p')} UNWIND p.emails AS e WITH p, e WHERE e ENDS WITH $suffix RETURN p`,
      { suffix: `@${domain.toLowerCase()}` },
    );
    // A person with two addresses at the domain comes back twice from UNWIND.
    const byId = new Map<string, Node>();
    for (const node of allNodes(rows)) byId.set(node.id, node);
    return [...byId.values()];
  }

  async findOrganisationByDomain(domain: string): Promise<Node | null> {
    return firstNode(
      await this.read(
        `MATCH (o:Organisation) WHERE $domain IN o.domains AND ${visible('o')} RETURN o`,
        { domain: domain.toLowerCase() },
      ),
    );
  }

  /** The principal's own Person node, found by the principal's UPN among the emails. */
  async findPrincipalPerson(): Promise<Node | null> {
    return this.findPersonByEmail(await this.principalUpn());
  }

  /**
   * A meeting by its keys, strongest first: the calendar iCalUId on the
   * node, then the Jamie id on the scope's own `ATTENDED` edge, then the
   * Jamie id a meeting with no calendar event is keyed on, then the Graph
   * event id on the scope's own edge.
   */
  async findMeeting(keys: {
    icalUid?: string | null;
    jamieId?: string | null;
    graphEventId?: string | null;
  }): Promise<Node | null> {
    if (keys.icalUid) {
      const hit = firstNode(
        await this.read(`MATCH (m:Meeting {ical_uid: $v}) WHERE ${visible('m')} RETURN m`, {
          v: keys.icalUid,
        }),
      );
      if (hit !== null) return hit;
    }
    if (keys.jamieId) {
      const onEdge = firstNode(
        await this.read(
          `MATCH (:Person)-[r:ATTENDED {jamie_id: $v}]->(m:Meeting) WHERE ${own('r')} AND ${visible('m')} RETURN m`,
          { v: keys.jamieId },
        ),
      );
      if (onEdge !== null) return onEdge;
      const onNode = firstNode(
        await this.read(`MATCH (m:Meeting {jamie_id: $v}) WHERE ${visible('m')} RETURN m`, {
          v: keys.jamieId,
        }),
      );
      if (onNode !== null) return onNode;
    }
    if (keys.graphEventId) {
      const hit = firstNode(
        await this.read(
          `MATCH (:Person)-[r:ATTENDED {graph_event_id: $v}]->(m:Meeting) WHERE ${own('r')} AND ${visible('m')} RETURN m`,
          { v: keys.graphEventId },
        ),
      );
      if (hit !== null) return hit;
    }
    return null;
  }

  /**
   * The scope's own context for a meeting: the Graph event id, transcript
   * reference, tags, Jamie id and source refs on the `ATTENDED` edge from
   * the principal's Person node. Null when that edge does not exist.
   */
  async meetingContext(meetingId: string): Promise<MeetingContext | null> {
    const person = await this.findPrincipalPerson();
    if (person === null) return null;
    const properties = await this.ownAttendance(person.id, meetingId);
    if (properties === null) return null;
    return {
      graphEventId: stringOrNull(properties['graph_event_id']),
      transcriptRef: stringOrNull(properties['transcript_ref']),
      tags: stringsOf(properties['tags']),
      jamieId: stringOrNull(properties['jamie_id']),
      sourceRefs: sourceRefsOf(properties['source_refs']),
    };
  }

  /**
   * Where the scope's principal saw a shared node: the source refs, record
   * ids and URLs included, on their own `OBSERVED` edge to it (ADR 0033).
   * Empty when the principal never saw it, or saw it only in another way.
   */
  async sightings(nodeId: string): Promise<SourceRef[]> {
    const person = await this.findPrincipalPerson();
    if (person === null) return [];
    const properties = await this.ownEdge(person.id, 'OBSERVED', nodeId);
    return sourceRefsOf(properties?.['source_refs']);
  }

  async findTask(source: TaskInput['source'], sourceId: string): Promise<Node | null> {
    return firstNode(
      await this.read(
        `MATCH (t:Task {source: $source, source_id: $sourceId}) WHERE ${visible('t')} RETURN t`,
        { source, sourceId },
      ),
    );
  }

  async findThread(conversationId: string): Promise<Node | null> {
    return firstNode(
      await this.read(
        `MATCH (t:Thread {graph_conversation_id: $v}) WHERE ${visible('t')} RETURN t`,
        { v: conversationId },
      ),
    );
  }

  /** Nodes one edge away, with the edge label, optionally restricted to one label. */
  async neighbours(id: string, edge?: EdgeLabel): Promise<{ edge: string; node: Node }[]> {
    if (edge !== undefined) assertLabel(edge, EDGE_LABELS, 'edge');
    const pattern = edge === undefined ? '[r]' : `[r:${edge}]`;
    const rows = await this.read(
      `MATCH (a {id: $id})-${pattern}-(b) WHERE ${visible('a')} AND ${visible('r')} AND ${visible('b')} RETURN label(r), b`,
      { id },
      ['edge', 'node'],
    );
    return rows.flatMap(([label, vertex]) =>
      isVertex(vertex) ? [{ edge: String(label), node: vertexToNode(vertex) }] : [],
    );
  }

  /** True when two people are both recorded as attending the same meeting (spec 5.3 rule 3). */
  async coAttended(personA: string, personB: string): Promise<boolean> {
    const rows = await this.read(
      `MATCH (a:Person {id: $a})-[ra:ATTENDED]->(m:Meeting)<-[rb:ATTENDED]-(b:Person {id: $b}) WHERE ${visible('a')} AND ${visible('b')} AND ${visible('m')} AND ${visible('ra')} AND ${visible('rb')} RETURN count(m)`,
      { a: personA, b: personB },
    );
    return Number(rows[0]?.[0] ?? 0) > 0;
  }

  /** Case-insensitive substring search over the naming property of every label. */
  async search(text: string, limit = 20): Promise<Node[]> {
    const needle = text.toLowerCase();
    // AGE takes no parameter in LIMIT, so the bound is checked and inlined.
    const bound = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 20;
    return allNodes(
      await this.read(
        `MATCH (n) WHERE ${visible('n')} AND toLower(coalesce(n.display_name, n.name, n.title, n.subject, "")) CONTAINS $needle RETURN n LIMIT ${String(bound)}`,
        { needle },
      ),
    );
  }

  /** The nodes and edges this scope can see. */
  async counts(): Promise<{ nodes: number; edges: number }> {
    const nodes = await this.read(`MATCH (n) WHERE ${visible('n')} RETURN count(n)`);
    const edges = await this.read(
      `MATCH (a)-[r]->(b) WHERE ${visible('a')} AND ${visible('r')} AND ${visible('b')} RETURN count(r)`,
    );
    return { nodes: Number(nodes[0]?.[0] ?? 0), edges: Number(edges[0]?.[0] ?? 0) };
  }

  // Writes: every one is a recorded mutation

  async upsertPerson(input: PersonInput, context: MutationContext): Promise<UpsertResult> {
    const emails = uniqueStrings((input.emails ?? []).map(normaliseEmail));
    const existing = await this.findExistingPerson(input, emails);
    if (existing === null) return this.createPerson(input, emails, context);
    await this.updatePerson(existing, input, emails, context);
    return { id: existing.id, created: false };
  }

  /**
   * A new Person. With an exact key it is shared, keeps only the system
   * and time of the sighting, and the full ref goes on the principal's
   * own `OBSERVED` edge; with none it is private to the principal and
   * keeps its refs whole (ADR 0033).
   */
  private async createPerson(
    input: PersonInput,
    emails: string[],
    context: MutationContext,
  ): Promise<UpsertResult> {
    const layer: Layer = inputHasExactKey(input, emails) ? nodeLayer('Person') : 'private';
    const id = this.newId();
    const ts = this.now();
    await this.apply(
      'CREATE (p:Person {id: $id, display_name: $displayName, normalised_name: $normalisedName, emails: $emails, slack_id: $slackId, notion_user_id: $notionUserId, jamie_participant_ids: $jamieIds, org_id: $orgId, role: $role, is_internal: $isInternal, confidence: $confidence, source_refs: $sourceRefs, layer: $layer, principal_id: $owner, created_at: $ts, updated_at: $ts}) RETURN p.id',
      {
        id,
        displayName: input.displayName,
        normalisedName: normaliseName(input.displayName),
        emails,
        slackId: input.slackId ?? null,
        notionUserId: input.notionUserId ?? null,
        jamieIds: uniqueStrings(input.jamieParticipantIds ?? []),
        orgId: input.orgId ?? null,
        role: input.role ?? null,
        isInternal: input.isInternal ?? false,
        confidence: input.confidence ?? 1,
        sourceRefs: layer === 'private' ? [input.sourceRef] : sharedRefs([], input.sourceRef),
        ...this.stamp(layer),
        ts,
      },
      context,
    );
    if (layer !== 'private') await this.recordSightings(id, [input.sourceRef], context);
    return { id, created: true };
  }

  private async updatePerson(
    existing: Node,
    input: PersonInput,
    emails: string[],
    context: MutationContext,
  ): Promise<void> {
    const props = existing.properties;
    const isPrivate = layerOf(existing) === 'private';
    await this.apply(
      `MATCH (p:Person {id: $id}) WHERE ${visible('p')} SET p.emails = $emails, p.slack_id = $slackId, p.notion_user_id = $notionUserId, p.jamie_participant_ids = $jamieIds, p.org_id = $orgId, p.role = $role, p.is_internal = $isInternal, p.source_refs = $sourceRefs, p.updated_at = $ts RETURN p.id`,
      {
        id: existing.id,
        emails: uniqueStrings([...stringsOf(props['emails']), ...emails]),
        slackId: input.slackId ?? props['slack_id'] ?? null,
        notionUserId: input.notionUserId ?? props['notion_user_id'] ?? null,
        jamieIds: uniqueStrings([
          ...stringsOf(props['jamie_participant_ids']),
          ...(input.jamieParticipantIds ?? []),
        ]),
        orgId: input.orgId ?? props['org_id'] ?? null,
        role: input.role ?? props['role'] ?? null,
        isInternal: input.isInternal ?? props['is_internal'] ?? false,
        sourceRefs: isPrivate
          ? mergeSourceRefs(props['source_refs'], input.sourceRef)
          : sharedRefs(props['source_refs'], input.sourceRef),
        ts: this.now(),
      },
      context,
    );
    if (!isPrivate) await this.recordSightings(existing.id, [input.sourceRef], context);
  }

  private async findExistingPerson(input: PersonInput, emails: string[]): Promise<Node | null> {
    for (const email of emails) {
      const hit = await this.findPersonByEmail(email);
      if (hit !== null) return hit;
    }
    if (input.notionUserId) {
      const hit = await this.findPersonByKey('notion_user_id', input.notionUserId);
      if (hit !== null) return hit;
    }
    if (input.slackId) {
      const hit = await this.findPersonByKey('slack_id', input.slackId);
      if (hit !== null) return hit;
    }
    for (const pid of input.jamieParticipantIds ?? []) {
      const hit = await this.findPersonByJamieParticipantId(pid);
      if (hit !== null) return hit;
    }
    return null;
  }

  /**
   * Spec 5.3 end to end for one observed person: exact keys merge at 1.0;
   * otherwise the name is scored against people with the same normalised
   * name, scaled by organisation; 0.95 and above merges, 0.75 to 0.95
   * creates the person and a SAME_AS candidate for the Ontology page,
   * below that a new person. Two people who attended the same meeting
   * as distinct attendees are never merged automatically.
   *
   * ADR 0033: a sighting with no exact key creates a Person private to the
   * principal. A later sighting with an exact key never merges into such a
   * node, which would carry one principal's evidence into the shared layer:
   * it creates (or has already found) the shared Person, and the private
   * node gains a private `SAME_AS` candidate pointing at it.
   */
  async resolvePerson(input: PersonInput, context: MutationContext): Promise<ResolvePersonResult> {
    const emails = uniqueStrings((input.emails ?? []).map(normaliseEmail));
    const keyed = inputHasExactKey(input, emails);
    const exact = await this.findExistingPerson(input, emails);
    if (exact !== null) {
      await this.updatePerson(exact, input, emails, context);
      return { id: exact.id, decision: 'exact', matchedId: exact.id, score: 1 };
    }
    const domain = emails.map(organisationDomain).find((d) => d !== null) ?? null;
    const organisation = input.orgId ?? domain;
    const candidates = await this.findPersonsByNormalisedName(normaliseName(input.displayName));
    let best: { node: Node; score: number } | null = null;
    for (const node of candidates) {
      const theirDomain = stringsOf(node.properties['emails'])
        .map(organisationDomain)
        .find((d) => d !== null);
      const score = nameOrganisationScore(
        { name: input.displayName, organisation },
        {
          name:
            typeof node.properties['display_name'] === 'string'
              ? node.properties['display_name']
              : '',
          organisation:
            (node.properties['org_id'] as string | null | undefined) ?? theirDomain ?? null,
        },
      );
      if (best === null || score > best.score) best = { node, score };
    }
    if (best === null) {
      const created = await this.createPerson(input, emails, context);
      return { id: created.id, decision: 'none', matchedId: null, score: null };
    }
    let decision = decide(best.score);
    const barred = await this.wouldViolateRuleThree(input, best.node.id);
    if (decision === 'merge' && barred) decision = 'candidate';
    // A sighting with no identifier at all (a name in a transcript, no
    // address) has nothing that could ever distinguish it from the person
    // of that name already known, so a candidate-grade match reuses that
    // node rather than minting one per meeting.
    if (decision === 'candidate' && !keyed && !barred) decision = 'merge';
    const bestIsPrivate = layerOf(best.node) === 'private';
    if (decision === 'merge' && keyed && bestIsPrivate) decision = 'candidate';
    if (decision === 'merge') {
      await this.updatePerson(best.node, input, emails, context);
      return { id: best.node.id, decision, matchedId: best.node.id, score: best.score };
    }
    const created = await this.createPerson(input, emails, context);
    if (decision === 'candidate') {
      // The candidate runs from the private name-only node to the shared
      // one, so it is the principal's evidence and private (ADR 0033).
      const [from, to] =
        keyed && bestIsPrivate ? [best.node.id, created.id] : [created.id, best.node.id];
      await this.link(
        from,
        'SAME_AS',
        to,
        { confidence: best.score, status: 'candidate' },
        context,
      );
    }
    return { id: created.id, decision, matchedId: best.node.id, score: best.score };
  }

  private async wouldViolateRuleThree(input: PersonInput, existingId: string): Promise<boolean> {
    // The incoming person has no node yet, so the only evidence of distinct
    // attendance is a meeting the caller names in the source ref: a Jamie
    // meeting id or a Graph event id attended by the existing person.
    if (input.sourceRef.system !== 'jamie' && input.sourceRef.system !== 'graph') return false;
    const meeting = await this.findMeeting(
      input.sourceRef.system === 'jamie'
        ? { jamieId: input.sourceRef.id }
        : { graphEventId: input.sourceRef.id },
    );
    if (meeting === null) return false;
    const rows = await this.read(
      `MATCH (p:Person {id: $p})-[r:ATTENDED]->(m:Meeting {id: $m}) WHERE ${visible('r')} RETURN count(m)`,
      { p: existingId, m: meeting.id },
    );
    return Number(rows[0]?.[0] ?? 0) > 0;
  }

  async upsertOrganisation(
    input: OrganisationInput,
    context: MutationContext,
  ): Promise<UpsertResult> {
    const domains = uniqueStrings((input.domains ?? []).map((d) => d.toLowerCase()));
    let existing: Node | null = null;
    for (const domain of domains) {
      existing = await this.findOrganisationByDomain(domain);
      if (existing !== null) break;
    }
    const ts = this.now();
    if (existing === null) {
      const id = this.newId();
      await this.apply(
        'CREATE (o:Organisation {id: $id, name: $name, normalised_name: $normalisedName, domains: $domains, type: $type, confidence: $confidence, source_refs: $sourceRefs, layer: $layer, principal_id: $owner, created_at: $ts, updated_at: $ts}) RETURN o.id',
        {
          id,
          name: input.name,
          normalisedName: normaliseName(input.name),
          domains,
          type: input.type ?? 'unknown',
          confidence: input.confidence ?? 1,
          sourceRefs: sharedRefs([], input.sourceRef),
          ...this.stamp(nodeLayer('Organisation')),
          ts,
        },
        context,
      );
      await this.recordSightings(id, [input.sourceRef], context);
      return { id, created: true };
    }
    await this.apply(
      `MATCH (o:Organisation {id: $id}) WHERE ${visible('o')} SET o.domains = $domains, o.type = $type, o.source_refs = $sourceRefs, o.updated_at = $ts RETURN o.id`,
      {
        id: existing.id,
        domains: uniqueStrings([
          ...((existing.properties['domains'] as string[] | undefined) ?? []),
          ...domains,
        ]),
        type: input.type ?? existing.properties['type'] ?? 'unknown',
        sourceRefs: sharedRefs(existing.properties['source_refs'], input.sourceRef),
        ts,
      },
      context,
    );
    await this.recordSightings(existing.id, [input.sourceRef], context);
    return { id: existing.id, created: false };
  }

  /**
   * One shared Meeting node per iCalUId. The node carries the facts every
   * attendee shares; the observing principal's context goes on their own
   * `ATTENDED` edge.
   *
   * A meeting only this principal's Jamie saw, with no iCalUId, is keyed
   * on its Jamie id and is private to the principal: nothing but their
   * own recording says it happened, so no other principal may find it.
   * It becomes shared when the principal's calendar supplies its iCalUId,
   * which every attendee's mailbox holds. It keeps its title, start and
   * end then, because ADR 0017 lists exactly those as the shared facts
   * of a Meeting, and loses its Jamie id to the principal's edge.
   *
   * Which source wins on a shared Meeting: the calendar. A Jamie
   * observation never changes a shared Meeting's title, start or end,
   * which the first sighting wrote and only a calendar (`graph`)
   * observation may change; it fills a fact only where the node has none.
   * On the principal's own private Meeting, their Jamie may update all
   * three.
   *
   * ADR 0033: once the node has an iCalUId it keeps no Jamie id, which
   * lives on the principal's edge. When this observation supplies the
   * iCalUId of a meeting the same principal's earlier Jamie observation
   * keyed on its Jamie id, and another node already holds that iCalUId,
   * the Jamie-keyed node is merged into it (see `mergeMeeting`). When the
   * merge is refused both nodes stay, and this observation lands on the
   * iCalUId node, which `findMeeting` prefers.
   */
  async upsertMeeting(input: MeetingInput, context: MutationContext): Promise<UpsertResult> {
    const icalUid = input.icalUid ?? null;
    let existing: Node | null = null;
    if (icalUid !== null) {
      const keyed = await this.findMeeting({ icalUid });
      const jamieKeyed = await this.findOwnJamieKeyedMeeting(input);
      if (keyed !== null && jamieKeyed !== null && jamieKeyed.id !== keyed.id) {
        await this.mergeMeeting(jamieKeyed.id, keyed.id, context);
      }
      existing = keyed ?? jamieKeyed;
    }
    existing ??= await this.findMeeting({
      icalUid,
      jamieId: input.jamieId ?? null,
      graphEventId: input.graphEventId ?? null,
    });
    const ts = this.now();
    let result: UpsertResult;
    if (existing === null) {
      const id = this.newId();
      const params = {
        id,
        title: input.title,
        start: input.start,
        end: input.end,
        // Only one principal's recording knows of a meeting with no iCalUId.
        ...this.stamp(icalUid === null ? 'private' : nodeLayer('Meeting')),
        ts,
      };
      // The Jamie id keys the node only when no calendar event did.
      await (icalUid === null
        ? this.apply(
            'CREATE (m:Meeting {id: $id, title: $title, start: $start, end_at: $end, jamie_id: $jamieId, confidence: 1, source_refs: [], layer: $layer, principal_id: $owner, created_at: $ts, updated_at: $ts}) RETURN m.id',
            { ...params, jamieId: input.jamieId ?? null },
            context,
          )
        : this.apply(
            'CREATE (m:Meeting {id: $id, title: $title, start: $start, end_at: $end, ical_uid: $icalUid, confidence: 1, source_refs: [], layer: $layer, principal_id: $owner, created_at: $ts, updated_at: $ts}) RETURN m.id',
            { ...params, icalUid },
            context,
          ));
      result = { id, created: true };
    } else {
      const key = stringOrNull(existing.properties['ical_uid']) ?? icalUid;
      const props = existing.properties;
      const current = {
        title: props['title'] ?? null,
        start: props['start'] ?? null,
        end: props['end_at'] ?? props['end'] ?? null,
      };
      // The calendar wins on a shared meeting: another source only fills a gap.
      const authoritative = layerOf(existing) === 'private' || input.sourceRef.system === 'graph';
      const pick = (incoming: string | null, held: unknown): unknown =>
        authoritative ? (incoming ?? held) : (held ?? incoming);
      const params = {
        id: existing.id,
        title: pick(input.title, current.title),
        start: pick(input.start, current.start),
        end: pick(input.end, current.end),
        ts,
      };
      const locks = { locks: [existing.id] };
      await (key === null
        ? this.apply(
            `MATCH (m:Meeting {id: $id}) WHERE ${visible('m')} SET m.title = $title, m.start = $start, m.end_at = $end, m.updated_at = $ts RETURN m.id`,
            params,
            context,
            locks,
          )
        : // An iCalUId makes the meeting one every attendee shares.
          this.apply(
            `MATCH (m:Meeting {id: $id}) WHERE ${visible('m')} SET m.title = $title, m.start = $start, m.end_at = $end, m.ical_uid = $icalUid, m.layer = $layer, m.principal_id = $owner, m.updated_at = $ts REMOVE m.jamie_id RETURN m.id`,
            { ...params, icalUid: key, ...this.stamp(nodeLayer('Meeting')) },
            context,
            locks,
          ));
      result = { id: existing.id, created: false };
    }
    await this.recordMeetingContext(result.id, input, context);
    return result;
  }

  /**
   * The Meeting this principal's own earlier observation keyed without an
   * iCalUId: found through the Jamie id or the Graph event id on the
   * principal's own `ATTENDED` edge. Another principal's Jamie-keyed node
   * is never this principal's to merge.
   */
  private async findOwnJamieKeyedMeeting(input: MeetingInput): Promise<Node | null> {
    for (const [property, value] of [
      ['jamie_id', input.jamieId],
      ['graph_event_id', input.graphEventId],
    ] as const) {
      if (!value) continue;
      const query =
        property === 'jamie_id'
          ? `MATCH (:Person)-[r:ATTENDED {jamie_id: $v}]->(m:Meeting) WHERE ${own('r')} AND ${visible('m')} AND m.ical_uid IS NULL RETURN m`
          : `MATCH (:Person)-[r:ATTENDED {graph_event_id: $v}]->(m:Meeting) WHERE ${own('r')} AND ${visible('m')} AND m.ical_uid IS NULL RETURN m`;
      const hit = firstNode(await this.read(query, { v: value }));
      if (hit !== null) return hit;
    }
    return null;
  }

  /**
   * Merges a Jamie-keyed Meeting into the Meeting that holds its iCalUId,
   * as recorded mutations (ADR 0033): the principal's context on its own
   * `ATTENDED` edge is folded into their edge to the target, every other
   * edge of theirs is recreated on the target unless an equal one is
   * already there, and the Jamie-keyed node is deleted. Deleting a graph
   * node is not a connector delete (non-negotiable 3 covers those), and
   * is allowed only for a node nothing but this principal's own private
   * edges touch: a shared edge or another principal's edge on it means
   * someone else's evidence depends on it, so the merge is refused and
   * both nodes stay. Returns whether the merge happened.
   *
   * The edge scan reads every edge on the node, whoever owns it, because
   * refusing needs to know; it returns nothing to the caller but the
   * decision.
   */
  private async mergeMeeting(
    fromId: string,
    intoId: string,
    context: MutationContext,
  ): Promise<boolean> {
    // One transaction from the scan to the delete, holding the lock every
    // edge write to a Meeting takes, so no other principal's edge can land
    // on the node between the check and the delete.
    try {
      await this.db.transaction(async (tx) => {
        const runner = drizzleRunner(tx);
        await runner.query('SET LOCAL search_path = ag_catalog, "$user", public');
        await lockNodes(runner, [fromId]);
        const read = (query: string, params: CypherParams, columns?: readonly string[]) =>
          runCypher(runner, query, this.scoped(params), columns);
        const source = firstNode(
          await read(
            `MATCH (m:Meeting {id: $id}) WHERE (m.layer = 'shared' OR ${own('m')}) AND m.ical_uid IS NULL RETURN m`,
            { id: fromId },
          ),
        );
        if (source === null) throw new MergeRefused('no Jamie-keyed meeting to merge');
        const edges = await this.edgesOf(read, fromId);
        const scope = this.scope.principalId;
        const movable = edges.every(
          ({ edge, other }) =>
            isEdge(edge) &&
            typeof other === 'string' &&
            edge.properties['layer'] === 'private' &&
            edge.properties['principal_id'] === scope &&
            EDGE_LABELS.has(edge.label) &&
            Object.keys(edge.properties).every((key) => PROPERTY_KEY.test(key)),
        );
        if (!movable) throw new MergeRefused("another principal's evidence touches the meeting");
        const person = await this.findPrincipalPerson();
        for (const { edge, other, outward } of edges) {
          if (!isEdge(edge) || typeof other !== 'string') continue;
          if (!outward && edge.label === 'ATTENDED' && other === person?.id) {
            await this.foldAttendance(other, intoId, edge.properties, context, tx);
            continue;
          }
          const [from, to] = outward ? [intoId, other] : [other, intoId];
          const present = await read(
            `MATCH (a {id: $from})-[r:${edge.label}]->(b {id: $to}) WHERE ${own('r')} RETURN count(r)`,
            { from, to },
          );
          if (Number(present[0]?.[0] ?? 0) > 0) continue;
          const keys = Object.keys(edge.properties).sort();
          const assignments = keys.map((key, index) => `${key}: $p${String(index)}`).join(', ');
          const values = Object.fromEntries(
            keys.map((key, index) => [`p${String(index)}`, edge.properties[key]]),
          );
          await this.apply(
            `MATCH (a {id: $from}), (b {id: $to}) CREATE (a)-[r:${edge.label} {${assignments}}]->(b) RETURN r`,
            { ...values, from, to },
            context,
            { tx },
          );
        }
        // The check again, in the same transaction, just before the delete.
        const foreign = await read(
          `MATCH (m:Meeting {id: $id})-[r]-() WHERE NOT (coalesce(r.layer, '') = 'private' AND coalesce(r.principal_id, '') = $${SCOPE_PARAM}) RETURN count(r)`,
          { id: fromId },
        );
        if (Number(foreign[0]?.[0] ?? 0) > 0) {
          throw new MergeRefused("another principal's evidence reached the meeting");
        }
        await this.apply(
          `MATCH (m:Meeting {id: $id}) WHERE (m.layer = 'shared' OR ${own('m')}) AND m.ical_uid IS NULL DETACH DELETE m`,
          { id: fromId },
          context,
          { tx },
        );
      });
      return true;
    } catch (error) {
      if (error instanceof MergeRefused) return false;
      throw error;
    }
  }

  /**
   * Every edge on a node, whoever owns it, for a merge to decide whether
   * it may move them. It returns nothing to a caller of the repository.
   */
  private async edgesOf(
    read: (
      query: string,
      params: CypherParams,
      columns?: readonly string[],
    ) => Promise<unknown[][]>,
    nodeId: string,
  ): Promise<{ edge: unknown; other: unknown; outward: boolean }[]> {
    const outgoing = await read(
      'MATCH (m:Meeting {id: $id})-[r]->(o) RETURN r, o.id',
      { id: nodeId },
      ['edge', 'other'],
    );
    const incoming = await read(
      'MATCH (o)-[r]->(m:Meeting {id: $id}) RETURN r, o.id',
      { id: nodeId },
      ['edge', 'other'],
    );
    return [
      ...outgoing.map(([edge, other]) => ({ edge, other, outward: true })),
      ...incoming.map(([edge, other]) => ({ edge, other, outward: false })),
    ];
  }

  /** Folds one `ATTENDED` edge's context into the principal's own edge to another meeting. */
  private async foldAttendance(
    personId: string,
    meetingId: string,
    context: Record<string, unknown>,
    mutation: MutationContext,
    tx?: Tx,
  ): Promise<void> {
    const current = (await this.ownAttendance(personId, meetingId)) ?? {};
    await this.writeAttendance(
      personId,
      meetingId,
      {
        graphEventId:
          stringOrNull(current['graph_event_id']) ?? stringOrNull(context['graph_event_id']),
        transcriptRef:
          stringOrNull(current['transcript_ref']) ?? stringOrNull(context['transcript_ref']),
        tags: uniqueStrings([...stringsOf(current['tags']), ...stringsOf(context['tags'])]),
        jamieId: stringOrNull(current['jamie_id']) ?? stringOrNull(context['jamie_id']),
        sourceRefs: sourceRefsOf(context['source_refs']).reduce(
          (refs, ref) => mergeSourceRefs(refs, ref),
          sourceRefsOf(current['source_refs']),
        ),
      },
      typeof current['confidence'] === 'number' ? current['confidence'] : 1,
      mutation,
      false,
      tx,
    );
  }

  /** Writes the principal's context for a meeting onto their own `ATTENDED` edge. */
  private async recordMeetingContext(
    meetingId: string,
    input: MeetingInput,
    context: MutationContext,
  ): Promise<void> {
    const person = await this.ensurePrincipalPerson(context);
    const current = (await this.ownAttendance(person, meetingId)) ?? {};
    await this.writeAttendance(
      person,
      meetingId,
      {
        graphEventId: input.graphEventId ?? stringOrNull(current['graph_event_id']),
        transcriptRef: input.transcriptRef ?? stringOrNull(current['transcript_ref']),
        tags: uniqueStrings([...stringsOf(current['tags']), ...(input.tags ?? [])]),
        jamieId: input.jamieId ?? stringOrNull(current['jamie_id']),
        sourceRefs: mergeSourceRefs(current['source_refs'], input.sourceRef),
      },
      typeof current['confidence'] === 'number' ? current['confidence'] : 1,
      context,
    );
  }

  private async writeAttendance(
    personId: string,
    meetingId: string,
    meeting: MeetingContext,
    confidence: number,
    context: MutationContext,
    removeFromNode = false,
    tx?: Tx,
  ): Promise<void> {
    // MERGE keys on the principal, so each principal's edge to one meeting
    // is its own, whoever else attended.
    const remove = removeFromNode
      ? ' SET m.source_refs = [] REMOVE m.graph_event_id REMOVE m.transcript_ref REMOVE m.tags'
      : '';
    await this.apply(
      `MATCH (p:Person {id: $person}), (m:Meeting {id: $meeting}) WHERE ${visible('p')} AND ${visible('m')} MERGE (p)-[r:ATTENDED {principal_id: $${SCOPE_PARAM}}]->(m) SET r.layer = $layer, r.graph_event_id = $graphEventId, r.transcript_ref = $transcriptRef, r.tags = $tags, r.jamie_id = $jamieId, r.source_refs = $sourceRefs, r.confidence = $confidence, r.updated_at = $ts${remove} RETURN r`,
      {
        person: personId,
        meeting: meetingId,
        layer: edgeLayer('ATTENDED'),
        graphEventId: meeting.graphEventId,
        transcriptRef: meeting.transcriptRef,
        tags: meeting.tags,
        jamieId: meeting.jamieId,
        sourceRefs: meeting.sourceRefs,
        confidence,
        ts: this.now(),
      },
      context,
      { locks: [meetingId], ...(tx === undefined ? {} : { tx }) },
    );
  }

  /**
   * ADR 0033. The record ids and URLs of the sightings of a shared node go
   * on a private `OBSERVED` edge from the principal's own Person node to
   * it, one edge per principal and node, its refs merged by system and
   * record id. A Meeting's sightings go on the principal's `ATTENDED` edge
   * instead, as they already did (ADR 0017).
   *
   * Why one `OBSERVED` edge rather than the natural edge a caller writes
   * next (`PARTICIPATED_IN`, `MENTIONS`, `ASSIGNED_TO`, `WORKS_AT`): the
   * repository learns of a sighting when a node is upserted, before and
   * apart from any edge the caller may or may not write, and several of
   * those edges do not start at the principal (a counterparty's
   * `PARTICIPATED_IN` to a Thread, a Commitment's `OWES`) or are shared
   * (`WORKS_AT`). A single private edge from the principal holds every
   * sighting whatever edges follow, and reading it back is one lookup.
   *
   * Nothing is written for the principal's own Person, whose sighting is
   * the principal record, or when every ref is already on the edge.
   */
  private async recordSightings(
    nodeId: string,
    refs: readonly SourceRef[],
    context: MutationContext,
  ): Promise<void> {
    const person = await this.ensurePrincipalPerson(context);
    if (person === nodeId) return;
    const current = await this.ownEdge(person, 'OBSERVED', nodeId);
    const before = sourceRefsOf(current?.['source_refs']);
    const merged = refs.reduce((all, ref) => mergeSourceRefs(all, ref), before);
    if (current !== null && merged.length === before.length) return;
    await this.apply(
      `MATCH (p:Person {id: $person}), (n {id: $node}) WHERE ${visible('p')} AND ${visible('n')} MERGE (p)-[r:OBSERVED {principal_id: $${SCOPE_PARAM}}]->(n) SET r.layer = $layer, r.source_refs = $sourceRefs, r.updated_at = $ts RETURN r`,
      {
        person,
        node: nodeId,
        layer: edgeLayer('OBSERVED'),
        sourceRefs: merged,
        ts: this.now(),
      },
      context,
    );
  }

  /** The properties of the scope's own edge of one label between two nodes, or null. */
  private async ownEdge(
    fromId: string,
    label: EdgeLabel,
    toId: string,
  ): Promise<Record<string, unknown> | null> {
    assertLabel(label, EDGE_LABELS, 'edge');
    const rows = await this.read(
      `MATCH (a {id: $from})-[r:${label}]->(b {id: $to}) WHERE ${own('r')} RETURN r`,
      { from: fromId, to: toId },
    );
    const edge = rows[0]?.[0];
    return isEdge(edge) ? edge.properties : null;
  }

  /** The properties of the scope's own `ATTENDED` edge from a person to a meeting. */
  private async ownAttendance(
    personId: string,
    meetingId: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.read(
      `MATCH (p:Person {id: $person})-[r:ATTENDED]->(m:Meeting {id: $meeting}) WHERE ${own('r')} RETURN r`,
      { person: personId, meeting: meetingId },
    );
    const edge = rows[0]?.[0];
    return isEdge(edge) ? edge.properties : null;
  }

  async upsertTask(input: TaskInput, context: MutationContext): Promise<UpsertResult> {
    const existing = await this.findTask(input.source, input.sourceId);
    const ts = this.now();
    const layer = existing === null ? nodeLayer('Task', input.source) : layerOf(existing);
    const shared = layer !== 'private';
    if (existing === null) {
      const id = this.newId();
      await this.apply(
        'CREATE (t:Task {id: $id, title: $title, status: $status, due: $due, source: $source, source_id: $sourceId, assignee_id: $assigneeId, confidence: 1, source_refs: $sourceRefs, layer: $layer, principal_id: $owner, created_at: $ts, updated_at: $ts}) RETURN t.id',
        {
          id,
          title: input.title,
          status: input.status,
          due: input.due,
          source: input.source,
          sourceId: input.sourceId,
          assigneeId: input.assigneeId ?? null,
          sourceRefs: shared ? sharedRefs([], input.sourceRef) : [input.sourceRef],
          ...this.stamp(nodeLayer('Task', input.source)),
          ts,
        },
        context,
      );
      if (shared) await this.recordSightings(id, [input.sourceRef], context);
      return { id, created: true };
    }
    await this.apply(
      `MATCH (t:Task {id: $id}) WHERE ${visible('t')} SET t.title = $title, t.status = $status, t.due = $due, t.assignee_id = $assigneeId, t.source_refs = $sourceRefs, t.updated_at = $ts RETURN t.id`,
      {
        id: existing.id,
        title: input.title,
        status: input.status,
        due: input.due,
        assigneeId: input.assigneeId ?? existing.properties['assignee_id'] ?? null,
        sourceRefs: shared
          ? sharedRefs(existing.properties['source_refs'], input.sourceRef)
          : mergeSourceRefs(existing.properties['source_refs'], input.sourceRef),
        ts,
      },
      context,
    );
    if (shared) await this.recordSightings(existing.id, [input.sourceRef], context);
    return { id: existing.id, created: false };
  }

  async upsertThread(input: ThreadInput, context: MutationContext): Promise<UpsertResult> {
    const existing = await this.findThread(input.conversationId);
    const ts = this.now();
    if (existing === null) {
      const id = this.newId();
      await this.apply(
        'CREATE (t:Thread {id: $id, graph_conversation_id: $conversationId, subject: $subject, last_message_at: $lastMessageAt, confidence: 1, source_refs: $sourceRefs, layer: $layer, principal_id: $owner, created_at: $ts, updated_at: $ts}) RETURN t.id',
        {
          id,
          conversationId: input.conversationId,
          subject: input.subject,
          lastMessageAt: input.lastMessageAt,
          sourceRefs: [input.sourceRef],
          ...this.stamp(nodeLayer('Thread')),
          ts,
        },
        context,
      );
      return { id, created: true };
    }
    await this.apply(
      `MATCH (t:Thread {id: $id}) WHERE ${visible('t')} SET t.subject = $subject, t.last_message_at = $lastMessageAt, t.source_refs = $sourceRefs, t.updated_at = $ts RETURN t.id`,
      {
        id: existing.id,
        subject: input.subject ?? existing.properties['subject'] ?? null,
        lastMessageAt: input.lastMessageAt ?? existing.properties['last_message_at'] ?? null,
        sourceRefs: mergeSourceRefs(existing.properties['source_refs'], input.sourceRef),
        ts,
      },
      context,
    );
    return { id: existing.id, created: false };
  }

  /** The graph side of a `commitments` row: same id, relationships only (spec 5.2). */
  async ensureCommitment(commitmentId: string, context: MutationContext): Promise<UpsertResult> {
    const existing = await this.getNode(commitmentId);
    if (existing !== null) return { id: commitmentId, created: false };
    const ts = this.now();
    await this.apply(
      'CREATE (c:Commitment {id: $id, confidence: 1, source_refs: [], layer: $layer, principal_id: $owner, created_at: $ts, updated_at: $ts}) RETURN c.id',
      { id: commitmentId, ...this.stamp(nodeLayer('Commitment')), ts },
      context,
    );
    return { id: commitmentId, created: true };
  }

  async upsertProject(input: ProjectInput, context: MutationContext): Promise<UpsertResult> {
    const rows = input.notionPageId
      ? await this.read(`MATCH (p:Project {notion_page_id: $v}) WHERE ${visible('p')} RETURN p`, {
          v: input.notionPageId,
        })
      : await this.read(`MATCH (p:Project {normalised_name: $v}) WHERE ${visible('p')} RETURN p`, {
          v: normaliseName(input.name),
        });
    const existing = firstNode(rows);
    const ts = this.now();
    if (existing === null) {
      const id = this.newId();
      await this.apply(
        'CREATE (p:Project {id: $id, name: $name, normalised_name: $normalisedName, notion_page_id: $notionPageId, client_org_id: $clientOrgId, status: $status, aliases: $aliases, confidence: 1, source_refs: $sourceRefs, layer: $layer, principal_id: $owner, created_at: $ts, updated_at: $ts}) RETURN p.id',
        {
          id,
          name: input.name,
          normalisedName: normaliseName(input.name),
          notionPageId: input.notionPageId ?? null,
          clientOrgId: input.clientOrgId ?? null,
          status: input.status ?? null,
          aliases: uniqueStrings(input.aliases ?? []),
          sourceRefs: sharedRefs([], input.sourceRef),
          ...this.stamp(nodeLayer('Project')),
          ts,
        },
        context,
      );
      await this.recordSightings(id, [input.sourceRef], context);
      return { id, created: true };
    }
    await this.apply(
      `MATCH (p:Project {id: $id}) WHERE ${visible('p')} SET p.name = $name, p.client_org_id = $clientOrgId, p.status = $status, p.aliases = $aliases, p.source_refs = $sourceRefs, p.updated_at = $ts RETURN p.id`,
      {
        id: existing.id,
        name: input.name,
        clientOrgId: input.clientOrgId ?? existing.properties['client_org_id'] ?? null,
        status: input.status ?? existing.properties['status'] ?? null,
        aliases: uniqueStrings([
          ...((existing.properties['aliases'] as string[] | undefined) ?? []),
          ...(input.aliases ?? []),
        ]),
        sourceRefs: sharedRefs(existing.properties['source_refs'], input.sourceRef),
        ts,
      },
      context,
    );
    await this.recordSightings(existing.id, [input.sourceRef], context);
    return { id: existing.id, created: false };
  }

  /**
   * MERGE one edge between two nodes by id; repeating it changes nothing
   * but the properties. AGE will not SET a whole map from a parameter, so
   * the edge carries a fixed set of properties, each assigned by name:
   * layer, confidence, status, role, since and updated_at. Anything else
   * belongs on a node. A private edge is merged on the scope's principal,
   * so another principal's edge between the same two nodes is never
   * touched. Both ends must be visible to the scope. An edge with a
   * private end is private whatever its label (ADR 0033).
   */
  async link(
    fromId: string,
    edge: EdgeLabel,
    toId: string,
    properties: EdgeProperties = {},
    context: MutationContext,
  ): Promise<void> {
    assertLabel(edge, EDGE_LABELS, 'edge');
    const [from, to] = await Promise.all([this.getNode(fromId), this.getNode(toId)]);
    const layer = edgeLayerBetween(edge, layerOf(from), layerOf(to));
    // An edge to a Meeting waits for any merge of that meeting (`mergeMeeting`).
    const locks = [from, to].flatMap((node) =>
      node !== null && node.label === 'Meeting' ? [node.id] : [],
    );
    const merge =
      layer === 'private'
        ? `MERGE (a)-[r:${edge} {principal_id: $${SCOPE_PARAM}}]->(b)`
        : `MERGE (a)-[r:${edge}]->(b)`;
    await this.apply(
      `MATCH (a {id: $from}), (b {id: $to}) WHERE ${visible('a')} AND ${visible('b')} ${merge} SET r.layer = $layer, r.confidence = $confidence, r.status = $status, r.role = $role, r.since = $since, r.updated_at = $ts RETURN r`,
      {
        from: fromId,
        to: toId,
        layer,
        confidence: properties.confidence ?? 1,
        status: properties.status ?? null,
        role: properties.role ?? null,
        since: properties.since ?? null,
        ts: this.now(),
      },
      context,
      { locks },
    );
  }

  /** Records a human decision on a SAME_AS candidate (spec 5.3 step 4). Reversible: the prior status is in the ledger. */
  async setSameAsStatus(
    fromId: string,
    toId: string,
    status: 'candidate' | 'merged' | 'dismissed',
    context: MutationContext,
  ): Promise<void> {
    await this.apply(
      `MATCH (a {id: $from})-[r:SAME_AS]-(b {id: $to}) WHERE ${visible('a')} AND ${visible('b')} AND ${visible('r')} SET r.status = $status, r.decided_at = $ts RETURN r`,
      { from: fromId, to: toId, status, ts: this.now() },
      context,
    );
  }

  /**
   * Brings a graph written before ADR 0017 up to it, as recorded mutations
   * so a rebuild reproduces every step: a layer on every node and edge by
   * the layer table, with this scope's principal on the private ones; the
   * Graph event id, transcript reference, tags, Jamie id and source refs
   * of each Meeting moved to the principal's own `ATTENDED` edge; and the
   * iCalUId set on each Meeting from the principal's calendar. Idempotent:
   * each step looks before it writes, so a second run records nothing.
   *
   * Every node and edge without a layer is taken to be this principal's,
   * which holds only for the legacy owner, the principal every pre-Phase-4
   * mutation was recorded under. In any other scope the backfill returns
   * at once and records nothing, so a context built before the owner's
   * cannot claim the owner's evidence (the caller runs it for the owner
   * once, before other contexts build). It then applies ADR 0033 through
   * `backfillProvenance`, and merges a Jamie-keyed Meeting into the one
   * that already holds its iCalUId.
   */
  async backfillLayers(
    context: MutationContext,
    options: BackfillOptions,
  ): Promise<BackfillResult> {
    const result: BackfillResult = {
      nodes: 0,
      edges: 0,
      meetingContexts: 0,
      meetingKeys: 0,
      meetingKeyConflicts: 0,
      meetingMerges: 0,
      meetingJamieIds: 0,
      privatePersons: 0,
      strippedRefs: 0,
      refused: 0,
      mutations: 0,
    };
    if (options.legacyOwnerId !== this.scope.principalId) return result;
    const before = await this.mutationCount(context);
    const layerWhere = async (
      match: string,
      alias: string,
      condition: string,
      layer: Layer,
      params: CypherParams,
    ): Promise<number> => {
      const where = `${match} WHERE ${alias}.layer IS NULL${condition}`;
      const rows = await this.read(`${where} RETURN count(${alias})`, params);
      const found = Number(rows[0]?.[0] ?? 0);
      if (found === 0) return 0;
      await this.apply(
        `${where} SET ${alias}.layer = $layer, ${alias}.principal_id = $owner RETURN count(${alias})`,
        { ...params, ...this.stamp(layer) },
        context,
      );
      return found;
    };

    const sharedSources = [...ONTOLOGY_LAYERS.sharedTaskSources];
    for (const label of NODE_LABEL_VALUES) {
      if (label === 'Task') {
        result.nodes += await layerWhere(
          'MATCH (n:Task)',
          'n',
          ' AND n.source IN $sources',
          'shared',
          { sources: sharedSources },
        );
        result.nodes += await layerWhere(
          'MATCH (n:Task)',
          'n',
          ' AND (n.source IS NULL OR NOT n.source IN $sources)',
          nodeLayer('Task'),
          { sources: sharedSources },
        );
        continue;
      }
      result.nodes += await layerWhere(`MATCH (n:${label})`, 'n', '', nodeLayer(label), {});
    }
    for (const label of EDGE_LABEL_VALUES) {
      result.edges += await layerWhere(`MATCH ()-[r:${label}]->()`, 'r', '', edgeLayer(label), {});
    }

    // Meeting context that still sits on the shared node moves to the
    // principal's own edge, and leaves the node.
    const legacy = allNodes(
      await this.read(
        `MATCH (m:Meeting) WHERE ${visible('m')} AND (m.graph_event_id IS NOT NULL OR m.transcript_ref IS NOT NULL OR m.tags IS NOT NULL) RETURN m`,
      ),
    );
    if (legacy.length > 0) {
      const person = await this.ensurePrincipalPerson(context);
      for (const meeting of legacy) {
        const current = (await this.ownAttendance(person, meeting.id)) ?? {};
        const props = meeting.properties;
        await this.writeAttendance(
          person,
          meeting.id,
          {
            graphEventId:
              stringOrNull(current['graph_event_id']) ?? stringOrNull(props['graph_event_id']),
            transcriptRef:
              stringOrNull(current['transcript_ref']) ?? stringOrNull(props['transcript_ref']),
            tags: uniqueStrings([...stringsOf(current['tags']), ...stringsOf(props['tags'])]),
            jamieId: stringOrNull(current['jamie_id']) ?? stringOrNull(props['jamie_id']),
            sourceRefs: sourceRefsOf(props['source_refs']).reduce(
              (refs, ref) => mergeSourceRefs(refs, ref),
              sourceRefsOf(current['source_refs']),
            ),
          },
          typeof current['confidence'] === 'number' ? current['confidence'] : 1,
          context,
          true,
        );
        result.meetingContexts += 1;
      }
    }

    // Meetings keyed on a mailbox's event id take the iCalUId that event
    // shares with every attendee's copy of it.
    const unkeyed = await this.read(
      `MATCH (:Person)-[r:ATTENDED]->(m:Meeting) WHERE ${own('r')} AND ${visible('m')} AND r.graph_event_id IS NOT NULL AND m.ical_uid IS NULL RETURN m.id, r.graph_event_id`,
      {},
      ['meeting', 'event'],
    );
    for (const [meetingId, graphEventId] of unkeyed) {
      if (typeof meetingId !== 'string' || typeof graphEventId !== 'string') continue;
      const icalUid = await options.icalUidOf(graphEventId);
      if (icalUid === null) continue;
      const holder = await this.findMeeting({ icalUid });
      if (holder !== null && holder.id !== meetingId) {
        // ADR 0033: the principal's calendar says this Jamie-keyed meeting
        // is the one another node holds the iCalUId of.
        if (await this.mergeMeeting(meetingId, holder.id, context)) result.meetingMerges += 1;
        else result.meetingKeyConflicts += 1;
        continue;
      }
      await this.apply(
        // An iCalUId makes the meeting shared, as `upsertMeeting` does.
        'MATCH (m:Meeting {id: $id}) WHERE m.ical_uid IS NULL SET m.ical_uid = $icalUid, m.layer = $layer, m.principal_id = $owner, m.updated_at = $ts RETURN m.id',
        { id: meetingId, icalUid, ts: this.now(), ...this.stamp(nodeLayer('Meeting')) },
        context,
        { locks: [meetingId] },
      );
      result.meetingKeys += 1;
    }
    await this.backfillProvenance(context, result);
    result.mutations = (await this.mutationCount(context)) - before;
    return result;
  }

  /**
   * ADR 0033 on an existing graph, as recorded mutations and idempotently:
   * a shared Person with no exact key moves to this principal's private
   * layer with the edges that touch it; every other shared node keeps
   * only the system and time of its sightings, the full refs moving to
   * the principal's `OBSERVED` edge; and a shared Meeting with an iCalUId
   * gives up its Jamie id to the principal's `ATTENDED` edge.
   *
   * Refs and name-only Persons written before ADR 0033 are taken to be
   * this principal's, which holds because every one of them was written
   * while the graph knew one principal. A node another principal's
   * private edges already touch is left alone and counted as refused.
   */
  private async backfillProvenance(
    context: MutationContext,
    result: BackfillResult,
  ): Promise<void> {
    const people = allNodes(await this.read(`MATCH (p:Person) WHERE p.layer = 'shared' RETURN p`));
    for (const node of people) {
      if (nodeHasExactKey(node)) continue;
      if (await this.touchedByAnother(node.id)) {
        result.refused += 1;
        continue;
      }
      await this.apply(
        `MATCH (p:Person {id: $id}) WHERE p.layer = 'shared' SET p.layer = $layer, p.principal_id = $owner RETURN p.id`,
        { id: node.id, ...this.stamp('private') },
        context,
      );
      for (const pattern of ['(p:Person {id: $id})-[r]->()', '()-[r]->(p:Person {id: $id})']) {
        const where = `MATCH ${pattern} WHERE r.layer <> 'private'`;
        const found = await this.read(`${where} RETURN count(r)`, { id: node.id });
        if (Number(found[0]?.[0] ?? 0) === 0) continue;
        await this.apply(
          `${where} SET r.layer = $layer, r.principal_id = $owner RETURN count(r)`,
          { id: node.id, ...this.stamp('private') },
          context,
        );
      }
      result.privatePersons += 1;
    }

    const shared = allNodes(
      await this.read(`MATCH (n) WHERE n.layer IN ['reference', 'shared'] RETURN n`),
    );
    for (const node of shared) {
      const refs = sourceRefsOf(node.properties['source_refs']);
      if (!refs.some(carriesRecord)) continue;
      await this.recordSightings(node.id, refs.filter(carriesRecord), context);
      await this.apply(
        `MATCH (n {id: $id}) WHERE n.layer IN ['reference', 'shared'] SET n.source_refs = $sourceRefs RETURN n.id`,
        { id: node.id, sourceRefs: sharedRefs(refs, null) },
        context,
      );
      result.strippedRefs += 1;
    }

    const keyed = allNodes(
      await this.read(
        `MATCH (m:Meeting) WHERE m.layer = 'shared' AND m.ical_uid IS NOT NULL AND m.jamie_id IS NOT NULL RETURN m`,
      ),
    );
    for (const meeting of keyed) {
      const jamieId = stringOrNull(meeting.properties['jamie_id']);
      // Whether any principal's edge already carries the Jamie id: a count
      // across principals, which says nothing about whose edge it is.
      const carried = await this.read(
        'MATCH (:Person)-[r:ATTENDED {jamie_id: $v}]->(m:Meeting {id: $id}) RETURN count(r)',
        { v: jamieId, id: meeting.id },
      );
      if (Number(carried[0]?.[0] ?? 0) === 0) {
        const person = await this.findPrincipalPerson();
        const attendance = person === null ? null : await this.ownAttendance(person.id, meeting.id);
        if (person === null || attendance === null) {
          result.refused += 1;
          continue;
        }
        await this.foldAttendance(person.id, meeting.id, { jamie_id: jamieId }, context);
      }
      await this.apply(
        `MATCH (m:Meeting {id: $id}) WHERE m.ical_uid IS NOT NULL REMOVE m.jamie_id RETURN m.id`,
        { id: meeting.id },
        context,
      );
      result.meetingJamieIds += 1;
    }
  }

  /** True when another principal's private edge touches the node: a count, nothing more. */
  private async touchedByAnother(nodeId: string): Promise<boolean> {
    const rows = await this.read(
      `MATCH (n {id: $id})-[r]-() WHERE r.layer = 'private' AND r.principal_id <> $${SCOPE_PARAM} RETURN count(r)`,
      { id: nodeId },
    );
    return Number(rows[0]?.[0] ?? 0) > 0;
  }

  /**
   * Proves the graph is a function of the ledger (spec 5.2): empties it and
   * replays every principal's recorded mutations in ledger order. Nothing
   * is appended during a rebuild.
   */
  rebuild(): Promise<RebuildResult> {
    return rebuildGraph(this.db);
  }

  // Internals

  /** Runs a read with the scope's principal bound to `$principal`. */
  private read(
    query: string,
    params: CypherParams = {},
    columns?: readonly string[],
  ): Promise<unknown[][]> {
    return runCypher(this.runner, query, this.scoped(params), columns);
  }

  private scoped(params: CypherParams): CypherParams {
    if (SCOPE_PARAM in params) {
      throw new Error(
        `The "${SCOPE_PARAM}" Cypher parameter is reserved for the repository's scope; name the parameter differently.`,
      );
    }
    return { ...params, [SCOPE_PARAM]: this.scope.principalId };
  }

  /** The layer and owning principal a new node or edge is stamped with. */
  private stamp(layer: Layer): { layer: Layer; owner: string | null } {
    return { layer, owner: layer === 'private' ? this.scope.principalId : null };
  }

  private principalUpn(): Promise<string> {
    this.upn ??= this.db
      .select({ upn: principals.upn })
      .from(principals)
      .where(eq(principals.id, this.scope.principalId))
      .limit(1)
      .then((rows) => {
        const upn = rows[0]?.upn;
        if (upn === undefined) {
          throw new Error(
            `Principal ${this.scope.principalId} has no row in principals, so the ontology cannot find their Person node. Seed the principal before building the repository.`,
          );
        }
        return normaliseEmail(upn);
      });
    return this.upn;
  }

  /** The principal's Person node, created through resolution when it does not exist yet. */
  private async ensurePrincipalPerson(context: MutationContext): Promise<string> {
    const found = await this.findPrincipalPerson();
    if (found !== null) return found.id;
    const upn = await this.principalUpn();
    const resolved = await this.resolvePerson(
      {
        displayName: this.principalName ?? upn,
        emails: [upn],
        isInternal: true,
        sourceRef: { system: 'lance', id: 'principal', observedAt: this.now() },
      },
      context,
    );
    return resolved.id;
  }

  private async mutationCount(context: MutationContext): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.kind, 'resolved'),
          eq(ledgerEvents.correlationId, context.correlationId),
          sql`${ledgerEvents.payload} ->> 'kind' = ${MUTATION_KIND}`,
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Applies one recorded mutation: runs it and appends the `resolved`
   * event that makes it replayable. The Cypher text is fixed by the
   * calling method; only the parameters vary, and they always carry the
   * scope's principal, so the replay stamps the same one.
   */
  private async apply(
    cypher: string,
    params: CypherParams,
    context: MutationContext,
    options: ApplyOptions = {},
  ): Promise<void> {
    const bound = this.scoped(params);
    // One transaction: the graph write and the ledger event that makes it
    // replayable commit together, or neither does (spec 5.2). A caller's
    // transaction, when given, is that transaction.
    const run = async (tx: Tx): Promise<void> => {
      const runner = drizzleRunner(tx);
      await runner.query('SET LOCAL search_path = ag_catalog, "$user", public');
      await lockNodes(runner, options.locks ?? []);
      await runCypher(runner, cypher, bound);
      await this.writer.append(
        {
          ts: this.now(),
          actor: context.actor ?? ONTOLOGY_ACTOR,
          kind: 'resolved',
          sourceSystem: 'lance',
          correlationId: context.correlationId,
          payload: { kind: MUTATION_KIND, cypher, params: bound },
        },
        tx,
      );
    };
    await (options.tx === undefined ? this.db.transaction(run) : run(options.tx));
  }
}

interface MutationEvent {
  id: string;
  payload: unknown;
}

/** One principal's recorded mutations, read a page at a time in ledger id order. */
class MutationCursor {
  private page: MutationEvent[] = [];
  private index = 0;
  private after: string | null = null;
  private exhausted = false;

  constructor(
    private readonly db: Db,
    private readonly principalId: string,
  ) {}

  async head(): Promise<MutationEvent | null> {
    if (this.index < this.page.length) return this.page[this.index] ?? null;
    if (this.exhausted) return null;
    const conditions = [
      // Row-level security already limits the scoped handle to this
      // principal; naming it as well keeps the streams disjoint for a
      // role that bypasses RLS, such as a superuser running the rebuild.
      eq(ledgerEvents.principalId, this.principalId),
      eq(ledgerEvents.kind, 'resolved'),
      sql`${ledgerEvents.payload} ->> 'kind' = ${MUTATION_KIND}`,
    ];
    if (this.after !== null) conditions.push(gt(ledgerEvents.id, this.after));
    this.page = await this.db
      .select({ id: ledgerEvents.id, payload: ledgerEvents.payload })
      .from(ledgerEvents)
      .where(and(...conditions))
      .orderBy(asc(ledgerEvents.id))
      .limit(REBUILD_PAGE);
    this.index = 0;
    if (this.page.length < REBUILD_PAGE) this.exhausted = true;
    const last = this.page[this.page.length - 1];
    if (last !== undefined) this.after = last.id;
    return this.page[0] ?? null;
  }

  advance(): void {
    this.index += 1;
  }
}

/**
 * Empties the graph and replays every principal's recorded mutations in
 * global ledger id order (spec 5.2). The ledger is per principal (ADR
 * 0015), so each principal is read through its own scope over `db`'s
 * pool and the streams are merged by id: a shared node one principal's
 * event created can be linked by another's, and only the global order
 * replays that correctly. Any handle over the database will do; only its
 * pool is used.
 */
export async function rebuildGraph(db: Db): Promise<RebuildResult> {
  const runner = sqlRunnerOf(db);
  // Every principal, whatever their status: a shared node an offboarded
  // principal's evidence created is still part of the graph.
  const members = await db
    .select({ id: principals.id })
    .from(principals)
    .orderBy(asc(principals.id));
  const cursors = members.map(
    (member) => new MutationCursor(scopedDb(db, { principalId: member.id }), member.id),
  );
  await runCypher(runner, 'MATCH (n) DETACH DELETE n');
  let replayed = 0;
  for (;;) {
    let next: { cursor: MutationCursor; event: MutationEvent } | null = null;
    for (const cursor of cursors) {
      const event = await cursor.head();
      if (event !== null && (next === null || event.id < next.event.id)) next = { cursor, event };
    }
    if (next === null) break;
    const payload = next.event.payload as { cypher?: unknown; params?: unknown } | null;
    if (typeof payload?.cypher !== 'string') {
      // A mutation whose statement is gone (retention nulled the payload,
      // ADR 0011) cannot be replayed, and everything after it that matched
      // on its node would silently vanish too.
      throw new Error(
        `Ontology rebuild stopped at ledger event ${next.event.id}: its mutation payload is missing, so the graph can no longer be rebuilt from the ledger alone. Restore from the last graph backup or extend the ledger retention window.`,
      );
    }
    await runCypher(runner, payload.cypher, (payload.params as CypherParams | undefined) ?? {});
    replayed += 1;
    next.cursor.advance();
  }
  const nodes = await runCypher(runner, 'MATCH (n) RETURN count(n)');
  const edges = await runCypher(runner, 'MATCH ()-[r]->() RETURN count(r)');
  return { replayed, nodes: Number(nodes[0]?.[0] ?? 0), edges: Number(edges[0]?.[0] ?? 0) };
}

export { NODE_LABELS, EDGE_LABELS };
export type { EdgeLabel, NodeLabel };
