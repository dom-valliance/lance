export const PACKAGE_NAME = '@lance/ontology';

export { GRAPH_NAME, parseAgtype, runCypher, sqlRunnerOf } from './cypher.js';
export type { CypherParams, Edge, SqlRunner, Vertex } from './cypher.js';
export {
  AUTO_MERGE_THRESHOLD,
  CANDIDATE_THRESHOLD,
  PUBLIC_EMAIL_PROVIDERS,
  decide,
  jaroWinkler,
  nameOrganisationScore,
  normaliseEmail,
  normaliseName,
  organisationDomain,
} from './resolution.js';
export type { NamedParty, ResolutionDecision } from './resolution.js';
export {
  EDGE_LABELS,
  MUTATION_KIND,
  NODE_LABELS,
  ONTOLOGY_ACTOR,
  OntologyRepository,
} from './repository.js';
export type {
  EdgeLabel,
  EdgeProperties,
  MeetingInput,
  MutationContext,
  Node,
  NodeLabel,
  OrganisationInput,
  PersonInput,
  ProjectInput,
  RebuildResult,
  ResolvePersonResult,
  SourceRef,
  TaskInput,
  UpsertResult,
} from './repository.js';
