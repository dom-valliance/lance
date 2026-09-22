import { ledgerEvents, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { newUlid, nowIso, type SourceSystem } from '@lance/shared';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import {
  drizzleRunner,
  isVertex,
  runCypher,
  sqlRunnerOf,
  type CypherParams,
  type SqlRunner,
  type Vertex,
} from './cypher.js';
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
 */

export const ONTOLOGY_ACTOR = 'system:ontology';
export const MUTATION_KIND = 'ontology_mutation';

export type NodeLabel =
  | 'Person'
  | 'Organisation'
  | 'Meeting'
  | 'Task'
  | 'Commitment'
  | 'Thread'
  | 'Document'
  | 'Project'
  | 'Agent';

export type EdgeLabel =
  | 'WORKS_AT'
  | 'ATTENDED'
  | 'ORGANISED'
  | 'MENTIONS'
  | 'ASSIGNED_TO'
  | 'OWES'
  | 'OWED_TO'
  | 'ABOUT'
  | 'DERIVED_FROM'
  | 'PARTICIPATED_IN'
  | 'RELATES_TO'
  | 'SAME_AS';

const NODE_LABELS: ReadonlySet<string> = new Set([
  'Person',
  'Organisation',
  'Meeting',
  'Task',
  'Commitment',
  'Thread',
  'Document',
  'Project',
  'Agent',
]);

const EDGE_LABELS: ReadonlySet<string> = new Set([
  'WORKS_AT',
  'ATTENDED',
  'ORGANISED',
  'MENTIONS',
  'ASSIGNED_TO',
  'OWES',
  'OWED_TO',
  'ABOUT',
  'DERIVED_FROM',
  'PARTICIPATED_IN',
  'RELATES_TO',
  'SAME_AS',
]);

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

export interface MeetingInput {
  title: string;
  start: string | null;
  end: string | null;
  jamieId?: string | null;
  graphEventId?: string | null;
  transcriptRef?: string | null;
  tags?: readonly string[];
  sourceRef: SourceRef;
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

export interface RepositoryOptions {
  now?: () => string;
  idFactory?: () => string;
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

export class OntologyRepository {
  private readonly runner: SqlRunner;
  private readonly writer: LedgerWriter;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly db: Db,
    options: RepositoryOptions = {},
  ) {
    this.runner = sqlRunnerOf(db);
    this.writer = new LedgerWriter(db);
    this.now = options.now ?? nowIso;
    this.newId = options.idFactory ?? newUlid;
  }

  // Reads

  async getNode(id: string): Promise<Node | null> {
    const rows = await runCypher(this.runner, 'MATCH (n {id: $id}) RETURN n', { id });
    const first = rows[0]?.[0];
    return isVertex(first) ? vertexToNode(first) : null;
  }

  async findPersonByEmail(email: string): Promise<Node | null> {
    const rows = await runCypher(
      this.runner,
      'MATCH (p:Person) WHERE $email IN p.emails RETURN p',
      { email: normaliseEmail(email) },
    );
    const first = rows[0]?.[0];
    return isVertex(first) ? vertexToNode(first) : null;
  }

  async findPersonByKey(key: 'slack_id' | 'notion_user_id', value: string): Promise<Node | null> {
    const query =
      key === 'slack_id'
        ? 'MATCH (p:Person {slack_id: $value}) RETURN p'
        : 'MATCH (p:Person {notion_user_id: $value}) RETURN p';
    const rows = await runCypher(this.runner, query, { value });
    const first = rows[0]?.[0];
    return isVertex(first) ? vertexToNode(first) : null;
  }

  async findPersonByJamieParticipantId(participantId: string): Promise<Node | null> {
    const rows = await runCypher(
      this.runner,
      'MATCH (p:Person) WHERE $pid IN p.jamie_participant_ids RETURN p',
      { pid: participantId },
    );
    const first = rows[0]?.[0];
    return isVertex(first) ? vertexToNode(first) : null;
  }

  async findPersonsByNormalisedName(normalised: string): Promise<Node[]> {
    const rows = await runCypher(
      this.runner,
      'MATCH (p:Person {normalised_name: $name}) RETURN p',
      { name: normalised },
    );
    return rows
      .map((row) => row[0])
      .filter(isVertex)
      .map(vertexToNode);
  }

  /** Every person with an email at `domain`: the people of one organisation, whether or not a `WORKS_AT` edge exists yet. */
  async findPersonsByEmailDomain(domain: string): Promise<Node[]> {
    const rows = await runCypher(
      this.runner,
      'MATCH (p:Person) UNWIND p.emails AS e WITH p, e WHERE e ENDS WITH $suffix RETURN p',
      { suffix: `@${domain.toLowerCase()}` },
    );
    // A person with two addresses at the domain comes back twice from UNWIND.
    const byId = new Map<string, Node>();
    for (const row of rows) {
      const vertex = row[0];
      if (!isVertex(vertex)) continue;
      const node = vertexToNode(vertex);
      byId.set(node.id, node);
    }
    return [...byId.values()];
  }

  async findOrganisationByDomain(domain: string): Promise<Node | null> {
    const rows = await runCypher(
      this.runner,
      'MATCH (o:Organisation) WHERE $domain IN o.domains RETURN o',
      { domain: domain.toLowerCase() },
    );
    const first = rows[0]?.[0];
    return isVertex(first) ? vertexToNode(first) : null;
  }

  async findMeeting(keys: {
    jamieId?: string | null;
    graphEventId?: string | null;
  }): Promise<Node | null> {
    if (keys.jamieId) {
      const rows = await runCypher(this.runner, 'MATCH (m:Meeting {jamie_id: $v}) RETURN m', {
        v: keys.jamieId,
      });
      const first = rows[0]?.[0];
      if (isVertex(first)) return vertexToNode(first);
    }
    if (keys.graphEventId) {
      const rows = await runCypher(this.runner, 'MATCH (m:Meeting {graph_event_id: $v}) RETURN m', {
        v: keys.graphEventId,
      });
      const first = rows[0]?.[0];
      if (isVertex(first)) return vertexToNode(first);
    }
    return null;
  }

  async findTask(source: TaskInput['source'], sourceId: string): Promise<Node | null> {
    const rows = await runCypher(
      this.runner,
      'MATCH (t:Task {source: $source, source_id: $sourceId}) RETURN t',
      { source, sourceId },
    );
    const first = rows[0]?.[0];
    return isVertex(first) ? vertexToNode(first) : null;
  }

  /** Nodes one edge away, with the edge label, optionally restricted to one label. */
  async neighbours(id: string, edge?: EdgeLabel): Promise<{ edge: string; node: Node }[]> {
    if (edge !== undefined) assertLabel(edge, EDGE_LABELS, 'edge');
    const pattern = edge === undefined ? '[r]' : `[r:${edge}]`;
    const rows = await runCypher(
      this.runner,
      `MATCH (a {id: $id})-${pattern}-(b) RETURN label(r), b`,
      { id },
      ['edge', 'node'],
    );
    return rows.flatMap(([label, vertex]) =>
      isVertex(vertex) ? [{ edge: String(label), node: vertexToNode(vertex) }] : [],
    );
  }

  /** True when two people are both recorded as attending the same meeting (spec 5.3 rule 3). */
  async coAttended(personA: string, personB: string): Promise<boolean> {
    const rows = await runCypher(
      this.runner,
      'MATCH (a:Person {id: $a})-[:ATTENDED]->(m:Meeting)<-[:ATTENDED]-(b:Person {id: $b}) RETURN count(m)',
      { a: personA, b: personB },
    );
    return Number(rows[0]?.[0] ?? 0) > 0;
  }

  /** Case-insensitive substring search over the naming property of every label. */
  async search(text: string, limit = 20): Promise<Node[]> {
    const needle = text.toLowerCase();
    // AGE takes no parameter in LIMIT, so the bound is checked and inlined.
    const bound = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 20;
    const rows = await runCypher(
      this.runner,
      `MATCH (n) WHERE toLower(coalesce(n.display_name, n.name, n.title, "")) CONTAINS $needle RETURN n LIMIT ${String(bound)}`,
      { needle },
    );
    return rows
      .map((row) => row[0])
      .filter(isVertex)
      .map(vertexToNode);
  }

  async counts(): Promise<{ nodes: number; edges: number }> {
    const nodes = await runCypher(this.runner, 'MATCH (n) RETURN count(n)');
    const edges = await runCypher(this.runner, 'MATCH ()-[r]->() RETURN count(r)');
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
        'CREATE (p:Person {id: $id, display_name: $displayName, normalised_name: $normalisedName, emails: $emails, slack_id: $slackId, notion_user_id: $notionUserId, jamie_participant_ids: $jamieIds, org_id: $orgId, role: $role, is_internal: $isInternal, confidence: $confidence, source_refs: $sourceRefs, created_at: $ts, updated_at: $ts}) RETURN p.id',
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
          ts,
        },
        context,
      );
      return { id, created: true };
    }
    const props = existing.properties;
    await this.apply(
      'MATCH (p:Person {id: $id}) SET p.emails = $emails, p.slack_id = $slackId, p.notion_user_id = $notionUserId, p.jamie_participant_ids = $jamieIds, p.org_id = $orgId, p.role = $role, p.is_internal = $isInternal, p.source_refs = $sourceRefs, p.updated_at = $ts RETURN p.id',
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
    const rows = await runCypher(
      this.runner,
      'MATCH (p:Person {id: $p})-[:ATTENDED]->(m:Meeting {id: $m}) RETURN count(m)',
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
        'CREATE (o:Organisation {id: $id, name: $name, normalised_name: $normalisedName, domains: $domains, type: $type, confidence: $confidence, source_refs: $sourceRefs, created_at: $ts, updated_at: $ts}) RETURN o.id',
        {
          id,
          name: input.name,
          normalisedName: normaliseName(input.name),
          domains,
          type: input.type ?? 'unknown',
          confidence: input.confidence ?? 1,
          sourceRefs: [input.sourceRef],
          ts,
        },
        context,
      );
      return { id, created: true };
    }
    await this.apply(
      'MATCH (o:Organisation {id: $id}) SET o.domains = $domains, o.type = $type, o.source_refs = $sourceRefs, o.updated_at = $ts RETURN o.id',
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

  async upsertMeeting(input: MeetingInput, context: MutationContext): Promise<UpsertResult> {
    const existing = await this.findMeeting({
      jamieId: input.jamieId ?? null,
      graphEventId: input.graphEventId ?? null,
    });
    const ts = this.now();
    if (existing === null) {
      const id = this.newId();
      await this.apply(
        'CREATE (m:Meeting {id: $id, title: $title, start: $start, end_at: $end, jamie_id: $jamieId, graph_event_id: $graphEventId, transcript_ref: $transcriptRef, tags: $tags, confidence: 1, source_refs: $sourceRefs, created_at: $ts, updated_at: $ts}) RETURN m.id',
        {
          id,
          title: input.title,
          start: input.start,
          end: input.end,
          jamieId: input.jamieId ?? null,
          graphEventId: input.graphEventId ?? null,
          transcriptRef: input.transcriptRef ?? null,
          tags: uniqueStrings(input.tags ?? []),
          sourceRefs: [input.sourceRef],
          ts,
        },
        context,
      );
      return { id, created: true };
    }
    await this.apply(
      'MATCH (m:Meeting {id: $id}) SET m.title = $title, m.start = $start, m.end_at = $end, m.jamie_id = $jamieId, m.graph_event_id = $graphEventId, m.transcript_ref = $transcriptRef, m.tags = $tags, m.source_refs = $sourceRefs, m.updated_at = $ts RETURN m.id',
      {
        id: existing.id,
        title: input.title,
        start: input.start ?? existing.properties['start'] ?? null,
        end: input.end ?? existing.properties['end_at'] ?? existing.properties['end'] ?? null,
        jamieId: input.jamieId ?? existing.properties['jamie_id'] ?? null,
        graphEventId: input.graphEventId ?? existing.properties['graph_event_id'] ?? null,
        transcriptRef: input.transcriptRef ?? existing.properties['transcript_ref'] ?? null,
        tags: uniqueStrings([
          ...((existing.properties['tags'] as string[] | undefined) ?? []),
          ...(input.tags ?? []),
        ]),
        sourceRefs: mergeSourceRefs(existing.properties['source_refs'], input.sourceRef),
        ts,
      },
      context,
    );
    return { id: existing.id, created: false };
  }

  async upsertTask(input: TaskInput, context: MutationContext): Promise<UpsertResult> {
    const existing = await this.findTask(input.source, input.sourceId);
    const ts = this.now();
    if (existing === null) {
      const id = this.newId();
      await this.apply(
        'CREATE (t:Task {id: $id, title: $title, status: $status, due: $due, source: $source, source_id: $sourceId, assignee_id: $assigneeId, confidence: 1, source_refs: $sourceRefs, created_at: $ts, updated_at: $ts}) RETURN t.id',
        {
          id,
          title: input.title,
          status: input.status,
          due: input.due,
          source: input.source,
          sourceId: input.sourceId,
          assigneeId: input.assigneeId ?? null,
          sourceRefs: [input.sourceRef],
          ts,
        },
        context,
      );
      return { id, created: true };
    }
    await this.apply(
      'MATCH (t:Task {id: $id}) SET t.title = $title, t.status = $status, t.due = $due, t.assignee_id = $assigneeId, t.source_refs = $sourceRefs, t.updated_at = $ts RETURN t.id',
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

  /** The graph side of a `commitments` row: same id, relationships only (spec 5.2). */
  async ensureCommitment(commitmentId: string, context: MutationContext): Promise<UpsertResult> {
    const existing = await this.getNode(commitmentId);
    if (existing !== null) return { id: commitmentId, created: false };
    const ts = this.now();
    await this.apply(
      'CREATE (c:Commitment {id: $id, confidence: 1, source_refs: [], created_at: $ts, updated_at: $ts}) RETURN c.id',
      { id: commitmentId, ts },
      context,
    );
    return { id: commitmentId, created: true };
  }

  async upsertProject(input: ProjectInput, context: MutationContext): Promise<UpsertResult> {
    const rows = input.notionPageId
      ? await runCypher(this.runner, 'MATCH (p:Project {notion_page_id: $v}) RETURN p', {
          v: input.notionPageId,
        })
      : await runCypher(this.runner, 'MATCH (p:Project {normalised_name: $v}) RETURN p', {
          v: normaliseName(input.name),
        });
    const first = rows[0]?.[0];
    const existing = isVertex(first) ? vertexToNode(first) : null;
    const ts = this.now();
    if (existing === null) {
      const id = this.newId();
      await this.apply(
        'CREATE (p:Project {id: $id, name: $name, normalised_name: $normalisedName, notion_page_id: $notionPageId, client_org_id: $clientOrgId, status: $status, aliases: $aliases, confidence: 1, source_refs: $sourceRefs, created_at: $ts, updated_at: $ts}) RETURN p.id',
        {
          id,
          name: input.name,
          normalisedName: normaliseName(input.name),
          notionPageId: input.notionPageId ?? null,
          clientOrgId: input.clientOrgId ?? null,
          status: input.status ?? null,
          aliases: uniqueStrings(input.aliases ?? []),
          sourceRefs: [input.sourceRef],
          ts,
        },
        context,
      );
      return { id, created: true };
    }
    await this.apply(
      'MATCH (p:Project {id: $id}) SET p.name = $name, p.client_org_id = $clientOrgId, p.status = $status, p.aliases = $aliases, p.source_refs = $sourceRefs, p.updated_at = $ts RETURN p.id',
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
   * confidence, status, role, since and updated_at. Anything else belongs
   * on a node.
   */
  async link(
    fromId: string,
    edge: EdgeLabel,
    toId: string,
    properties: EdgeProperties = {},
    context: MutationContext,
  ): Promise<void> {
    assertLabel(edge, EDGE_LABELS, 'edge');
    await this.apply(
      `MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:${edge}]->(b) SET r.confidence = $confidence, r.status = $status, r.role = $role, r.since = $since, r.updated_at = $ts RETURN r`,
      {
        from: fromId,
        to: toId,
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
      'MATCH (a {id: $from})-[r:SAME_AS]-(b {id: $to}) SET r.status = $status, r.decided_at = $ts RETURN r',
      { from: fromId, to: toId, status, ts: this.now() },
      context,
    );
  }

  /**
   * Applies one recorded mutation: runs it and appends the `resolved`
   * event that makes it replayable. The Cypher text is fixed by the
   * calling method; only the parameters vary.
   */
  private async apply(
    cypher: string,
    params: CypherParams,
    context: MutationContext,
  ): Promise<void> {
    // One transaction: the graph write and the ledger event that makes it
    // replayable commit together, or neither does (spec 5.2).
    await this.db.transaction(async (tx) => {
      const runner = drizzleRunner(tx);
      await runner.query('SET LOCAL search_path = ag_catalog, "$user", public');
      await runCypher(runner, cypher, params);
      await this.writer.append(
        {
          ts: this.now(),
          actor: context.actor ?? ONTOLOGY_ACTOR,
          kind: 'resolved',
          sourceSystem: 'lance',
          correlationId: context.correlationId,
          payload: { kind: MUTATION_KIND, cypher, params },
        },
        tx,
      );
    });
  }

  /**
   * Proves the graph is a function of the ledger (spec 5.2): empties it and
   * replays every recorded mutation in ledger order. Nothing is appended
   * during a rebuild.
   */
  async rebuild(): Promise<RebuildResult> {
    await runCypher(this.runner, 'MATCH (n) DETACH DELETE n');
    let replayed = 0;
    let after: string | null = null;
    for (;;) {
      const page = await this.db
        .select({ id: ledgerEvents.id, payload: ledgerEvents.payload })
        .from(ledgerEvents)
        .where(
          after === null
            ? and(
                eq(ledgerEvents.kind, 'resolved'),
                sql`${ledgerEvents.payload} ->> 'kind' = ${MUTATION_KIND}`,
              )
            : and(
                eq(ledgerEvents.kind, 'resolved'),
                sql`${ledgerEvents.payload} ->> 'kind' = ${MUTATION_KIND}`,
                gt(ledgerEvents.id, after),
              ),
        )
        .orderBy(asc(ledgerEvents.id))
        .limit(500);
      if (page.length === 0) break;
      for (const event of page) {
        const payload = event.payload as { cypher?: unknown; params?: unknown } | null;
        if (typeof payload?.cypher !== 'string') {
          // A mutation whose statement is gone (retention nulled the
          // payload, ADR 0011) cannot be replayed, and everything after it
          // that matched on its node would silently vanish too.
          throw new Error(
            `Ontology rebuild stopped at ledger event ${event.id}: its mutation payload is missing, so the graph can no longer be rebuilt from the ledger alone. Restore from the last graph backup or extend the ledger retention window.`,
          );
        }
        await runCypher(
          this.runner,
          payload.cypher,
          (payload.params as CypherParams | undefined) ?? {},
        );
        replayed += 1;
      }
      after = page[page.length - 1]?.id ?? null;
      if (page.length < 500) break;
    }
    const counts = await this.counts();
    return { replayed, ...counts };
  }
}

export { NODE_LABELS, EDGE_LABELS };
