export const PACKAGE_NAME = '@lance/ontology';

// runCypher, sqlRunnerOf and drizzleRunner stay inside this package: every
// graph read and write goes through OntologyRepository, which is where the
// principal scope is enforced (ADR 0017). The root ESLint config forbids
// importing them from anywhere else.
export { GRAPH_NAME, parseAgtype } from './cypher.js';
export type { CypherParams, Edge, Vertex } from './cypher.js';
export {
  EDGE_LABEL_VALUES,
  LAYER_VALUES,
  NODE_LABEL_VALUES,
  ONTOLOGY_LAYERS,
  edgeLayer,
  edgeLayerBetween,
  nodeLayer,
} from './layers.js';
export type { Layer } from './layers.js';
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
  BackfillOptions,
  BackfillResult,
  EdgeLabel,
  EdgeProperties,
  MeetingContext,
  MeetingInput,
  MutationContext,
  Node,
  NodeLabel,
  OrganisationInput,
  PersonInput,
  PrincipalScope,
  ProjectInput,
  RebuildResult,
  RepositoryOptions,
  ResolvePersonResult,
  SourceRef,
  TaskInput,
  ThreadInput,
  UpsertResult,
} from './repository.js';
