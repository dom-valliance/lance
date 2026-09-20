const ROTATE_SECRETS_RUNBOOK = 'docs/runbooks/rotate-secrets.md';

/**
 * Names of secrets Lance reads directly from the environment. Kept out of
 * `Config` (per CLAUDE.md: "Secrets never in the repo, never in container
 * env at build time" and this work package's brief): a secret is read once,
 * where it is used, never logged, and never threaded through the config
 * object that gets passed around and, in future, potentially serialised for
 * debugging.
 */
export type SecretName =
  | 'ANTHROPIC_API_KEY'
  | 'SLACK_BOT_TOKEN'
  | 'SLACK_SIGNING_SECRET'
  | 'NOTION_TOKEN'
  | 'JAMIE_API_KEY'
  | 'AGENT_LOG_INGEST_SECRET'
  | 'ENTRA_CLIENT_SECRET';

/**
 * Reads secret `name` from `env` (defaulting to `process.env`). Throws an
 * actionable error naming the variable and the rotation runbook when it is
 * missing or empty; the error never includes the secret's value.
 */
export function readSecret(name: SecretName, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required secret "${name}". Set it in the environment before starting the process. ` +
        `See ${ROTATE_SECRETS_RUNBOOK} for how to provision and rotate it.`,
    );
  }
  return value;
}
