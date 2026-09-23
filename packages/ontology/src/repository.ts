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
  /** Meetings left without an iCalUId because another Meeting already holds it. */
  meetingKeyConflicts: number;
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
    const ts = this.now();
    if (existing === null) {
      const id = this.newId();
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
          sourceRefs: [input.sourceRef],
          ...this.stamp(nodeLayer('Person')),
          ts,
        },
        context,
      );
      return { id, created: true };
    }
    const props = existing.properties;
    await this.apply(
      `MATCH (p:Person {id: $id}) WHERE ${visible('p')} SET p.emails = $emails, p.slack_id = $slackId, p.notion_user_id = $notionUserId, p.jamie_participant_ids = $jamieIds, p.org_id = $orgId, p.role = $role, p.is_internal = $isInternal, p.source_refs = $sourceRefs, p.updated_at = $ts RETURN p.id`,
      {
        id: existing.id,
        emails: uniqueStrings([...((props['emails'] as string[] | undefined) ?? []), ...emails]),
        slackId: input.slackId ?? props['slack_id'] ?? null,
        notionUserId: input.notionUserId ?? props['notion_user_id'] ?? null,
        jamieIds: uniqueStrings([
          ...((props['jamie_participant_ids'] as string[] | undefined) ?? []),
          ...(input.jamieParticipantIds ?? []),
        ]),
        orgId: input.orgId ?? props['org_id'] ?? null,
        role: input.role ?? props['role'] ?? null,
        isInternal: input.isInternal ?? props['is_internal'] ?? false,
        sourceRefs: mergeSourceRefs(props['source_refs'], input.sourceRef),
        ts,
      },
      context,
    );
    return { id: existing.id, created: false };
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
   */
  async resolvePerson(input: PersonInput, context: MutationContext): Promise<ResolvePersonResult> {
    const emails = uniqueStrings((input.emails ?? []).map(normaliseEmail));
    const exact = await this.findExistingPerson(input, emails);
    if (exact !== null) {
      await this.upsertPerson(input, context);
      return { id: exact.id, decision: 'exact', matchedId: exact.id, score: 1 };
    }
    const domain = emails.map(organisationDomain).find((d) => d !== null) ?? null;
    const organisation = input.orgId ?? domain;
    const candidates = await this.findPersonsByNormalisedName(normaliseName(input.displayName));
    let best: { node: Node; score: number } | null = null;
    for (const node of candidates) {
      const theirDomain = ((node.properties['emails'] as string[] | undefined) ?? [])
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
      const created = await this.upsertPerson(input, context);
      return { id: created.id, decision: 'none', matchedId: null, score: null };
    }
    let decision = decide(best.score);
    const barred = await this.wouldViolateRuleThree(input, best.node.id);
    if (decision === 'merge' && barred) decision = 'candidate';
    // A sighting with no identifier at all (a name in a transcript, no
    // address) has nothing that could ever distinguish it from the person
    // of that name already known, so a candidate-grade match reuses that
    // node rather than minting one per meeting.
    const hasKey =
      emails.length > 0 ||
      Boolean(input.notionUserId) ||
      Boolean(input.slackId) ||
      (input.jamieParticipantIds?.length ?? 0) > 0;
    if (decision === 'candidate' && !hasKey && !barred) decision = 'merge';
    if (decision === 'merge') {
      await this.upsertPerson(
        {
          ...input,
          emails: [...emails, ...((best.node.properties['emails'] as string[] | undefined) ?? [])],
        },
        context,
      );
      return { id: best.node.id, decision, matchedId: best.node.id, score: best.score };
    }
    const created = await this.upsertPerson(input, context);
    if (decision === 'candidate') {
      await this.link(
        created.id,
        'SAME_AS',
        best.node.id,
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
          sourceRefs: [input.sourceRef],
          ...this.stamp(nodeLayer('Organisation')),
          ts,
        },
        context,
      );
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
        sourceRefs: mergeSourceRefs(existing.properties['source_refs'], input.sourceRef),
        ts,
      },
      context,
    );
    return { id: existing.id, created: false };
  }

  /**
   * One shared Meeting node per iCalUId, or per Jamie id when no calendar
   * event matched. The node carries the facts every attendee shares; the
   * observing principal's context goes on their own `ATTENDED` edge.
   */
  async upsertMeeting(input: MeetingInput, context: MutationContext): Promise<UpsertResult> {
    const icalUid = input.icalUid ?? null;
    const existing = await this.findMeeting({
      icalUid,
      jamieId: input.jamieId ?? null,
      graphEventId: input.graphEventId ?? null,
    });
    const ts = this.now();
    let result: UpsertResult;
    if (existing === null) {
      const id = this.newId();
      await this.apply(
        'CREATE (m:Meeting {id: $id, title: $title, start: $start, end_at: $end, ical_uid: $icalUid, jamie_id: $jamieId, confidence: 1, source_refs: [], layer: $layer, principal_id: $owner, created_at: $ts, updated_at: $ts}) RETURN m.id',
        {
          id,
          title: input.title,
          start: input.start,
          end: input.end,
          icalUid,
          // The Jamie id keys the node only when no calendar event did.
          jamieId: icalUid === null ? (input.jamieId ?? null) : null,
          ...this.stamp(nodeLayer('Meeting')),
          ts,
        },
        context,
      );
      result = { id, created: true };
    } else {
      await this.apply(
        `MATCH (m:Meeting {id: $id}) WHERE ${visible('m')} SET m.title = $title, m.start = $start, m.end_at = $end, m.ical_uid = $icalUid, m.updated_at = $ts RETURN m.id`,
        {
          id: existing.id,
          title: input.title,
          start: input.start ?? existing.properties['start'] ?? null,
          end: input.end ?? existing.properties['end_at'] ?? existing.properties['end'] ?? null,
          icalUid: stringOrNull(existing.properties['ical_uid']) ?? icalUid,
          ts,
        },
        context,
      );
      result = { id: existing.id, created: false };
    }
    await this.recordMeetingContext(result.id, input, context);
    return result;
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
    );
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
          sourceRefs: [input.sourceRef],
          ...this.stamp(nodeLayer('Task', input.source)),
          ts,
        },
        context,
      );
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
        sourceRefs: mergeSourceRefs(existing.properties['source_refs'], input.sourceRef),
        ts,
      },
      context,
    );
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
          sourceRefs: [input.sourceRef],
          ...this.stamp(nodeLayer('Project')),
          ts,
        },
        context,
      );
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
        sourceRefs: mergeSourceRefs(existing.properties['source_refs'], input.sourceRef),
        ts,
      },
      context,
    );
    return { id: existing.id, created: false };
  }

  /**
   * MERGE one edge between two nodes by id; repeating it changes nothing
   * but the properties. AGE will not SET a whole map from a parameter, so
   * the edge carries a fixed set of properties, each assigned by name:
   * layer, confidence, status, role, since and updated_at. Anything else
   * belongs on a node. A private edge is merged on the scope's principal,
   * so another principal's edge between the same two nodes is never
   * touched. Both ends must be visible to the scope.
   */
  async link(
    fromId: string,
    edge: EdgeLabel,
    toId: string,
    properties: EdgeProperties = {},
    context: MutationContext,
  ): Promise<void> {
    assertLabel(edge, EDGE_LABELS, 'edge');
    const layer = edgeLayer(edge);
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
   * which holds while the graph has known only one principal (Phase 4).
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
      mutations: 0,
    };
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
      result.mutations += 1;
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
      const before = await this.mutationCount(context);
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
      result.mutations += (await this.mutationCount(context)) - before;
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
        result.meetingKeyConflicts += 1;
        continue;
      }
      await this.apply(
        'MATCH (m:Meeting {id: $id}) WHERE m.ical_uid IS NULL SET m.ical_uid = $icalUid, m.updated_at = $ts RETURN m.id',
        { id: meetingId, icalUid, ts: this.now() },
        context,
      );
      result.meetingKeys += 1;
      result.mutations += 1;
    }
    return result;
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
  ): Promise<void> {
    const bound = this.scoped(params);
    // One transaction: the graph write and the ledger event that makes it
    // replayable commit together, or neither does (spec 5.2).
    await this.db.transaction(async (tx) => {
      const runner = drizzleRunner(tx);
      await runner.query('SET LOCAL search_path = ag_catalog, "$user", public');
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
    });
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
