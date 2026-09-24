/**
 * Alerts are raised through `@lance/ledger` so the api, which raises
 * `foreign_decision_attempt` (ADR 0023), and the worker share one
 * implementation of the dedupe and reopen rules.
 */
export { raiseAlert } from '@lance/ledger';
export type { RaiseAlertInput, RaiseAlertResult } from '@lance/ledger';
